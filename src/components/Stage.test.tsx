import { open } from "@tauri-apps/plugin-dialog";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
// jsdom loads no images; dropped ones measure as 1200×800.
vi.mock("../lib/drop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/drop")>()),
  imageSize: vi.fn(async () => ({ w: 1200, h: 800 })),
}));

import { invoke } from "@tauri-apps/api/core";

import { claimDrop, dropCovered } from "../lib/drop";
import { DEFAULT_EDIT_STYLES } from "../lib/editTools";
import { flushReviewSave, SKETCH_TARGET_ATTR, useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { Stage } from "./Stage";

// Drawing schedules a save of the review marks; finish it here, not in the next test.
afterEach(() => flushReviewSave());

beforeEach(() => {
  useApp.setState({
    deck: deckFor(DECK_HTML),
    selected: "intro",
    presenting: false,
    sketches: {},
    reviewVisible: true,
    view: "slides",
    editing: false,
    slideMode: "view",
  });
});

const position = () => screen.getByText(/^\d+ \/ \d+$/).textContent;
const prev = () => screen.getByRole("button", { name: "Previous slide" });
const next = () => screen.getByRole("button", { name: "Next slide" });

describe("Stage", () => {
  it("shows the position of the selected slide", () => {
    render(<Stage />);
    expect(position()).toBe("1 / 3");
    act(() => useApp.getState().select("outro"));
    expect(position()).toBe("3 / 3");
  });

  it("disables the arrows at either end", () => {
    render(<Stage />);
    expect((prev() as HTMLButtonElement).disabled).toBe(true);
    expect((next() as HTMLButtonElement).disabled).toBe(false);
    act(() => useApp.getState().select("outro"));
    expect((prev() as HTMLButtonElement).disabled).toBe(false);
    expect((next() as HTMLButtonElement).disabled).toBe(true);
  });

  it("moves between slides with the arrow buttons", () => {
    render(<Stage />);
    fireEvent.click(next());
    expect(useApp.getState().selected).toBe("#2");
    fireEvent.click(prev());
    expect(useApp.getState().selected).toBe("intro");
  });

  it("invites a conversation when the deck is empty", () => {
    useApp.setState({ deck: { ...deckFor(DECK_HTML), slides: [] }, selected: null });
    render(<Stage />);
    expect(screen.getByText("Start with a conversation")).toBeTruthy();
    expect(screen.queryByText(/\d+ \/ \d+/)).toBeNull();
  });

  it("opens the template layouts to change the slide's layout", () => {
    useApp.setState({
      templates: [{ id: "swiss", title: "Swiss Design", builtin: true, path: null, slides: ["title", "quote"] }],
      running: false,
    });
    render(<Stage />);
    const button = screen.getByRole("button", { name: /^Layout$/ });
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Change layout" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Quote layout" })).toBeTruthy();
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useApp.setState({ running: true }));
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders nothing without a deck", () => {
    useApp.setState({ deck: null });
    const { container } = render(<Stage />);
    expect(container.innerHTML).toBe("");
  });

  describe("keyboard", () => {
    it.each([
      ["ArrowDown", "#2"],
      ["ArrowRight", "#2"],
      ["PageDown", "#2"],
    ])("%s goes to the next slide", (key, expected) => {
      render(<Stage />);
      const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
      act(() => void document.body.dispatchEvent(event));
      expect(useApp.getState().selected).toBe(expected);
      expect(event.defaultPrevented).toBe(true);
    });

    it.each([["ArrowUp"], ["ArrowLeft"], ["PageUp"]])("%s goes to the previous slide", (key) => {
      useApp.setState({ selected: "outro" });
      render(<Stage />);
      act(() => void fireEvent.keyDown(document.body, { key }));
      expect(useApp.getState().selected).toBe("#2");
    });

    it("leaves other keys alone", () => {
      render(<Stage />);
      const event = new KeyboardEvent("keydown", { key: "a", cancelable: true, bubbles: true });
      document.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(useApp.getState().selected).toBe("intro");
    });

    it("does not navigate while typing", () => {
      render(
        <>
          <Stage />
          <input data-testid="input" />
          <textarea data-testid="textarea" />
          <div data-testid="editable" contentEditable />
        </>,
      );
      for (const id of ["input", "textarea", "editable"]) {
        fireEvent.keyDown(screen.getByTestId(id), { key: "ArrowDown" });
      }
      expect(useApp.getState().selected).toBe("intro");
    });

    it("does not navigate while presenting", () => {
      useApp.setState({ presenting: true });
      render(<Stage />);
      fireEvent.keyDown(document.body, { key: "ArrowDown" });
      expect(useApp.getState().selected).toBe("intro");
    });

    it("stops listening when unmounted", () => {
      const { unmount } = render(<Stage />);
      unmount();
      fireEvent.keyDown(document.body, { key: "ArrowDown" });
      expect(useApp.getState().selected).toBe("intro");
    });
  });

  describe("copying and pasting slides", () => {
    beforeEach(() => {
      vi.mocked(invoke).mockReset();
      useApp.setState({ editing: false, error: null });
    });

    it("copies the selected slide with ⌘C and pastes one after it with ⌘V", async () => {
      const deck = useApp.getState().deck!;
      const pasted = {
        ...deck,
        slides: [deck.slides[0]!, { ...deck.slides[0]!, id: "pasted" }, ...deck.slides.slice(1)],
      };
      vi.mocked(invoke).mockImplementation(async (command) =>
        command === "paste_slide" ? { deck: pasted, slide: "pasted" } : undefined,
      );
      render(<Stage />);
      const copy = new KeyboardEvent("keydown", { key: "c", metaKey: true, cancelable: true, bubbles: true });
      act(() => void document.body.dispatchEvent(copy));
      expect(copy.defaultPrevented).toBe(true);
      expect(invoke).toHaveBeenCalledWith("copy_slide", { id: deck.id, slide: "intro" });
      await act(async () => void fireEvent.keyDown(document.body, { key: "v", ctrlKey: true }));
      expect(invoke).toHaveBeenCalledWith("paste_slide", { id: deck.id, after: "intro" });
      expect(useApp.getState().selected).toBe("pasted");
      expect(useApp.getState().deck?.slides.map((s) => s.id)).toEqual(["intro", "pasted", "#2", "outro"]);
    });

    it("takes ⌘C / ⌘V forwarded by a slide preview", async () => {
      render(<Stage />);
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);
      const send = (key: string) =>
        act(
          () =>
            void window.dispatchEvent(
              new MessageEvent("message", { data: { type: "slop:key", key, mod: true }, source: frame.contentWindow }),
            ),
        );
      send("c");
      send("v");
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("paste_slide", expect.anything()));
      expect(invoke).toHaveBeenCalledWith("copy_slide", expect.anything());
      frame.remove();
    });

    it("leaves a clipboard without a slide alone and reports failures", async () => {
      vi.mocked(invoke).mockResolvedValue(null);
      render(<Stage />);
      const before = useApp.getState().deck;
      await act(async () => void fireEvent.keyDown(document.body, { key: "v", metaKey: true }));
      expect(useApp.getState().deck).toBe(before);
      expect(useApp.getState().selected).toBe("intro");
      vi.mocked(invoke).mockRejectedValue("could not copy");
      await act(async () => void fireEvent.keyDown(document.body, { key: "c", metaKey: true }));
      await waitFor(() => expect(useApp.getState().error).toBe("could not copy"));
    });

    it("leaves the keys to typing, selected text, presenting and ⌘⇧V", () => {
      render(
        <>
          <Stage />
          <textarea data-testid="composer" />
        </>,
      );
      fireEvent.keyDown(screen.getByTestId("composer"), { key: "c", metaKey: true });
      fireEvent.keyDown(document.body, { key: "v", metaKey: true, shiftKey: true });
      const text = document.createElement("p");
      text.textContent = "Chat text";
      document.body.appendChild(text);
      window.getSelection()!.selectAllChildren(text);
      fireEvent.keyDown(document.body, { key: "c", metaKey: true });
      window.getSelection()!.removeAllRanges();
      text.remove();
      act(() => useApp.setState({ presenting: true }));
      fireEvent.keyDown(document.body, { key: "v", metaKey: true });
      expect(invoke).not.toHaveBeenCalledWith("copy_slide", expect.anything());
      expect(invoke).not.toHaveBeenCalledWith("paste_slide", expect.anything());
    });
  });

  describe("slide rail keys", () => {
    const actions = {
      undoDeckEdit: vi.fn(async () => {}),
      redoDeckEdit: vi.fn(async () => {}),
      moveSlides: vi.fn(async () => {}),
      deleteSlides: vi.fn(async () => {}),
    };
    const real = useApp.getState();
    beforeEach(() => {
      for (const action of Object.values(actions)) action.mockClear();
      useApp.setState({ ...actions, railSelected: [] });
    });
    afterEach(() => {
      const { undoDeckEdit, redoDeckEdit, moveSlides, deleteSlides } = real;
      useApp.setState({ undoDeckEdit, redoDeckEdit, moveSlides, deleteSlides, railSelected: [] });
    });

    it("undoes and redoes rail changes outside edit mode", () => {
      render(<Stage />);
      fireEvent.keyDown(document.body, { key: "z", metaKey: true });
      expect(actions.undoDeckEdit).toHaveBeenCalledOnce();
      fireEvent.keyDown(document.body, { key: "Z", metaKey: true, shiftKey: true });
      fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
      expect(actions.redoDeckEdit).toHaveBeenCalledTimes(2);
    });

    it("leaves ⌘Z to the slide's own history in edit mode, and to text fields", () => {
      render(
        <>
          <Stage />
          <textarea data-testid="composer" />
        </>,
      );
      fireEvent.keyDown(screen.getByTestId("composer"), { key: "z", metaKey: true });
      act(() => useApp.getState().setEditing(true));
      fireEvent.keyDown(document.body, { key: "z", metaKey: true });
      expect(actions.undoDeckEdit).not.toHaveBeenCalled();
      act(() => useApp.getState().setEditing(false));
    });

    it("moves slides with ⌘↑ and ⌘↓ instead of selecting another", () => {
      render(<Stage />);
      fireEvent.keyDown(document.body, { key: "ArrowDown", metaKey: true });
      expect(actions.moveSlides).toHaveBeenLastCalledWith(1);
      fireEvent.keyDown(document.body, { key: "ArrowUp", metaKey: true });
      expect(actions.moveSlides).toHaveBeenLastCalledWith(-1);
      expect(useApp.getState().selected).toBe("intro");
    });

    it("takes the same keys forwarded by a slide preview", () => {
      render(<Stage />);
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);
      const source = frame.contentWindow;
      const forward = (data: object) =>
        act(
          () => void window.dispatchEvent(new MessageEvent("message", { data: { type: "slop:key", ...data }, source })),
        );
      forward({ key: "ArrowDown", mod: true });
      expect(actions.moveSlides).toHaveBeenLastCalledWith(1);
      forward({ key: "z", mod: true });
      expect(actions.undoDeckEdit).toHaveBeenCalledOnce();
      frame.remove();
    });

    it("Delete and Escape act on several picked slides, and on nothing otherwise", () => {
      render(<Stage />);
      fireEvent.keyDown(document.body, { key: "Delete" });
      fireEvent.keyDown(document.body, { key: "Backspace" });
      expect(actions.deleteSlides).not.toHaveBeenCalled();
      useApp.setState({ railSelected: ["intro", "outro"] });
      fireEvent.keyDown(document.body, { key: "Backspace" });
      expect(actions.deleteSlides).toHaveBeenCalledWith(["intro", "outro"]);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(useApp.getState().railSelected).toEqual([]);
    });
  });

  describe("keys forwarded by slide previews", () => {
    function forward(key: string, source: MessageEventSource | null) {
      act(() => void window.dispatchEvent(new MessageEvent("message", { data: { type: "slop:key", key }, source })));
    }

    it("navigates on keys from a slide iframe", () => {
      render(<Stage />);
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);
      forward("ArrowRight", frame.contentWindow);
      expect(useApp.getState().selected).toBe("#2");
      frame.remove();
    });

    it("focuses a slide iframe that asks for it, taking the keys from the composer", () => {
      render(
        <>
          <Stage />
          <textarea data-testid="composer" />
        </>,
      );
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);
      screen.getByTestId("composer").focus();
      act(
        () => void window.dispatchEvent(new MessageEvent("message", { data: { type: "slop:focus" }, source: window })),
      );
      expect(document.activeElement).toBe(screen.getByTestId("composer"));
      act(
        () =>
          void window.dispatchEvent(
            new MessageEvent("message", { data: { type: "slop:focus" }, source: frame.contentWindow }),
          ),
      );
      expect(document.activeElement).toBe(frame);
      expect(useApp.getState().selected).toBe("intro");
      frame.remove();
    });

    it("ignores messages from anywhere else", () => {
      render(<Stage />);
      forward("ArrowRight", window);
      forward("ArrowRight", null);
      act(() => void window.dispatchEvent(new MessageEvent("message", { data: { type: "other", key: "ArrowRight" } })));
      expect(useApp.getState().selected).toBe("intro");
    });
  });

  describe("sketching", () => {
    const layer = () => screen.getByTestId("annotation-layer");
    const tool = (name: string) => screen.getByRole("button", { name });
    const pressed = (name: string) => tool(name).getAttribute("aria-pressed") === "true";

    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 500));
    });
    afterEach(() => vi.restoreAllMocks());

    function draw(points: [number, number][]) {
      const [first, ...rest] = points;
      fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: first![0], clientY: first![1], pointerId: 1 });
      for (const [x, y] of rest) fireEvent.pointerMove(layer(), { buttons: 1, clientX: x, clientY: y, pointerId: 1 });
      fireEvent.pointerUp(layer(), { pointerId: 1 });
    }

    it("leaves the slide clickable until a tool is picked", () => {
      render(<Stage />);
      expect(layer().style.pointerEvents).toBe("none");
      fireEvent.click(tool("Draw on the slide"));
      expect(pressed("Draw on the slide")).toBe(true);
      expect(layer().style.pointerEvents).toBe("auto");
      fireEvent.click(tool("Draw on the slide"));
      expect(pressed("Draw on the slide")).toBe(false);
      expect(layer().style.pointerEvents).toBe("none");
    });

    it("marks the slide being screenshotted when sending", () => {
      const { container } = render(<Stage />);
      const target = container.querySelector(`[${SKETCH_TARGET_ATTR}]`)!;
      expect(target.contains(layer())).toBe(true);
      expect(target.querySelector("iframe, [style*='aspect-ratio']")).toBeTruthy();
    });

    it.each(["Draw on the slide", "Highlight on the slide", "Erase marks"])(
      "%s prevents native selection while annotating",
      (name) => {
        render(<Stage />);
        fireEvent.click(tool(name));
        // A canceled press prevents the browser's compatibility mousedown/selection action.
        expect(fireEvent.pointerDown(layer(), { button: 0, buttons: 1, pointerId: 1, cancelable: true })).toBe(false);
        fireEvent.pointerUp(layer(), { pointerId: 1 });
        expect(layer().style.userSelect).toBe("none");
        // Leave the middle button available for pasteboard navigation.
        expect(fireEvent.pointerDown(layer(), { button: 1, cancelable: true })).toBe(true);
      },
    );

    it("keeps the drawing in the store, per slide", () => {
      render(<Stage />);
      fireEvent.click(tool("Draw on the slide"));
      draw([
        [100, 100],
        [500, 250],
      ]);
      expect(useApp.getState().sketches.intro).toEqual([
        {
          tool: "pen",
          color: "#ef4444",
          points: [
            [0.1, 0.2],
            [0.5, 0.5],
          ],
        },
      ]);
      act(() => useApp.getState().select("#2"));
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(0);
      act(() => useApp.getState().select("intro"));
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(1);
    });

    it("highlights in the highlighter color", () => {
      render(<Stage />);
      fireEvent.click(tool("Highlight on the slide"));
      draw([
        [10, 10],
        [20, 20],
      ]);
      expect(useApp.getState().sketches.intro?.[0]).toMatchObject({ tool: "highlighter", color: "#facc15" });
    });

    it("offers colors while inking", () => {
      render(<Stage />);
      expect(screen.queryByRole("button", { name: /^Color/ })).toBeNull();
      fireEvent.click(tool("Draw on the slide"));
      fireEvent.click(tool("Color #3b82f6"));
      draw([[10, 10]]);
      expect(useApp.getState().sketches.intro?.[0]?.color).toBe("#3b82f6");
    });

    it("undoes and clears marks", () => {
      render(<Stage />);
      expect(screen.queryByRole("button", { name: "Undo mark" })).toBeNull();
      fireEvent.click(tool("Draw on the slide"));
      draw([[10, 10]]);
      draw([[20, 20]]);
      fireEvent.click(tool("Undo mark"));
      expect(useApp.getState().sketches.intro).toHaveLength(1);
      fireEvent.click(tool("Clear marks on this slide"));
      expect(useApp.getState().sketches.intro).toEqual([]);
      expect(screen.queryByRole("button", { name: "Clear marks on this slide" })).toBeNull();
    });

    it("puts the review toggle before the sketch tools", () => {
      const mark = { tool: "pen" as const, color: "#ef4444", points: [[0.5, 0.5]] as [number, number][] };
      act(() => useApp.setState({ sketches: { intro: [mark] } }));
      render(<Stage />);
      const toggle = tool("Hide review marks and comments");
      expect(toggle.compareDocumentPosition(tool("Draw on the slide")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("shows and hides the review marks", () => {
      const mark = { tool: "pen" as const, color: "#ef4444", points: [[0.5, 0.5]] as [number, number][] };
      render(<Stage />);
      expect(screen.queryByRole("button", { name: "Hide review marks and comments" })).toBeNull();
      // Marks on any slide offer the toggle, even when the current slide has none.
      act(() => useApp.setState({ sketches: { "#2": [mark] } }));
      fireEvent.click(tool("Draw on the slide"));
      draw([[10, 10]]);
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(1);
      fireEvent.click(tool("Hide review marks and comments"));
      expect(useApp.getState().reviewVisible).toBe(false);
      expect(pressed("Draw on the slide")).toBe(false);
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(0);
      expect(screen.queryByRole("button", { name: "Undo mark" })).toBeNull();
      expect(useApp.getState().sketches.intro).toHaveLength(1);
      fireEvent.click(tool("Show review marks and comments"));
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(1);
    });

    describe("comments", () => {
      const comment = { id: "first", text: "Bigger", x: 0.25, y: 0.5 };
      const frameOf = (container: HTMLElement) => container.querySelector("iframe")!;
      const fromFrame = (container: HTMLElement, data: unknown) =>
        act(() => {
          window.dispatchEvent(new MessageEvent("message", { data, source: frameOf(container).contentWindow }));
        });
      const pick = (container: HTMLElement) =>
        fromFrame(container, {
          type: "slop:comment-pick",
          slide: "intro",
          x: 0.4,
          y: 0.2,
          target: { path: [1], tag: "h2", label: "Hello", at: [0.5, 0.5] },
        });
      const input = () => screen.getByRole("textbox", { name: "Comment text" });
      let restoreObserver: typeof ResizeObserver;

      beforeEach(() => {
        restoreObserver = globalThis.ResizeObserver;
        // Lay the stage out so the slide preview loads.
        globalThis.ResizeObserver = class {
          constructor(private callback: ResizeObserverCallback) {}
          observe(target: Element) {
            this.callback(
              [{ target, contentRect: { width: 960, height: 540 } } as unknown as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            );
          }
          unobserve() {}
          disconnect() {}
        } as unknown as typeof ResizeObserver;
        useApp.setState({ comments: {}, commentsHeld: {}, reviewVisible: true });
      });
      afterEach(() => {
        globalThis.ResizeObserver = restoreObserver;
        useApp.setState({ comments: {}, reviewVisible: true });
      });

      it("turns picking on in the preview, also after a reload, and off with Escape", () => {
        const { container } = render(<Stage />);
        fireEvent.load(frameOf(container));
        const post = vi.spyOn(frameOf(container).contentWindow!, "postMessage");
        fireEvent.click(tool("Comment on an element"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:comment-tool", on: true }, "*");
        post.mockClear();
        fireEvent.load(frameOf(container));
        expect(post).toHaveBeenCalledWith({ type: "slop:comment-tool", on: true }, "*");
        fromFrame(container, { type: "slop:key", key: "Escape" });
        expect(pressed("Comment on an element")).toBe(false);
        expect(post).toHaveBeenLastCalledWith({ type: "slop:comment-tool", on: false }, "*");
      });

      it("takes turns with the pens", () => {
        render(<Stage />);
        fireEvent.click(tool("Draw on the slide"));
        fireEvent.click(tool("Comment on an element"));
        expect([pressed("Draw on the slide"), pressed("Comment on an element")]).toEqual([false, true]);
        fireEvent.click(tool("Draw on the slide"));
        expect([pressed("Draw on the slide"), pressed("Comment on an element")]).toEqual([true, false]);
      });

      it("adds a comment on the element picked", () => {
        const { container } = render(<Stage />);
        fireEvent.click(tool("Comment on an element"));
        pick(container);
        expect(screen.getByRole("dialog", { name: "New comment" }).textContent).toContain("Hello");
        fireEvent.change(input(), { target: { value: "  Make it bigger " } });
        fireEvent.keyDown(input(), { key: "Enter" });
        expect(useApp.getState().comments.intro).toEqual([
          {
            id: expect.any(String),
            text: "Make it bigger",
            x: 0.4,
            y: 0.2,
            target: { path: [1], tag: "h2", label: "Hello", at: [0.5, 0.5] },
          },
        ]);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.getAllByTestId("comment-pin").map((p) => p.textContent)).toEqual(["1"]);
      });

      it("keeps a comment being written when another element is picked", () => {
        const { container } = render(<Stage />);
        fireEvent.click(tool("Comment on an element"));
        pick(container);
        fireEvent.change(input(), { target: { value: "First" } });
        pick(container);
        expect(useApp.getState().comments.intro?.map((c) => c.text)).toEqual(["First"]);
        expect((input() as HTMLTextAreaElement).value).toBe("");
      });

      it("drops a new comment on Escape", () => {
        const { container } = render(<Stage />);
        fireEvent.click(tool("Comment on an element"));
        pick(container);
        fireEvent.change(input(), { target: { value: "Never mind" } });
        fireEvent.keyDown(input(), { key: "Escape" });
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(useApp.getState().comments.intro ?? []).toEqual([]);
        expect(pressed("Comment on an element")).toBe(true);
      });

      it("edits and removes a comment from its pin", () => {
        useApp.setState({ comments: { intro: [comment] } });
        render(<Stage />);
        fireEvent.click(screen.getByRole("button", { name: "Comment 1" }));
        expect((input() as HTMLTextAreaElement).value).toBe("Bigger");
        fireEvent.change(input(), { target: { value: "Smaller" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(useApp.getState().comments.intro).toEqual([{ ...comment, text: "Smaller" }]);
        fireEvent.click(screen.getByRole("button", { name: "Comment 1" }));
        fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
        expect(useApp.getState().comments.intro).toEqual([]);
        expect(screen.queryByTestId("comment-pin")).toBeNull();
      });

      it("saves what is written when the slide changes", () => {
        useApp.setState({ comments: { intro: [comment] } });
        render(<Stage />);
        fireEvent.click(screen.getByRole("button", { name: "Comment 1" }));
        fireEvent.change(input(), { target: { value: "Smaller" } });
        act(() => useApp.getState().selectRelative(1));
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(useApp.getState().comments.intro?.[0]?.text).toBe("Smaller");
      });

      it("has the preview find the comments, and puts the pins where it says", () => {
        useApp.setState({ comments: { intro: [comment] } });
        const { container } = render(<Stage />);
        const post = vi.spyOn(frameOf(container).contentWindow!, "postMessage");
        fireEvent.load(frameOf(container));
        expect(post).toHaveBeenCalledWith({ type: "slop:comment-locate", comments: [comment] }, "*");
        const pin = screen.getByRole("button", { name: "Comment 1" });
        expect(pin.style.left).toBe("25%");
        fromFrame(container, {
          type: "slop:comment-spots",
          slide: "intro",
          spots: [{ id: "first", x: 0.75, y: 0.1, found: false }],
        });
        expect(pin.style.left).toBe("75%");
        expect(pin.title).toContain("gone");
        // Another slide's answer, from a preview on its way out, does not count.
        fromFrame(container, { type: "slop:comment-spots", slide: "outro", spots: [{ id: "first", x: 0, y: 0 }] });
        expect(pin.style.left).toBe("75%");
      });

      it("shows pins in View only, and not while the review is hidden", () => {
        useApp.setState({ comments: { intro: [comment] } });
        render(<Stage />);
        act(() => useApp.getState().setMode("narration"));
        expect(screen.queryByTestId("comment-pin")).toBeNull();
        act(() => useApp.getState().setMode("view"));
        expect(screen.getByTestId("comment-pin")).toBeTruthy();
        fireEvent.click(tool("Hide review marks and comments"));
        expect(screen.queryByTestId("comment-pin")).toBeNull();
      });

      it("lets ink pass under the pins", () => {
        useApp.setState({ comments: { intro: [comment] } });
        render(<Stage />);
        const pin = screen.getByTestId("comment-pin");
        expect(pin.className).toContain("pointer-events-auto");
        fireEvent.click(tool("Draw on the slide"));
        expect(pin.className).toContain("pointer-events-none");
      });
    });

    it("picking a pen shows hidden review marks", () => {
      const mark = { tool: "pen" as const, color: "#ef4444", points: [[0.5, 0.5]] as [number, number][] };
      useApp.setState({ sketches: { intro: [mark] }, reviewVisible: false });
      render(<Stage />);
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(0);
      fireEvent.click(tool("Highlight on the slide"));
      expect(useApp.getState().reviewVisible).toBe(true);
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(1);
    });

    it("Escape puts the tool away, but not while typing", () => {
      render(
        <>
          <Stage />
          <textarea data-testid="textarea" />
        </>,
      );
      fireEvent.click(tool("Draw on the slide"));
      fireEvent.keyDown(screen.getByTestId("textarea"), { key: "Escape" });
      expect(pressed("Draw on the slide")).toBe(true);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(pressed("Draw on the slide")).toBe(false);
    });

    it("shows a drawing made before the stage mounted", () => {
      useApp.setState({ sketches: { intro: [{ tool: "pen", color: "#ef4444", points: [[0.5, 0.5]] }] } });
      render(<Stage />);
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(1);
    });
  });

  describe("editing the slide", () => {
    const NoLayout = globalThis.ResizeObserver;
    const { saveSlideEdit, undoSlideEdit, redoSlideEdit, discardSlideEdits, tidyLayout } = useApp.getState();
    const toggleEditing = () => act(() => useApp.getState().setMode(useApp.getState().editing ? "view" : "edit"));
    const stageFrame = (container: HTMLElement) => container.querySelector("iframe")!;
    const MARKUP = `<section class="slide" id="intro"><h1 data-moved="" style="translate: 9px 0px;">Hello</h1></section>`;

    function fromFrame(frame: HTMLIFrameElement | null, data: unknown) {
      act(() => void window.dispatchEvent(new MessageEvent("message", { data, source: frame?.contentWindow ?? null })));
    }

    beforeEach(() => {
      // Lay the stage out at 960px so the slide preview loads.
      globalThis.ResizeObserver = class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(target: Element) {
          this.callback(
            [{ target, contentRect: { width: 960, height: 540 } } as unknown as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
      useApp.setState({ editing: false, editReload: 0, slideUndo: [], slideRedo: [], running: false });
    });
    afterEach(() => {
      globalThis.ResizeObserver = NoLayout;
      useApp.setState({ saveSlideEdit, undoSlideEdit, redoSlideEdit, discardSlideEdits, tidyLayout });
      vi.restoreAllMocks();
    });

    it("locks Layout and Tidy layout on a locked slide, and leaves edit mode for one", () => {
      const locked = deckFor(DECK_HTML.replace(`id="outro"`, `id="outro" data-locked`));
      useApp.setState({ deck: locked, templates: [] });
      render(<Stage />);
      toggleEditing();
      expect(useApp.getState().editing).toBe(true);
      expect(screen.queryByText("Locked")).toBeNull();

      act(() => useApp.getState().select("outro"));
      expect(useApp.getState().editing).toBe(false);
      expect(screen.getByText("Locked")).toBeTruthy();
      expect((screen.getByRole("button", { name: /^Layout$/ }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: /Tidy layout/ }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("loads the slide editor into the preview in edit mode", () => {
      const { container } = render(<Stage />);
      expect(stageFrame(container).getAttribute("src")).not.toContain("edit=");
      toggleEditing();
      expect(useApp.getState().editing).toBe(true);
      const sources = [...container.querySelectorAll("iframe")].map((f) => f.getAttribute("src"));
      expect(sources.some((src) => src?.includes("&static&pan&edit=0"))).toBe(true);
      toggleEditing();
      expect(useApp.getState().editing).toBe(false);
    });

    it("shows each mode's tools above the slide, and only there", () => {
      render(<Stage />);
      const sketch = () => screen.queryByRole("toolbar", { name: "Sketch tools" });
      const edit = () => screen.queryByRole("toolbar", { name: "Edit tools" });
      expect(sketch()).not.toBeNull();
      expect(edit()).toBeNull();
      act(() => useApp.getState().setMode("edit"));
      expect(sketch()).toBeNull();
      expect(edit()).not.toBeNull();
      for (const name of ["Undo", "Redo"]) expect(screen.getByRole("button", { name })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Accept/ }));
      expect(useApp.getState()).toMatchObject({ editing: false, slideMode: "view" });
      expect(sketch()).not.toBeNull();
      expect(edit()).toBeNull();
    });

    it("marks what the search finds in the preview, again whenever the preview reloads", () => {
      const { container } = render(<Stage />);
      const frame = stageFrame(container);
      fireEvent.load(frame);
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      const marks = { type: "slop:search", query: "hello", matchCase: false, wholeWord: false, active: 0 };
      act(() => {
        useApp.getState().setSearch({ query: "hello" });
        useApp
          .getState()
          .setSearchMatches([
            { slide: "intro", index: 0, locked: false, notes: false, before: "", text: "Hello", after: "" },
          ]);
      });
      expect(post).toHaveBeenLastCalledWith(marks, "*");
      post.mockClear();
      fireEvent.load(frame);
      expect(post).toHaveBeenCalledWith(marks, "*");
      act(() => useApp.getState().clearSearch());
      expect(post).toHaveBeenLastCalledWith({ ...marks, query: "", active: -1 }, "*");
    });

    it("puts a sketch tool away when leaving view mode", () => {
      render(<Stage />);
      fireEvent.click(screen.getByRole("button", { name: "Draw on the slide" }));
      act(() => useApp.getState().setMode("narration"));
      act(() => useApp.getState().setMode("view"));
      expect(screen.getByRole("button", { name: "Draw on the slide" }).getAttribute("aria-pressed")).toBe("false");
    });

    it("marks the slide and shows the edit bar while editing", () => {
      const { container } = render(<Stage />);
      const slide = () => container.querySelector("[data-sketch-target]")!;
      expect(slide().hasAttribute("data-editing")).toBe(false);
      expect(screen.queryByRole("toolbar", { name: "Edit tools" })).toBeNull();
      toggleEditing();
      expect(slide().hasAttribute("data-editing")).toBe(true);
      // The ring around the slide is drawn by the preview, so it pans and zooms with the slide.
      expect(slide().className).not.toContain("ring");
      expect(screen.getByRole("toolbar", { name: "Edit tools" })).toBeTruthy();
    });

    describe("edit toolbar", () => {
      const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
      const SELECTION = {
        kind: "shape",
        text: true,
        vector: false,
        color: "#ffffff",
        fontSize: 40,
        bold: false,
        italic: true,
        align: "center",
        valign: "middle",
        fill: "#3b82f6",
        stroke: null,
        strokeWidth: 0,
      };
      const enter = () => {
        const view = render(<Stage />);
        toggleEditing();
        const frame = stageFrame(view.container);
        fireEvent.load(frame);
        return { ...view, frame, post: vi.spyOn(frame.contentWindow!, "postMessage") };
      };
      const select = (frame: HTMLIFrameElement, selection: unknown = SELECTION) =>
        fromFrame(frame, { type: "slop:edit-selection", slide: "intro", selection });

      beforeEach(() => useApp.setState({ editTool: "select", editStyles: DEFAULT_EDIT_STYLES }));

      it("picks a tool, telling the editor with the style of what it adds", () => {
        const { post } = enter();
        expect(button("Select and move (V)").getAttribute("aria-pressed")).toBe("true");
        fireEvent.click(button("Add a rectangle (R)"));
        expect(useApp.getState().editTool).toBe("rect");
        expect(button("Add a rectangle (R)").getAttribute("aria-pressed")).toBe("true");
        expect(post).toHaveBeenLastCalledWith(
          { type: "slop:edit-tool", tool: "rect", style: DEFAULT_EDIT_STYLES.shape },
          "*",
        );
        fireEvent.click(button("Draw freehand (D)"));
        expect(post).toHaveBeenLastCalledWith(
          { type: "slop:edit-tool", tool: "draw", style: DEFAULT_EDIT_STYLES.draw },
          "*",
        );
        fireEvent.click(button("Select and move (V)"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-tool", tool: "select", style: undefined }, "*");
      });

      it("defaults to Resize and preserves Stretch across preview reloads", () => {
        const { frame, post } = enter();
        const mode = screen.getByRole("combobox", { name: "Size mode" });
        expect((mode as HTMLSelectElement).value).toBe("resize");
        fireEvent.change(mode, { target: { value: "stretch" } });
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-size-mode", mode: "stretch" }, "*");
        post.mockClear();
        fireEvent.load(frame);
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-size-mode", mode: "stretch" }, "*");
        expect((mode as HTMLSelectElement).value).toBe("stretch");
      });

      it("tells a reloaded editor the current tool", () => {
        const { frame } = enter();
        fireEvent.click(button("Add text (T)"));
        const post = vi.spyOn(frame.contentWindow!, "postMessage");
        fireEvent.load(frame);
        expect(post).toHaveBeenCalledWith(
          { type: "slop:edit-tool", tool: "text", style: DEFAULT_EDIT_STYLES.text },
          "*",
        );
      });

      it("follows the editor when it puts its tool away", () => {
        const { frame } = enter();
        fireEvent.click(button("Add an ellipse (O)"));
        fromFrame(frame, { type: "slop:edit-tool", slide: "intro", tool: "select" });
        expect(useApp.getState().editTool).toBe("select");
        // Not from another slide, and not for tools it does not know.
        fireEvent.click(button("Add an ellipse (O)"));
        fromFrame(frame, { type: "slop:edit-tool", slide: "outro", tool: "select" });
        fromFrame(frame, { type: "slop:edit-tool", slide: "intro", tool: "lasso" });
        expect(useApp.getState().editTool).toBe("ellipse");
      });

      it("picks tools with single keys, and Escape puts the tool away before leaving edit mode", () => {
        const { frame } = enter();
        fireEvent.keyDown(document.body, { key: "t" });
        expect(useApp.getState().editTool).toBe("text");
        fromFrame(frame, { type: "slop:key", key: "r", mod: false });
        expect(useApp.getState().editTool).toBe("rect");
        fromFrame(frame, { type: "slop:key", key: "d", mod: false });
        expect(useApp.getState().editTool).toBe("draw");
        fireEvent.keyDown(document.body, { key: "Escape" });
        expect(useApp.getState()).toMatchObject({ editTool: "select", editing: true });
        // Escape in the app leaves edit mode only from the slide.
        fireEvent.keyDown(document.body, { key: "Escape" });
        expect(useApp.getState().editing).toBe(true);
        fromFrame(frame, { type: "slop:key", key: "o", mod: false });
        fromFrame(frame, { type: "slop:key", key: "Escape", mod: false });
        expect(useApp.getState()).toMatchObject({ editTool: "select", editing: true });
        fromFrame(frame, { type: "slop:key", key: "Escape", mod: false });
        expect(useApp.getState().editing).toBe(false);
      });

      it("leaves typing alone", () => {
        enter();
        const input = document.createElement("textarea");
        document.body.appendChild(input);
        fireEvent.keyDown(input, { key: "t" });
        expect(useApp.getState().editTool).toBe("select");
        input.remove();
      });

      it("starts each edit session with the select tool", () => {
        enter();
        fireEvent.click(button("Add text (T)"));
        toggleEditing();
        toggleEditing();
        expect(useApp.getState().editTool).toBe("select");
      });

      it("has nothing to style until something is selected or a tool is picked", () => {
        const { frame } = enter();
        for (const name of ["Text color", "Bold (⌘B)", "Fill", "Border color", "Bring to front", "Delete (⌫)"]) {
          expect(button(name).disabled).toBe(true);
        }
        select(frame);
        for (const name of ["Text color", "Bold (⌘B)", "Fill", "Border color", "Bring to front", "Delete (⌫)"]) {
          expect(button(name).disabled).toBe(false);
        }
        select(frame, null);
        expect(button("Fill").disabled).toBe(true);
      });

      it("shows the selection's style", () => {
        const { frame } = enter();
        select(frame);
        expect((screen.getByLabelText("Font size") as HTMLInputElement).value).toBe("40");
        expect(button("Italic (⌘I)").getAttribute("aria-pressed")).toBe("true");
        expect(button("Bold (⌘B)").getAttribute("aria-pressed")).toBe("false");
        expect(button("Center text").getAttribute("aria-pressed")).toBe("true");
        expect(button("Center text vertically").getAttribute("aria-pressed")).toBe("true");
        expect(screen.getByTestId("Fill swatch").style.background).toBe("rgb(59, 130, 246)");
        expect((screen.getByLabelText("Border width") as HTMLSelectElement).value).toBe("0");
      });

      it("restyles the selection, and makes that the style of the next one of its kind", () => {
        const { frame, post } = enter();
        select(frame);
        fireEvent.click(button("Larger text"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { fontSize: 48 } }, "*");
        fireEvent.click(button("Bold (⌘B)"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { bold: true } }, "*");
        fireEvent.click(button("Align text to the bottom"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { valign: "bottom" } }, "*");
        fireEvent.change(screen.getByLabelText("Border width"), { target: { value: "8" } });
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { strokeWidth: 8 } }, "*");
        expect(useApp.getState().editStyles.shape).toMatchObject({
          fontSize: 48,
          bold: true,
          valign: "bottom",
          strokeWidth: 8,
        });
        expect(useApp.getState().editStyles.text).toEqual(DEFAULT_EDIT_STYLES.text);
      });

      it("leaves the defaults alone when restyling the deck's own elements", () => {
        const { frame, post } = enter();
        select(frame, { ...SELECTION, kind: "element", valign: null });
        expect(button("Align text to the top").disabled).toBe(true);
        fireEvent.click(button("Align text right"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { align: "right" } }, "*");
        expect(useApp.getState().editStyles).toEqual(DEFAULT_EDIT_STYLES);
      });

      it("offers a drawing's line color and width, without text controls", () => {
        const { frame } = enter();
        select(frame, {
          ...SELECTION,
          kind: "drawing",
          text: false,
          vector: true,
          stroke: "#ef4444",
          strokeWidth: 6,
          fill: null,
        });
        expect(button("Bold (⌘B)").disabled).toBe(true);
        expect(button("Line color").disabled).toBe(false);
        expect((screen.getByLabelText("Line width") as HTMLSelectElement).value).toBe("6");
      });

      it("styles what the tool adds when nothing is selected", () => {
        const { post } = enter();
        fireEvent.click(button("Add text (T)"));
        expect(button("Fill").disabled).toBe(false);
        fireEvent.click(button("Italic (⌘I)"));
        expect(useApp.getState().editStyles.text.italic).toBe(true);
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-style" }), "*");
        expect(post).toHaveBeenLastCalledWith(
          { type: "slop:edit-tool", tool: "text", style: { ...DEFAULT_EDIT_STYLES.text, italic: true } },
          "*",
        );
      });

      it("shows the deck's colors above the fixed palette", () => {
        const { frame, post } = enter();
        select(frame);
        fromFrame(frame, {
          type: "slop:edit-colors",
          slide: "intro",
          colors: [
            { name: "brand", value: "#112233" },
            { name: "bad", value: "red" },
          ],
        });
        fireEvent.click(button("Fill"));
        const dialog = screen.getByRole("dialog", { name: "Fill" });
        const group = screen.getByRole("group", { name: "Deck colors" });
        expect(dialog.firstElementChild).toBe(group);
        expect(group.querySelectorAll("button")).toHaveLength(1);
        fireEvent.click(button("Deck color brand"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { fill: "#112233" } }, "*");
      });

      it("has no deck colors row without any", () => {
        const { frame } = enter();
        select(frame);
        fireEvent.click(button("Fill"));
        expect(screen.queryByRole("group", { name: "Deck colors" })).toBeNull();
      });

      it("sets the slide's background, with nothing selected, and shows it", () => {
        const { frame, post } = enter();
        fromFrame(frame, { type: "slop:edit-background", slide: "intro", color: "#112233" });
        expect(screen.getByTestId("Slide background swatch").style.background).toBe("rgb(17, 34, 51)");
        fireEvent.click(button("Slide background"));
        fireEvent.click(button("#ef4444"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-background", color: "#ef4444" }, "*");
        fireEvent.click(button("Slide background"));
        fireEvent.click(button("None"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-background", color: null }, "*");
      });

      it("offers the new tools, and takes them back from the editor", () => {
        const { frame, post } = enter();
        for (const [name, tool] of [
          ["Add a triangle", "triangle"],
          ["Add a star", "star"],
          ["Add a speech bubble", "bubble"],
        ] as const) {
          fireEvent.click(button(name));
          expect(post).toHaveBeenLastCalledWith(
            { type: "slop:edit-tool", tool, style: DEFAULT_EDIT_STYLES.shape },
            "*",
          );
        }
        fireEvent.click(button("Add an arrow (A, Shift snaps to 45°)"));
        expect(post).toHaveBeenLastCalledWith(
          { type: "slop:edit-tool", tool: "arrow", style: DEFAULT_EDIT_STYLES.draw },
          "*",
        );
        fromFrame(frame, { type: "slop:edit-tool", slide: "intro", tool: "select" });
        expect(useApp.getState().editTool).toBe("select");
      });

      it("arms the format painter on the selection, and disarms it", () => {
        const { frame } = enter();
        const painter = "Copy this look to the next element clicked";
        expect(button(painter).disabled).toBe(true);
        select(frame);
        fireEvent.click(button(painter));
        expect(useApp.getState().editTool).toBe("paint");
        expect(button(painter).getAttribute("aria-pressed")).toBe("true");
        fireEvent.click(button(painter));
        expect(useApp.getState().editTool).toBe("select");
      });

      it("applies a slider where it is let go, not all along the drag", () => {
        const { frame, post } = enter();
        expect(button("Appearance").disabled).toBe(true);
        select(frame, { ...SELECTION, opacity: 1, shadow: 0, radius: 8 });
        fireEvent.click(button("Appearance"));
        const opacity = screen.getByLabelText("Opacity") as HTMLInputElement;
        fireEvent.input(opacity, { target: { value: "50" } });
        expect(screen.getByRole("dialog", { name: "Appearance" }).textContent).toContain("50%");
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-style" }), "*");
        act(() => void opacity.dispatchEvent(new Event("change")));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { opacity: 0.5 } }, "*");
        const radius = screen.getByLabelText("Corner radius") as HTMLInputElement;
        fireEvent.input(radius, { target: { value: "20" } });
        act(() => void radius.dispatchEvent(new Event("change")));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { radius: 20 } }, "*");
        // Restyling leaves the next shape's defaults alone.
        expect(useApp.getState().editStyles.shape).toEqual(DEFAULT_EDIT_STYLES.shape);
      });

      it("keeps the appearance panel through the reload after a change", () => {
        const { frame } = enter();
        select(frame, { ...SELECTION, opacity: 1, shadow: 0, radius: 8 });
        fireEvent.click(button("Appearance"));
        select(frame, null);
        expect(screen.queryByRole("dialog", { name: "Appearance" })).toBeNull();
        select(frame, { ...SELECTION, opacity: 0.5, shadow: 0, radius: 8 });
        expect(screen.getByRole("dialog", { name: "Appearance" })).toBeTruthy();
      });

      it("turns off what a cut-out shape cannot show", () => {
        const { frame } = enter();
        select(frame, { ...SELECTION, clipped: true, radius: null });
        expect(button("Border color").disabled).toBe(true);
        expect((screen.getByLabelText("Border width") as HTMLSelectElement).disabled).toBe(true);
        fireEvent.click(button("Appearance"));
        expect((screen.getByLabelText("Shadow") as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByLabelText("Corner radius") as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByLabelText("Opacity") as HTMLInputElement).disabled).toBe(false);
      });

      describe("images", () => {
        const IMAGE = {
          ...SELECTION,
          kind: "media",
          text: false,
          image: true,
          fit: "fill",
          fitPosition: "50% 50%",
          alt: "old",
          flipX: false,
          flipY: false,
        };
        beforeEach(() => {
          vi.mocked(invoke).mockReset();
          vi.mocked(open).mockReset();
        });

        it("adds images picked from a file", async () => {
          const { post } = enter();
          vi.mocked(open).mockResolvedValue(["/tmp/a.png"] as never);
          vi.mocked(invoke).mockResolvedValue(["assets/a.png"]);
          fireEvent.click(button("Add an image from a file"));
          await waitFor(() =>
            expect(post).toHaveBeenCalledWith(
              { type: "slop:edit-paste-images", images: [{ src: "assets/a.png", w: 1200, h: 800 }] },
              "*",
            ),
          );
          expect(vi.mocked(open).mock.calls[0]![0]).toMatchObject({ multiple: true });
          expect(invoke).toHaveBeenCalledWith("import_assets", {
            id: useApp.getState().deck!.id,
            paths: ["/tmp/a.png"],
          });
        });

        it("does nothing when the picker is cancelled", async () => {
          const { post } = enter();
          vi.mocked(open).mockResolvedValue(null as never);
          await act(async () => void fireEvent.click(button("Add an image from a file")));
          expect(invoke).not.toHaveBeenCalled();
          expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-paste-images" }), "*");
        });

        it("shows an error when the file cannot be imported", async () => {
          enter();
          vi.mocked(open).mockResolvedValue(["/tmp/a.png"] as never);
          vi.mocked(invoke).mockRejectedValue("disk full");
          fireEvent.click(button("Add an image from a file"));
          await waitFor(() => expect(useApp.getState().error).toBe("disk full"));
          act(() => useApp.getState().setError(null));
        });

        it("offers the image panel for images only", () => {
          const { frame } = enter();
          select(frame);
          expect(button("Image").disabled).toBe(true);
          select(frame, IMAGE);
          expect(button("Image").disabled).toBe(false);
        });

        it("replaces, fits, positions and flips the image", async () => {
          const { frame, post } = enter();
          select(frame, IMAGE);
          fireEvent.click(button("Image"));
          fireEvent.change(screen.getByLabelText("Fit"), { target: { value: "cover" } });
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { fit: "cover" } }, "*");
          fireEvent.click(button("Position 50% 0%"));
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { fitPosition: "50% 0%" } }, "*");
          fireEvent.click(button("Flip horizontally"));
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { flipX: true } }, "*");
          vi.mocked(open).mockResolvedValue("/tmp/b.png" as never);
          vi.mocked(invoke).mockResolvedValue(["assets/b.png"]);
          fireEvent.click(button("Replace the image, keeping its size and place"));
          await waitFor(() =>
            expect(post).toHaveBeenCalledWith({ type: "slop:edit-replace-image", src: "assets/b.png" }, "*"),
          );
          expect(vi.mocked(open).mock.calls[0]![0]).toMatchObject({ multiple: false });
        });

        it("saves alt text on Enter, and when the panel closes", () => {
          const { frame, post } = enter();
          select(frame, IMAGE);
          fireEvent.click(button("Image"));
          const alt = screen.getByLabelText("Alt text");
          fireEvent.change(alt, { target: { value: "A cat" } });
          fireEvent.keyDown(alt, { key: "Enter" });
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { alt: "A cat" } }, "*");
          fireEvent.change(alt, { target: { value: "A dog" } });
          fireEvent.pointerDown(document.body);
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { alt: "A dog" } }, "*");
          expect(screen.queryByRole("dialog", { name: "Image" })).toBeNull();
        });
      });

      it("picks colors from swatches, none, or a custom color", () => {
        const { frame, post } = enter();
        select(frame);
        fireEvent.click(button("Fill"));
        fireEvent.click(button("#ef4444"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { fill: "#ef4444" } }, "*");
        expect(screen.queryByRole("dialog", { name: "Fill" })).toBeNull();
        fireEvent.click(button("Border color"));
        fireEvent.click(button("None"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { stroke: null } }, "*");
        fireEvent.click(button("Text color"));
        expect(screen.queryByRole("button", { name: "None" })).toBeNull();
        fireEvent.change(screen.getByLabelText("Custom text color"), { target: { value: "#123456" } });
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { color: "#123456" } }, "*");
        // Clicking elsewhere closes the picker.
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole("dialog", { name: "Text color" })).toBeNull();
      });

      it("moves the selection up and down the stack, and deletes it", () => {
        const { frame, post } = enter();
        select(frame);
        fireEvent.click(button("Bring forward"));
        fireEvent.click(button("Send to back"));
        fireEvent.click(button("Delete (⌫)"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-order", to: "forward" }, "*");
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-order", to: "back" }, "*");
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-delete" }, "*");
      });

      describe("text formatting", () => {
        const TEXT = {
          ...SELECTION,
          kind: "text",
          fontFamily: "Georgia",
          underline: false,
          strike: false,
          script: null,
          letterSpacing: 0,
          lineHeight: null,
          list: null,
          link: null,
          autofit: null,
          editing: false,
          range: false,
        };
        const style = (changes: Record<string, unknown>) => ({ type: "slop:edit-style", style: changes });

        it("underlines, strikes through, raises and lists the selection's text", () => {
          const { frame, post } = enter();
          select(frame, { ...TEXT, underline: true, script: "sup", list: "ul" });
          expect(button("Underline (⌘U)").getAttribute("aria-pressed")).toBe("true");
          expect(button("Superscript").getAttribute("aria-pressed")).toBe("true");
          expect(button(/^Bulleted list/).getAttribute("aria-pressed")).toBe("true");
          fireEvent.click(button("Underline (⌘U)"));
          fireEvent.click(button("Strikethrough"));
          fireEvent.click(button("Superscript"));
          fireEvent.click(button("Subscript"));
          fireEvent.click(button(/^Numbered list/));
          expect(post).toHaveBeenCalledWith(style({ underline: false }), "*");
          expect(post).toHaveBeenCalledWith(style({ strike: true }), "*");
          expect(post).toHaveBeenCalledWith(style({ script: null }), "*");
          expect(post).toHaveBeenCalledWith(style({ script: "sub" }), "*");
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-list", list: "ol" }, "*");
          // Superscript and lists are not something the next text box starts with.
          expect(useApp.getState().editStyles.text).toMatchObject({ underline: false, strike: true });
          expect(useApp.getState().editStyles.text).not.toHaveProperty("script");
        });

        it("keeps the defaults when styling words while typing", () => {
          const { frame, post } = enter();
          select(frame, { ...TEXT, editing: true, range: true });
          fireEvent.click(button("Bold (⌘B)"));
          expect(post).toHaveBeenCalledWith(style({ bold: true }), "*");
          expect(useApp.getState().editStyles).toEqual(DEFAULT_EDIT_STYLES);
        });

        it("keeps focus in the slide when a button is pressed, and ends typing on a press elsewhere", () => {
          const { frame, post } = enter();
          select(frame, TEXT);
          const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
          button("Bold (⌘B)").dispatchEvent(press);
          expect(press.defaultPrevented).toBe(true);
          fireEvent.pointerDown(button("Bold (⌘B)"));
          expect(post).not.toHaveBeenCalledWith({ type: "slop:edit-finish" }, "*");
          fireEvent.pointerDown(document.body);
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-finish" }, "*");
        });

        it("closes the toolbar's popups on a press in the slide, leaving the typing to the editor", () => {
          const { frame, post } = enter();
          select(frame, TEXT);
          fireEvent.click(button("Text color"));
          expect(screen.getByRole("dialog", { name: "Text color" })).toBeTruthy();
          fromFrame(frame, { type: "slop:edit-press" });
          expect(screen.queryByRole("dialog", { name: "Text color" })).toBeNull();
          expect(post).not.toHaveBeenCalledWith({ type: "slop:edit-finish" }, "*");
        });

        it("takes a typed font size on Enter and gives focus back to the slide", () => {
          const { frame, post } = enter();
          select(frame, TEXT);
          const focus = vi.spyOn(frame, "focus");
          const input = screen.getByLabelText("Font size") as HTMLInputElement;
          fireEvent.change(input, { target: { value: "13" } });
          fireEvent.keyDown(input, { key: "Enter" });
          expect(post).toHaveBeenCalledWith(style({ fontSize: 13 }), "*");
          expect(focus).toHaveBeenCalled();
          // Nonsense goes back to the size it has.
          fireEvent.change(input, { target: { value: "0" } });
          fireEvent.blur(input);
          expect(input.value).toBe("40");
          expect(post).not.toHaveBeenCalledWith(style({ fontSize: 0 }), "*");
        });

        it("picks a font from the deck's fonts or the system's", () => {
          const { frame, post } = enter();
          fromFrame(frame, {
            type: "slop:edit-fonts",
            slide: "intro",
            fonts: [{ name: "Playfair Display", stack: '"Playfair Display", serif' }],
          });
          select(frame, TEXT);
          const font = screen.getByLabelText("Font") as HTMLSelectElement;
          expect(font.value).toBe("Georgia, serif");
          expect(screen.getByRole("group", { name: "Deck fonts" })).toBeTruthy();
          fireEvent.change(font, { target: { value: '"Playfair Display", serif' } });
          expect(post).toHaveBeenCalledWith(style({ fontFamily: '"Playfair Display", serif' }), "*");
          fireEvent.change(font, { target: { value: "" } });
          expect(post).toHaveBeenCalledWith(style({ fontFamily: null }), "*");
          // A font from the deck's styles that is not on the list still shows.
          select(frame, { ...TEXT, fontFamily: "Comic Neue" });
          expect(font.value).toBe("__current");
          expect(screen.getByRole("option", { name: "Comic Neue" })).toBeTruthy();
        });

        it("sets line height, letter spacing and how text fits", () => {
          const { frame, post } = enter();
          select(frame, TEXT);
          fireEvent.click(button("Spacing"));
          fireEvent.change(screen.getByLabelText("Line height"), { target: { value: "1.5" } });
          fireEvent.change(screen.getByLabelText("Letter spacing"), { target: { value: "4" } });
          fireEvent.change(screen.getByLabelText("When text does not fit"), { target: { value: "shrink" } });
          expect(post).toHaveBeenCalledWith(style({ lineHeight: 1.5 }), "*");
          expect(post).toHaveBeenCalledWith(style({ letterSpacing: 4 }), "*");
          expect(post).toHaveBeenCalledWith(style({ autofit: "shrink" }), "*");
          fireEvent.change(screen.getByLabelText("When text does not fit"), { target: { value: "" } });
          expect(post).toHaveBeenCalledWith(style({ autofit: null }), "*");
          expect(useApp.getState().editStyles.text).not.toHaveProperty("autofit");
        });

        it("adds, changes and removes links, to web pages or other slides", () => {
          const { frame, post } = enter();
          select(frame, TEXT);
          fireEvent.click(button("Link"));
          const address = screen.getByLabelText("Link address");
          fireEvent.change(address, { target: { value: "javascript:alert(1)" } });
          fireEvent.click(button("Add link"));
          expect(screen.getByText(/Enter a web address/)).toBeTruthy();
          fireEvent.change(address, { target: { value: "example.com" } });
          fireEvent.click(button("Add link"));
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-link", href: "https://example.com" }, "*");
          expect(screen.queryByRole("dialog", { name: "Link" })).toBeNull();
          fireEvent.click(button("Link"));
          fireEvent.change(screen.getByLabelText("Link to slide"), { target: { value: "outro" } });
          fireEvent.click(button("Add link"));
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-link", href: "#outro" }, "*");
          select(frame, { ...TEXT, link: "#outro" });
          fireEvent.click(button("Link"));
          expect((screen.getByLabelText("Link to slide") as HTMLSelectElement).value).toBe("outro");
          fireEvent.click(button("Remove link"));
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-link", href: null }, "*");
        });

        it("pastes the clipboard's plain text when the editor asks", async () => {
          vi.mocked(invoke).mockResolvedValue("plain words");
          const { frame, post } = enter();
          fromFrame(frame, { type: "slop:edit-paste-request", slide: "intro", plain: true });
          await waitFor(() =>
            expect(post).toHaveBeenCalledWith({ type: "slop:edit-insert-text", text: "plain words" }, "*"),
          );
          expect(invoke).toHaveBeenCalledWith("read_clipboard_text");
        });
      });

      it("ignores selections from other slides and drops a stale one when the editor reloads", () => {
        const { frame } = enter();
        fromFrame(frame, { type: "slop:edit-selection", slide: "outro", selection: SELECTION });
        expect(button("Fill").disabled).toBe(true);
        select(frame);
        expect(button("Fill").disabled).toBe(false);
        act(() => void fireEvent.load(frame));
        expect(button("Fill").disabled).toBe(true);
      });
    });

    it("undo, redo, discard and accept buttons drive the edit history", () => {
      const undo = vi.fn().mockResolvedValue(undefined);
      const redo = vi.fn().mockResolvedValue(undefined);
      const discard = vi.fn().mockResolvedValue(undefined);
      useApp.setState({ undoSlideEdit: undo, redoSlideEdit: redo, discardSlideEdits: discard });
      render(<Stage />);
      toggleEditing();
      const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button("Undo").disabled).toBe(true);
      expect(button("Redo").disabled).toBe(true);
      const entry = { slide: "intro", markup: "", after: "" };
      act(() => useApp.setState({ slideUndo: [entry], slideRedo: [entry] }));
      fireEvent.click(button("Undo"));
      fireEvent.click(button("Redo"));
      fireEvent.click(screen.getByRole("button", { name: /Discard/ }));
      expect([undo, redo, discard].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
      fireEvent.click(screen.getByRole("button", { name: /Accept/ }));
      expect(useApp.getState()).toMatchObject({ editing: false, slideUndo: [], slideRedo: [] });
    });

    it("saves the markup the editor posts for the current slide", () => {
      const save = vi.fn().mockResolvedValue(undefined);
      useApp.setState({ saveSlideEdit: save });
      const { container } = render(<Stage />);
      toggleEditing();
      const frame = stageFrame(container);
      fromFrame(frame, { type: "slop:edit-commit", slide: "intro", markup: MARKUP, select: [0] });
      expect(save).toHaveBeenCalledWith("intro", MARKUP);
      // Not from another slide, a stray window, or outside edit mode.
      fromFrame(frame, { type: "slop:edit-commit", slide: "outro", markup: MARKUP, select: null });
      fromFrame(null, { type: "slop:edit-commit", slide: "intro", markup: MARKUP, select: null });
      toggleEditing();
      fromFrame(frame, { type: "slop:edit-commit", slide: "intro", markup: MARKUP, select: null });
      expect(save).toHaveBeenCalledTimes(1);
    });

    it("deletes the editor's selection from the edit tools, enabled only while something is selected", () => {
      const { container } = render(<Stage />);
      toggleEditing();
      const frame = stageFrame(container);
      fireEvent.load(frame);
      const remove = () => screen.getByRole("button", { name: "Delete (⌫)" }) as HTMLButtonElement;
      expect(remove().disabled).toBe(true);
      fromFrame(frame, { type: "slop:edit-selection", slide: "outro", selected: true, selection: { kind: "element" } });
      fromFrame(null, { type: "slop:edit-selection", slide: "intro", selected: true, selection: { kind: "element" } });
      expect(remove().disabled).toBe(true);
      fromFrame(frame, { type: "slop:edit-selection", slide: "intro", selected: true, selection: { kind: "element" } });
      expect(remove().disabled).toBe(false);
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      fireEvent.click(remove());
      expect(post).toHaveBeenCalledWith({ type: "slop:edit-delete" }, "*");
      fromFrame(frame, { type: "slop:edit-selection", slide: "intro", selected: false, selection: null });
      expect(remove().disabled).toBe(true);
      // A reloaded editor starts without a selection.
      fromFrame(frame, { type: "slop:edit-selection", slide: "intro", selected: true, selection: { kind: "element" } });
      fireEvent.load(frame);
      expect(remove().disabled).toBe(true);
    });

    describe("dropping images", () => {
      beforeEach(() => void vi.mocked(invoke).mockReset());

      /** The stage area at (0, 0, 1000×600); the editing preview 2000px wide, scaled to half, at (-20, -10). */
      function laidOut(container: HTMLElement) {
        const frame = [...container.querySelectorAll("iframe")].at(-1)!;
        fireEvent.load(frame);
        vi.spyOn(screen.getByTestId("stage-area"), "getBoundingClientRect").mockReturnValue(
          new DOMRect(0, 0, 1000, 600),
        );
        vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(-20, -10, 1000, 600));
        Object.defineProperty(frame, "clientWidth", { value: 2000, configurable: true });
        return { frame, post: vi.spyOn(frame.contentWindow!, "postMessage") };
      }

      it("puts images dropped on the slide while editing onto it, where they landed", async () => {
        vi.mocked(invoke).mockResolvedValue(["assets/photo.png"]);
        const { container } = render(<Stage />);
        toggleEditing();
        const { post } = laidOut(container);
        expect(dropCovered({ x: 480, y: 290 })).toBe(true);
        let rest: string[] = [];
        await act(async () => {
          rest = claimDrop(["/tmp/photo.png", "/tmp/notes.md"], { x: 480, y: 290 });
        });
        // Anything that is not an image goes on to the chat.
        expect(rest).toEqual(["/tmp/notes.md"]);
        expect(invoke).toHaveBeenCalledWith("import_assets", {
          id: useApp.getState().deck!.id,
          paths: ["/tmp/photo.png"],
        });
        await waitFor(() =>
          expect(post).toHaveBeenCalledWith(
            {
              type: "slop:edit-insert-images",
              images: [{ src: "assets/photo.png", w: 1200, h: 800 }],
              x: 1000,
              y: 600,
            },
            "*",
          ),
        );
      });

      it("leaves drops to the chat outside edit mode, outside the stage, or without images", () => {
        const { container, unmount } = render(<Stage />);
        expect(claimDrop(["/tmp/photo.png"], { x: 100, y: 100 })).toEqual(["/tmp/photo.png"]);
        expect(dropCovered({ x: 100, y: 100 })).toBe(false);
        toggleEditing();
        laidOut(container);
        expect(dropCovered({ x: 1200, y: 100 })).toBe(false);
        expect(claimDrop(["/tmp/photo.png"], { x: 1200, y: 100 })).toEqual(["/tmp/photo.png"]);
        expect(claimDrop(["/tmp/notes.md"], { x: 100, y: 100 })).toEqual(["/tmp/notes.md"]);
        unmount();
        expect(dropCovered({ x: 100, y: 100 })).toBe(false);
        expect(claimDrop(["/tmp/photo.png"], { x: 100, y: 100 })).toEqual(["/tmp/photo.png"]);
        expect(invoke).not.toHaveBeenCalledWith("import_assets", expect.anything());
      });

      it("does not insert into a slide that is no longer being edited, and reports failed imports", async () => {
        let finish: (refs: string[]) => void = () => {};
        vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
        const { container } = render(<Stage />);
        toggleEditing();
        const { post } = laidOut(container);
        act(() => void claimDrop(["/tmp/photo.png"], { x: 100, y: 100 }));
        toggleEditing();
        await act(async () => finish(["assets/photo.png"]));
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-insert-images" }), "*");

        vi.mocked(invoke).mockRejectedValue("disk full");
        toggleEditing();
        laidOut(container);
        await act(async () => void claimDrop(["/tmp/photo.png"], { x: 100, y: 100 }));
        await waitFor(() => expect(useApp.getState().error).toBe("disk full"));
      });
    });

    describe("the clipboard", () => {
      beforeEach(() => void vi.mocked(invoke).mockReset());

      /** The editing preview, loaded, 2000×1200 in its own pixels. */
      function loaded(container: HTMLElement) {
        const frame = stageFrame(container);
        fireEvent.load(frame);
        Object.defineProperty(frame, "clientWidth", { value: 2000, configurable: true });
        Object.defineProperty(frame, "clientHeight", { value: 1200, configurable: true });
        return { frame, post: vi.spyOn(frame.contentWindow!, "postMessage") };
      }

      it("puts what the editor copied on the system clipboard", async () => {
        vi.mocked(invoke).mockResolvedValue(undefined);
        const { container } = render(<Stage />);
        toggleEditing();
        const { frame } = loaded(container);
        fromFrame(frame, {
          type: "slop:edit-copied",
          slide: "intro",
          html: "<!--slopslides:{}--><p>Hi</p>",
          text: "Hi",
        });
        // Not from another slide.
        fromFrame(frame, { type: "slop:edit-copied", slide: "outro", html: "<p>Other</p>", text: "" });
        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("copy_to_clipboard", {
            html: "<!--slopslides:{}--><p>Hi</p>",
            text: "Hi",
            id: useApp.getState().deck!.id,
          }),
        );
        expect(invoke).toHaveBeenCalledTimes(1);
      });

      it("asks the editor to select all or duplicate with ⌘A / ⌘D pressed in the app", () => {
        const { container } = render(<Stage />);
        toggleEditing();
        const { post } = loaded(container);
        fireEvent.keyDown(document.body, { key: "a", metaKey: true });
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-select-all" }, "*");
        fireEvent.keyDown(document.body, { key: "d", metaKey: true });
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-duplicate" }, "*");
      });

      it("selects all of a multi-selection again after a commit reloads the slide", () => {
        vi.mocked(invoke).mockResolvedValue(undefined);
        const { container } = render(<Stage />);
        toggleEditing();
        const { frame, post } = loaded(container);
        fromFrame(frame, { type: "slop:edit-commit", slide: "intro", markup: "<x>", select: [0], also: [[1], [2]] });
        fireEvent.load(frame);
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-select", path: [0], also: [[1], [2]] }, "*");
      });

      it("arranges the selection from the toolbar", () => {
        const button = (name: string) => screen.getByRole("button", { name });
        const { container } = render(<Stage />);
        toggleEditing();
        const { frame, post } = loaded(container);
        expect(button("Arrange").hasAttribute("disabled")).toBe(true);
        fromFrame(frame, {
          type: "slop:edit-geometry",
          slide: "intro",
          geometry: { count: 3, x: 10, y: 20, w: 300, h: 200, rotation: null },
        });
        fireEvent.click(button("Arrange"));
        fireEvent.click(button("Align left edges"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-align", to: "left" }, "*");
        fireEvent.click(button("Distribute vertically"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-distribute", axis: "v" }, "*");
        const x = screen.getByLabelText("Distance from the slide's left edge") as HTMLInputElement;
        expect(x.value).toBe("10");
        fireEvent.change(x, { target: { value: "42" } });
        fireEvent.keyDown(x, { key: "Enter" });
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-geometry", x: 42 }, "*");
        // Several elements have no size or rotation to type.
        expect(screen.getByLabelText("Width").hasAttribute("disabled")).toBe(true);
        expect(screen.getByLabelText("Rotation in degrees").hasAttribute("disabled")).toBe(true);
        // Another slide's report is not this one's.
        fromFrame(frame, {
          type: "slop:edit-geometry",
          slide: "outro",
          geometry: { count: 3, x: 99, y: 20, w: 300, h: 200, rotation: null },
        });
        expect(x.value).toBe("42");
      });

      it("offers one element's size and aligning it with the slide", () => {
        const button = (name: string) => screen.getByRole("button", { name });
        const { container } = render(<Stage />);
        toggleEditing();
        const { frame, post } = loaded(container);
        fromFrame(frame, {
          type: "slop:edit-geometry",
          slide: "intro",
          geometry: { count: 1, x: 10, y: 20, w: 300, h: 200, rotation: 15 },
        });
        fireEvent.click(button("Arrange"));
        expect(button("Distribute horizontally").hasAttribute("disabled")).toBe(true);
        fireEvent.click(button("Align with the slide's right edges"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-align", to: "right" }, "*");
        const width = screen.getByLabelText("Width") as HTMLInputElement;
        fireEvent.change(width, { target: { value: "0" } });
        fireEvent.blur(width);
        expect(width.value).toBe("300");
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-geometry" }), "*");
        const rotation = screen.getByLabelText("Rotation in degrees") as HTMLInputElement;
        expect(rotation.value).toBe("15");
        fireEvent.change(rotation, { target: { value: "-30" } });
        fireEvent.blur(rotation);
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-geometry", rotation: -30 }, "*");
      });

      it("asks the editor to copy or cut with ⌘C / ⌘X pressed in the app, unless text is selected there", () => {
        const { container } = render(<Stage />);
        toggleEditing();
        const { post } = loaded(container);
        fireEvent.keyDown(document.body, { key: "c", metaKey: true });
        fireEvent.keyDown(document.body, { key: "x", ctrlKey: true });
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-copy", cut: false }, "*");
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-copy", cut: true }, "*");
        post.mockClear();
        const text = document.createElement("p");
        text.textContent = "Chat text";
        document.body.appendChild(text);
        window.getSelection()!.selectAllChildren(text);
        fireEvent.keyDown(document.body, { key: "c", metaKey: true });
        window.getSelection()!.removeAllRanges();
        text.remove();
        // The slide's own ⌘C never reaches the app; a forwarded one is not copied twice.
        fromFrame(stageFrame(container), { type: "slop:key", key: "c", mod: true });
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-copy" }), "*");
      });

      it("pastes an element copied in the editor back into it", async () => {
        vi.mocked(invoke).mockResolvedValue({ kind: "element", html: "<!--slopslides:{}--><p>Hi</p>" });
        const { container } = render(<Stage />);
        toggleEditing();
        const { frame, post } = loaded(container);
        fromFrame(frame, { type: "slop:key", key: "v", mod: true });
        expect(invoke).toHaveBeenCalledWith("paste_from_clipboard", { id: useApp.getState().deck!.id });
        await waitFor(() =>
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-paste", html: "<!--slopslides:{}--><p>Hi</p>" }, "*"),
        );
      });

      it("pastes text as a text box styled like new ones, with ⌘V in the app too", async () => {
        vi.mocked(invoke).mockResolvedValue({ kind: "text", text: "From the web" });
        useApp.setState({
          editStyles: { ...DEFAULT_EDIT_STYLES, text: { ...DEFAULT_EDIT_STYLES.text, fontSize: 64 } },
        });
        const { container } = render(<Stage />);
        toggleEditing();
        const { post } = loaded(container);
        fireEvent.keyDown(document.body, { key: "v", metaKey: true });
        await waitFor(() =>
          expect(post).toHaveBeenCalledWith(
            { type: "slop:edit-paste-text", text: "From the web", style: expect.objectContaining({ fontSize: 64 }) },
            "*",
          ),
        );
        useApp.setState({ editStyles: DEFAULT_EDIT_STYLES });
      });

      it("pastes images, leaving where they go to the editor", async () => {
        vi.mocked(invoke).mockResolvedValue({ kind: "images", images: ["assets/pasted-image.png"] });
        const { container } = render(<Stage />);
        toggleEditing();
        const { frame, post } = loaded(container);
        fromFrame(frame, { type: "slop:key", key: "V", mod: true });
        await waitFor(() =>
          expect(post).toHaveBeenCalledWith(
            { type: "slop:edit-paste-images", images: [{ src: "assets/pasted-image.png", w: 1200, h: 800 }] },
            "*",
          ),
        );
      });

      it("pastes a copied slide as a new slide after the selected one", async () => {
        const deck = useApp.getState().deck!;
        const pasted = {
          ...deck,
          slides: [deck.slides[0]!, { ...deck.slides[0]!, id: "pasted" }, ...deck.slides.slice(1)],
        };
        vi.mocked(invoke).mockImplementation(async (command) =>
          command === "paste_slide" ? { deck: pasted, slide: "pasted" } : { kind: "slide" },
        );
        const { container } = render(<Stage />);
        toggleEditing();
        const { post } = loaded(container);
        await act(async () => void fireEvent.keyDown(document.body, { key: "v", metaKey: true }));
        await waitFor(() => expect(useApp.getState().selected).toBe("pasted"));
        expect(invoke).toHaveBeenCalledWith("paste_slide", { id: deck.id, after: "intro" });
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-paste" }), "*");
      });

      it("pastes no element outside edit mode, into a typing field, or when the clipboard is empty, and reports failures", async () => {
        vi.mocked(invoke).mockResolvedValue({ kind: "nothing" });
        const { container } = render(<Stage />);
        toggleEditing();
        const { post } = loaded(container);
        const input = document.createElement("textarea");
        document.body.appendChild(input);
        fireEvent.keyDown(input, { key: "v", metaKey: true });
        input.remove();
        expect(invoke).not.toHaveBeenCalled();
        await act(async () => void fireEvent.keyDown(document.body, { key: "v", metaKey: true }));
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(post).not.toHaveBeenCalled();
        vi.mocked(invoke).mockRejectedValue("no clipboard");
        await act(async () => void fireEvent.keyDown(document.body, { key: "v", metaKey: true }));
        await waitFor(() => expect(useApp.getState().error).toBe("no clipboard"));
      });
    });

    it("selects the edited element again once the slide reloads", () => {
      useApp.setState({ saveSlideEdit: vi.fn().mockResolvedValue(undefined) });
      const { container } = render(<Stage />);
      toggleEditing();
      const frame = stageFrame(container);
      fromFrame(frame, { type: "slop:edit-commit", slide: "intro", markup: MARKUP, select: [0, 2] });
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      fireEvent.load(frame);
      expect(post).toHaveBeenCalledWith({ type: "slop:edit-select", path: [0, 2] }, "*");
    });

    it("undoes with ⌘Z / Ctrl+Z from the slide or the window, and Escape leaves edit mode", () => {
      const undo = vi.fn().mockResolvedValue(undefined);
      useApp.setState({ undoSlideEdit: undo });
      const { container } = render(<Stage />);
      fireEvent.keyDown(document.body, { key: "z", metaKey: true });
      expect(undo).not.toHaveBeenCalled();
      toggleEditing();
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
      fromFrame(stageFrame(container), { type: "slop:key", key: "z", mod: true });
      expect(undo).toHaveBeenCalledTimes(2);
      fromFrame(stageFrame(container), { type: "slop:key", key: "Escape", mod: false });
      expect(useApp.getState().editing).toBe(false);
    });

    it("redoes with ⇧⌘Z or Ctrl+Y from the slide or the window", () => {
      const undo = vi.fn().mockResolvedValue(undefined);
      const redo = vi.fn().mockResolvedValue(undefined);
      useApp.setState({ undoSlideEdit: undo, redoSlideEdit: redo });
      const { container } = render(<Stage />);
      toggleEditing();
      fireEvent.keyDown(document.body, { key: "Z", metaKey: true, shiftKey: true });
      fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
      fromFrame(stageFrame(container), { type: "slop:key", key: "z", mod: true, shift: true });
      expect(redo).toHaveBeenCalledTimes(3);
      expect(undo).not.toHaveBeenCalled();
    });

    it("keeps the slide at its size on a pasteboard filling the area, in view and edit mode, and sends the panel colors", () => {
      const { container } = render(<Stage />);
      const slideBox = () => container.querySelector<HTMLElement>("[data-sketch-target]")!;
      expect(slideBox().style.width).toBe("960px");
      expect(slideBox().className).not.toContain("overflow-hidden");
      const viewer = stageFrame(container);
      expect(viewer.getAttribute("src")).toContain("&pan");
      expect(viewer.getAttribute("src")).not.toContain("edit=");
      // The 960x540 area plus its 32px padding, at the slide's 0.5 scale.
      expect(viewer.style.width).toBe("2048px");
      expect(viewer.style.height).toBe("1208px");
      expect(viewer.style.left).toBe("-32px");
      expect(viewer.style.top).toBe("-32px");
      const viewPost = vi.spyOn(viewer.contentWindow!, "postMessage");
      fireEvent.load(viewer);
      const colors = {
        type: "slop:canvas",
        color: expect.any(String),
        accent: expect.any(String),
        border: expect.any(String),
      };
      expect(viewPost).toHaveBeenCalledWith(colors, "*");
      toggleEditing();
      expect(slideBox().style.width).toBe("960px");
      const frame = [...container.querySelectorAll("iframe")].at(-1)!;
      expect(frame.getAttribute("src")).toContain("edit=");
      expect(frame.style.width).toBe("2048px");
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      fireEvent.load(frame);
      expect(post).toHaveBeenCalledWith(colors, "*");
      toggleEditing();
      expect(slideBox().style.width).toBe("960px");
    });

    it("fits a slide of another size into the area in its own shape", () => {
      const deck = deckFor(DECK_HTML);
      useApp.setState({
        deck: { ...deck, size: { width: 1080, height: 1350, unit: "px", pixelWidth: 1080, pixelHeight: 1350 } },
      });
      const { container } = render(<Stage />);
      const slideBox = container.querySelector<HTMLElement>("[data-sketch-target]")!;
      // The 960x540 area fits a 4:5 slide 432 px wide (540 px tall).
      expect(slideBox.style.width).toBe("432px");
      const viewer = stageFrame(container);
      expect(viewer.parentElement!.style.aspectRatio).toBe("1080 / 1350");
    });

    describe("pasteboard view", () => {
      const resetButton = () => screen.queryByRole("button", { name: /^\d+%$/ });
      const enterEditing = () => {
        const utils = render(<Stage />);
        toggleEditing();
        const frames = utils.container.querySelectorAll("iframe");
        const frame = frames[frames.length - 1]!;
        return { ...utils, frame };
      };

      it("offers to go back to the slide once the view is panned or zoomed", () => {
        const { frame } = enterEditing();
        fireEvent.load(frame);
        expect(resetButton()).toBeNull();
        fromFrame(frame, { type: "slop:view", slide: "intro", x: 0, y: 0, k: 1 });
        expect(resetButton()).toBeNull();
        fromFrame(frame, { type: "slop:view", slide: "intro", x: -400, y: 120, k: 0.5 });
        const reset = resetButton()!;
        expect(reset.textContent).toBe("50%");
        const post = vi.spyOn(frame.contentWindow!, "postMessage");
        fireEvent.click(reset);
        expect(post).toHaveBeenCalledWith({ type: "slop:camera", home: true }, "*");
        fromFrame(frame, { type: "slop:view", slide: "intro", x: 0, y: 0, k: 1 });
        expect(resetButton()).toBeNull();
      });

      it("ignores views from other slides or windows", () => {
        const { frame } = enterEditing();
        fromFrame(frame, { type: "slop:view", slide: "other", x: 5, y: 5, k: 2 });
        fromFrame(null, { type: "slop:view", slide: "intro", x: 5, y: 5, k: 2 });
        fromFrame(frame, { type: "slop:view", slide: "intro", x: "a", y: 5, k: 2 });
        expect(resetButton()).toBeNull();
        fromFrame(frame, { type: "slop:view", slide: "intro", x: 5, y: 5, k: 2 });
        expect(resetButton()).not.toBeNull();
      });

      it("pans and zooms in view mode too, and keeps the view entering and leaving edit mode", () => {
        const { container } = render(<Stage />);
        const viewer = stageFrame(container);
        fireEvent.load(viewer);
        fromFrame(viewer, { type: "slop:view", slide: "intro", x: 40, y: -20, k: 2 });
        expect(resetButton()!.textContent).toBe("200%");
        const viewPost = vi.spyOn(viewer.contentWindow!, "postMessage");
        fireEvent.click(resetButton()!);
        expect(viewPost).toHaveBeenCalledWith({ type: "slop:camera", home: true }, "*");
        toggleEditing();
        expect(resetButton()!.textContent).toBe("200%");
        const editor = [...container.querySelectorAll("iframe")].at(-1)!;
        const post = vi.spyOn(editor.contentWindow!, "postMessage");
        fireEvent.load(editor);
        expect(post).toHaveBeenCalledWith({ type: "slop:camera", x: 40, y: -20, k: 2 }, "*");
        toggleEditing();
        expect(resetButton()!.textContent).toBe("200%");
      });

      it("starts each slide centered at full size", () => {
        const { container } = render(<Stage />);
        fromFrame(stageFrame(container), { type: "slop:view", slide: "intro", x: 40, y: -20, k: 2 });
        expect(resetButton()).not.toBeNull();
        act(() => useApp.getState().select("outro"));
        expect(resetButton()).toBeNull();
        const post = vi.spyOn(stageFrame(container).contentWindow!, "postMessage");
        fireEvent.load(stageFrame(container));
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:camera" }), "*");
        act(() => useApp.getState().select("intro"));
        expect(resetButton()).toBeNull();
      });

      it("moves the ink with the slide as the view pans and zooms", () => {
        const { container } = render(<Stage />);
        const ink = () => {
          const { left, top, width, height, transform } = screen.getByTestId("annotation-view").style;
          return { left, top, width, height, transform };
        };
        expect(ink()).toEqual({ left: "0px", top: "0px", width: "100%", height: "100%", transform: "" });
        // Slide pixels on a 960px wide slide: half a CSS px each. The ink is laid out at the
        // zoomed size rather than CSS-scaled, so it stays sharp.
        fromFrame(stageFrame(container), { type: "slop:view", slide: "intro", x: 40, y: -20, k: 2 });
        expect(ink()).toEqual({ left: "20px", top: "-10px", width: "200%", height: "200%", transform: "" });
        expect(screen.getByTestId("annotation-view").contains(screen.getByTestId("annotation-layer"))).toBe(true);
      });

      it("keeps zoomed ink inside the stage area, off the bar below", () => {
        const { container } = render(<Stage />);
        fromFrame(stageFrame(container), { type: "slop:view", slide: "intro", x: 0, y: 0, k: 8 });
        const area = screen.getByTestId("stage-area");
        expect(area.classList).toContain("overflow-hidden");
        expect(area.contains(screen.getByTestId("annotation-view"))).toBe(true);
        expect(area.contains(screen.getByRole("button", { name: /Tidy layout/ }))).toBe(false);
      });

      it("puts the view back when the slide reloads after an edit, but not for a slide that was never moved", () => {
        const { container, frame } = enterEditing();
        const post = vi.spyOn(frame.contentWindow!, "postMessage");
        fireEvent.load(frame);
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:camera" }), "*");
        fromFrame(frame, { type: "slop:view", slide: "intro", x: -400, y: 120, k: 0.5 });
        fireEvent.load(container.querySelectorAll("iframe")[container.querySelectorAll("iframe").length - 1]!);
        expect(post).toHaveBeenCalledWith({ type: "slop:camera", x: -400, y: 120, k: 0.5 }, "*");
      });

      it("brings the slide back to the middle before a tidy screenshot", () => {
        const { frame } = enterEditing();
        const post = vi.spyOn(frame.contentWindow!, "postMessage");
        fireEvent.load(frame);
        post.mockClear();
        fireEvent.click(screen.getByRole("button", { name: /Tidy layout/ }));
        expect(post).toHaveBeenCalledWith({ type: "slop:camera", home: true }, "*");
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-select", path: null, quiet: true }, "*");
      });
    });

    describe("context menu", () => {
      const ELEMENT = { path: "#intro > h1:nth-child(1)", markup: "<h1>Hi</h1>", name: '<h1> "Hi"', added: true };
      const item = (name: string) =>
        screen.getByRole("menuitem", { name: new RegExp(`^${name}`) }) as HTMLButtonElement;

      function open(element: typeof ELEMENT | null = ELEMENT) {
        const { container } = render(<Stage />);
        toggleEditing();
        const frame = stageFrame(container);
        fireEvent.load(frame);
        const post = vi.spyOn(frame.contentWindow!, "postMessage");
        post.mockClear();
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 100, y: 50, element });
        return { frame, post };
      }

      it("opens where the preview says, in the app's pixels", () => {
        const { container } = render(<Stage />);
        toggleEditing();
        const frame = stageFrame(container);
        fireEvent.load(frame);
        Object.defineProperty(frame, "clientWidth", { value: 1920, configurable: true });
        frame.getBoundingClientRect = () => new DOMRect(40, 20, 960, 540);
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 100, y: 50, element: ELEMENT });
        const menu = screen.getByRole("menu");
        expect(menu.style.left).toBe("90px");
        expect(menu.style.top).toBe("45px");
      });

      it("ignores a menu for another slide, and shows nothing out of edit mode", () => {
        const { frame } = open();
        fireEvent.click(item("Copy"));
        fromFrame(frame, { type: "slop:edit-menu", slide: "outro", x: 1, y: 1, element: ELEMENT });
        expect(screen.queryByRole("menu")).toBeNull();
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 1, y: 1, element: ELEMENT });
        expect(screen.getByRole("menu")).toBeTruthy();
        toggleEditing();
        expect(screen.queryByRole("menu")).toBeNull();
      });

      it.each([
        ["Cut", { type: "slop:edit-copy", cut: true }],
        ["Copy", { type: "slop:edit-copy", cut: false }],
        ["Duplicate", { type: "slop:edit-duplicate" }],
        ["Delete", { type: "slop:edit-delete" }],
        ["Bring to front", { type: "slop:edit-order", to: "front" }],
        ["Bring forward", { type: "slop:edit-order", to: "forward" }],
        ["Send backward", { type: "slop:edit-order", to: "backward" }],
        ["Send to back", { type: "slop:edit-order", to: "back" }],
      ])("%s tells the editor and closes", (name, message) => {
        const { post } = open();
        fireEvent.click(item(name));
        expect(post).toHaveBeenCalledWith(message, "*");
        expect(screen.queryByRole("menu")).toBeNull();
      });

      it("pastes from the clipboard", async () => {
        vi.mocked(invoke).mockResolvedValue({ kind: "element", html: "<p>Pasted</p>" });
        const { post } = open();
        fireEvent.click(item("Paste"));
        await waitFor(() => expect(post).toHaveBeenCalledWith({ type: "slop:edit-paste", html: "<p>Pasted</p>" }, "*"));
      });

      it("offers only pasting on an empty spot", () => {
        open(null);
        expect(item("Paste").disabled).toBe(false);
        for (const name of ["Cut", "Copy", "Duplicate", "Delete", "Send to back", "Ask the agent", "Tidy this"]) {
          expect(item(name).disabled).toBe(true);
        }
      });

      it("hands the element to the agent with the view reset, the menu gone first", () => {
        const ask = vi.fn().mockResolvedValue(undefined);
        const { askAboutElement } = useApp.getState();
        useApp.setState({ askAboutElement: ask });
        const frames: FrameRequestCallback[] = [];
        const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
          frames.push(cb);
          return 0;
        });
        const { post } = open();
        fireEvent.click(item("Ask the agent"));
        expect(screen.queryByRole("menu")).toBeNull();
        expect(post).toHaveBeenCalledWith({ type: "slop:camera", home: true }, "*");
        // The selection stays: it shows the agent which element this is about.
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-select" }), "*");
        expect(ask).not.toHaveBeenCalled();
        while (frames.length) frames.shift()!(0);
        expect(ask).toHaveBeenCalledWith(ELEMENT);
        raf.mockRestore();
        useApp.setState({ askAboutElement });
      });

      it("tidies only what was added by hand, and not while the agent runs", () => {
        const tidy = vi.fn().mockResolvedValue(undefined);
        const { tidyElement } = useApp.getState();
        useApp.setState({ tidyElement: tidy });
        const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
          cb(0);
          return 0;
        });
        const { frame } = open({ ...ELEMENT, added: false });
        expect(item("Tidy this").disabled).toBe(true);
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 1, y: 1, element: ELEMENT });
        act(() => useApp.setState({ running: true }));
        expect(item("Tidy this").disabled).toBe(true);
        expect(item("Ask the agent").disabled).toBe(true);
        act(() => useApp.setState({ running: false }));
        fireEvent.click(item("Tidy this"));
        expect(tidy).toHaveBeenCalledWith(ELEMENT);
        raf.mockRestore();
        useApp.setState({ tidyElement });
      });

      it("closes on Escape or a press beside it, giving focus back to the slide", () => {
        const { frame } = open();
        const focus = vi.spyOn(frame, "focus");
        expect(document.activeElement).toBe(screen.getByRole("menu"));
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
        expect(screen.queryByRole("menu")).toBeNull();
        expect(focus).toHaveBeenCalled();
        expect(useApp.getState().editing).toBe(true);
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 1, y: 1, element: ELEMENT });
        fireEvent.pointerDown(screen.getByTestId("edit-menu-cover"));
        expect(screen.queryByRole("menu")).toBeNull();
      });

      it("moves through the items with the arrow keys, without reaching the slide's keys", () => {
        open();
        const menu = screen.getByRole("menu");
        fireEvent.keyDown(menu, { key: "ArrowDown" });
        expect(document.activeElement).toBe(item("Cut"));
        fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
        expect(document.activeElement).toBe(item("Tidy this"));
        expect(useApp.getState().selected).toBe("intro");
        fireEvent.keyDown(document.activeElement!, { key: "t" });
        expect(useApp.getState().editTool).toBe("select");
      });
    });

    it("shows the keyboard shortcuts only in edit mode", () => {
      render(<Stage />);
      fireEvent.keyDown(document.body, { key: "?" });
      expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
      toggleEditing();
      fireEvent.keyDown(document.body, { key: "?" });
      expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
      toggleEditing();
      expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    });

    it("always offers to tidy the slide, and is busy while the agent runs", () => {
      const tidy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
        cb(0);
        return 0;
      });
      useApp.setState({ tidyLayout: tidy });
      render(<Stage />);
      fireEvent.click(screen.getByRole("button", { name: /Tidy layout/ }));
      expect(tidy).toHaveBeenCalledTimes(1);
      expect(tidy).toHaveBeenCalledWith([]);
      act(() => useApp.setState({ running: true }));
      expect((screen.getByRole("button", { name: /Tidy layout/ }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("warns about overflow found in the editor and hands it to the agent", () => {
      const tidy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
        cb(0);
        return 0;
      });
      useApp.setState({ tidyLayout: tidy });
      const { container } = render(<Stage />);
      expect(screen.queryByText("Overflow")).toBeNull();
      toggleEditing();
      const items = ['<h1> "Hello" runs past the bottom edge by 40px'];
      fromFrame(stageFrame(container), { type: "slop:edit-overflow", slide: "intro", items });
      expect(screen.getByText("Overflow").getAttribute("title")).toContain(items[0]);
      fireEvent.click(screen.getByRole("button", { name: /Tidy layout/ }));
      expect(tidy).toHaveBeenCalledWith(items);
      fromFrame(stageFrame(container), { type: "slop:edit-overflow", slide: "intro", items: [] });
      expect(screen.queryByText("Overflow")).toBeNull();
    });

    it("ignores overflow reports for another slide or from other windows, and drops them leaving edit mode", () => {
      const { container } = render(<Stage />);
      toggleEditing();
      fromFrame(stageFrame(container), { type: "slop:edit-overflow", slide: "other", items: ["x"] });
      fromFrame(null, { type: "slop:edit-overflow", slide: "intro", items: ["x"] });
      expect(screen.queryByText("Overflow")).toBeNull();
      fromFrame(stageFrame(container), { type: "slop:edit-overflow", slide: "intro", items: ["x"] });
      expect(screen.getByText("Overflow")).toBeTruthy();
      toggleEditing();
      expect(screen.queryByText("Overflow")).toBeNull();
    });
  });
});
