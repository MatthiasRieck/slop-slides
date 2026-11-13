import { open } from "@tauri-apps/plugin-dialog";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom loads no images; dropped ones measure as 1200×800.
vi.mock("../lib/drop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/drop")>()),
  imageSize: vi.fn(async () => ({ w: 1200, h: 800 })),
}));

import { invoke } from "@tauri-apps/api/core";
import { claimDrop, dropCovered } from "../lib/drop";
import { DEFAULT_EDIT_STYLES } from "../lib/editTools";
import { setSlideClock } from "../lib/slideClock";
import { flushReviewSave, SKETCH_TARGET_ATTR, useApp } from "../store";
import { lastError } from "../store/errors";
import { useSvgEditor } from "../svgStore";
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
    finalState: false,
    editing: false,
    slideMode: "view",
  });
});

/** Lays the stage out at 960 × 540, so the slide preview loads; gives back what undoes it. */
function layOutStage() {
  const before = globalThis.ResizeObserver;
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
  return () => {
    globalThis.ResizeObserver = before;
  };
}

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

  it("names the arrows with their keys", () => {
    render(<Stage />);
    expect(prev().title).toBe("Previous slide (←)");
    expect(next().title).toBe("Next slide (→)");
  });

  it("goes to a slide by its number: the position is a field once pressed", () => {
    render(<Stage />);
    const counter = () => screen.getByRole("button", { name: /^Slide \d+ of 3\. Go to a slide/ });
    const field = () => screen.getByLabelText("Go to slide number") as HTMLInputElement;
    fireEvent.click(counter());
    expect(field().value).toBe("1");
    expect(document.activeElement).toBe(field());
    fireEvent.change(field(), { target: { value: "3" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(useApp.getState().selected).toBe("outro");
    expect(position()).toBe("3 / 3");
    // Escape and leaving the field keep the slide shown; so does what is no number.
    fireEvent.click(counter());
    fireEvent.change(field(), { target: { value: "1" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(useApp.getState().selected).toBe("outro");
    fireEvent.click(counter());
    fireEvent.change(field(), { target: { value: "2" } });
    fireEvent.blur(field());
    expect(useApp.getState().selected).toBe("outro");
    fireEvent.click(counter());
    fireEvent.change(field(), { target: { value: "two" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(useApp.getState().selected).toBe("outro");
    // Past the end is the end.
    fireEvent.click(counter());
    fireEvent.change(field(), { target: { value: "0" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(useApp.getState().selected).toBe("intro");
    fireEvent.click(counter());
    fireEvent.change(field(), { target: { value: "99" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(useApp.getState().selected).toBe("outro");
  });

  it("says that the slide shown is hidden, and shows it again from there in Edit", async () => {
    const hidden = deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-hidden`));
    useApp.setState({ deck: hidden, editing: false });
    vi.mocked(invoke).mockResolvedValue({ deck: deckFor(DECK_HTML), previous: "", source: "", created: [] });
    render(<Stage />);
    const chip = () => screen.getByRole("button", { name: "Hidden" }) as HTMLButtonElement;
    expect(chip().disabled).toBe(true);
    expect(chip().title).toContain("Switch to Edit to change the slides");
    act(() => useApp.getState().setMode("edit"));
    expect(chip().disabled).toBe(false);
    await act(async () => fireEvent.click(chip()));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_slides_hidden", { id: hidden.id, slides: ["intro"], hidden: false }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Hidden" })).toBeNull());
    act(() => useApp.getState().setMode("view"));
  });

  it("unlocks the slide shown from its Locked chip, in View too", async () => {
    const locked = deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`));
    useApp.setState({ deck: locked, editing: false });
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "set_slides_locked" ? deckFor(DECK_HTML) : undefined,
    );
    render(<Stage />);
    const chip = screen.getByRole("button", { name: "Locked" });
    expect(chip.title).toContain("Click to unlock it");
    await act(async () => fireEvent.click(chip));
    expect(invoke).toHaveBeenCalledWith("set_slides_locked", { id: locked.id, slides: ["intro"], locked: false });
    expect(screen.queryByRole("button", { name: "Locked" })).toBeNull();
  });

  describe("the search, in View and in Edit", () => {
    const field = () => screen.queryByLabelText("Search slides") as HTMLInputElement | null;
    afterEach(() => act(() => useApp.getState().setMode("view")));

    it("comes up with ⌘F or the button under the slide in both, and keeps its query between them", () => {
      render(<Stage />);
      fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
      expect(document.activeElement).toBe(field());
      fireEvent.change(field()!, { target: { value: "hello" } });
      // Edit has no ribbon section for it: a bar over the stage, there because of the query.
      act(() => useApp.getState().setMode("edit"));
      expect(field()!.closest("[data-testid=stage-area]")).not.toBeNull();
      expect(field()!.value).toBe("hello");
      fireEvent.keyDown(field()!, { key: "Escape" });
      expect(field()).toBeNull();
      expect(useApp.getState().search.query).toBe("");
      fireEvent.click(screen.getByRole("button", { name: "Find in the slides" }));
      expect(document.activeElement).toBe(field());
      fireEvent.change(field()!, { target: { value: "bye" } });
      act(() => useApp.getState().setMode("view"));
      expect(field()!.value).toBe("bye");
      expect(field()!.closest("[role=toolbar]")).not.toBeNull();
    });

    it("replaces only in Edit", () => {
      render(<Stage />);
      const replace = () => screen.getByRole("button", { name: "Replace…" }) as HTMLButtonElement;
      expect(replace().disabled).toBe(true);
      expect(replace().title).toBe("Switch to Edit to change the slides");
      act(() => useApp.getState().openFind());
      act(() => useApp.getState().setMode("edit"));
      expect(replace().disabled).toBe(false);
    });

    it("ends when the stage goes away, for the deck's settings say", () => {
      const { unmount } = render(<Stage />);
      act(() => useApp.getState().setSearch({ query: "hello" }));
      unmount();
      expect(useApp.getState().search).toMatchObject({ query: "", matches: null, open: false });
    });
  });

  it("plays the slide's animations again by loading it again, in View", () => {
    const undoLayout = layOutStage();
    useApp.setState({ finalState: false });
    const { container } = render(<Stage />);
    const sources = () => [...container.querySelectorAll("iframe")].map((frame) => frame.getAttribute("src"));
    const before = sources();
    expect(before).toHaveLength(1);
    act(() => useApp.getState().replaySlide());
    expect(sources().some((src) => !before.includes(src))).toBe(true);
    // The editor shows a still of the slide: there is nothing to play again.
    act(() => useApp.getState().setMode("edit"));
    const editing = sources();
    act(() => useApp.getState().replaySlide());
    expect(sources()).toEqual(editing);
    act(() => useApp.getState().setMode("view"));
    undoLayout();
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

  it("shows the deck's lint status beside Tidy layout, in the row under the slide", () => {
    useApp.setState({ lint: [] });
    render(<Stage />);
    const lint = screen.getByRole("button", { name: "Lint OK" });
    const tidy = screen.getByRole("button", { name: /Tidy layout/ });
    expect(tidy.nextElementSibling).toBe(lint);
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
      useApp.setState({ editing: false, toasts: [] });
    });

    it("copies the selected slide with ⌘C in View, where ⌘V pastes nothing", async () => {
      const deck = useApp.getState().deck!;
      render(<Stage />);
      const key = (k: string) =>
        new KeyboardEvent("keydown", { key: k, metaKey: true, cancelable: true, bubbles: true });
      const [copy, paste] = [key("c"), key("v")];
      act(() => void document.body.dispatchEvent(copy));
      expect(copy.defaultPrevented).toBe(true);
      expect(invoke).toHaveBeenCalledWith("copy_slides", { id: deck.id, slides: ["intro"] });
      await act(async () => void document.body.dispatchEvent(paste));
      expect(paste.defaultPrevented).toBe(false);
      expect(invoke).not.toHaveBeenCalledWith("paste_slides", expect.anything());
      expect(useApp.getState().deck).toBe(deck);
    });

    it("pastes a slide after the selected one with ⌘V in Edit, also on a locked slide", async () => {
      useApp.setState({ deck: deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`)), editing: true });
      const deck = useApp.getState().deck!;
      const pasted = {
        ...deck,
        slides: [deck.slides[0]!, { ...deck.slides[0]!, id: "pasted" }, ...deck.slides.slice(1)],
      };
      vi.mocked(invoke).mockImplementation(async (command) =>
        command === "paste_slides"
          ? { deck: pasted, previous: "<old>", source: "<new>", created: ["pasted"] }
          : undefined,
      );
      render(<Stage />);
      const copy = new KeyboardEvent("keydown", { key: "c", metaKey: true, cancelable: true, bubbles: true });
      act(() => void document.body.dispatchEvent(copy));
      expect(copy.defaultPrevented).toBe(true);
      expect(invoke).toHaveBeenCalledWith("copy_slides", { id: deck.id, slides: ["intro"] });
      await act(async () => void fireEvent.keyDown(document.body, { key: "v", ctrlKey: true }));
      expect(invoke).toHaveBeenCalledWith("paste_slides", { id: deck.id, after: "intro" });
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
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("copy_slides", expect.anything()));
      // Pasting changes the deck: only in Edit, where on a locked slide the keys are not the editor's.
      expect(invoke).not.toHaveBeenCalledWith("paste_slides", expect.anything());
      act(() =>
        useApp.setState({ deck: deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`)), editing: true }),
      );
      send("v");
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("paste_slides", expect.anything()));
      frame.remove();
    });

    it("leaves a clipboard without a slide alone and reports failures", async () => {
      vi.mocked(invoke).mockResolvedValue(null);
      useApp.setState({ deck: deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`)), editing: true });
      render(<Stage />);
      const before = useApp.getState().deck;
      await act(async () => void fireEvent.keyDown(document.body, { key: "v", metaKey: true }));
      expect(invoke).toHaveBeenCalledWith("paste_slides", expect.anything());
      expect(useApp.getState().deck).toBe(before);
      expect(useApp.getState().selected).toBe("intro");
      vi.mocked(invoke).mockRejectedValue("could not copy");
      await act(async () => void fireEvent.keyDown(document.body, { key: "c", metaKey: true }));
      await waitFor(() => expect(lastError(useApp.getState())).toBe("could not copy"));
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
      expect(invoke).not.toHaveBeenCalledWith("copy_slides", expect.anything());
      expect(invoke).not.toHaveBeenCalledWith("paste_slides", expect.anything());
    });
  });

  describe("slide rail keys", () => {
    const actions = {
      undo: vi.fn(async () => {}),
      redo: vi.fn(async () => {}),
      moveSlides: vi.fn(async () => {}),
      deleteSlides: vi.fn(async () => {}),
    };
    const real = useApp.getState();
    beforeEach(() => {
      for (const action of Object.values(actions)) action.mockClear();
      useApp.setState({ ...actions, railSelected: [] });
    });
    afterEach(() => {
      const { undo, redo, moveSlides, deleteSlides } = real;
      useApp.setState({ undo, redo, moveSlides, deleteSlides, railSelected: [] });
    });

    it("undoes and redoes the deck's changes outside edit mode", () => {
      render(<Stage />);
      fireEvent.keyDown(document.body, { key: "z", metaKey: true });
      expect(actions.undo).toHaveBeenCalledOnce();
      fireEvent.keyDown(document.body, { key: "Z", metaKey: true, shiftKey: true });
      fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
      expect(actions.redo).toHaveBeenCalledTimes(2);
    });

    it("leaves ⌘Z to text fields, and undoes once in edit mode", () => {
      render(
        <>
          <Stage />
          <textarea data-testid="composer" />
        </>,
      );
      fireEvent.keyDown(screen.getByTestId("composer"), { key: "z", metaKey: true });
      expect(actions.undo).not.toHaveBeenCalled();
      act(() => useApp.getState().setEditing(true));
      fireEvent.keyDown(document.body, { key: "z", metaKey: true });
      expect(actions.undo).toHaveBeenCalledOnce();
      act(() => useApp.getState().setEditing(false));
    });

    /** A rail to press in, so the keys after it are meant for the slides. */
    const pressRail = () => {
      const rail = document.createElement("div");
      rail.setAttribute("data-slide-rail", "");
      document.body.appendChild(rail);
      fireEvent.pointerDown(rail);
      return rail;
    };

    it("moves slides with ⌘↑ and ⌘↓ in Edit, with the slide rail pressed last, instead of selecting another", () => {
      render(<Stage />);
      act(() => useApp.getState().setEditing(true));
      // On the slide the keys are the editor's, and the arrows go on to the next slide.
      fireEvent.keyDown(document.body, { key: "ArrowDown", metaKey: true });
      expect(actions.moveSlides).not.toHaveBeenCalled();
      act(() => useApp.getState().select("intro"));
      const rail = pressRail();
      fireEvent.keyDown(document.body, { key: "ArrowDown", metaKey: true });
      expect(actions.moveSlides).toHaveBeenLastCalledWith(1);
      fireEvent.keyDown(document.body, { key: "ArrowUp", metaKey: true });
      expect(actions.moveSlides).toHaveBeenLastCalledWith(-1);
      expect(useApp.getState().selected).toBe("intro");
      rail.remove();
      act(() => useApp.getState().setEditing(false));
    });

    it("changes nothing in View: ⌘↑ / ⌘↓ and Delete leave the slides alone, wherever they are pressed", () => {
      render(<Stage />);
      const rail = pressRail();
      useApp.setState({ railSelected: ["intro", "outro"] });
      fireEvent.keyDown(document.body, { key: "ArrowDown", metaKey: true });
      fireEvent.keyDown(document.body, { key: "Delete" });
      fireEvent.keyDown(document.body, { key: "Backspace" });
      expect(actions.moveSlides).not.toHaveBeenCalled();
      expect(actions.deleteSlides).not.toHaveBeenCalled();
      // Escape still clears the pick, which changes nothing in the deck.
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(useApp.getState().railSelected).toEqual([]);
      rail.remove();
    });

    it("has the rail's own keys for the picked slides: ⌘A, ⌘D, ⌘X, and Home and End anywhere", () => {
      const more = {
        selectAllSlides: vi.fn(),
        duplicateSlides: vi.fn(async () => {}),
        cutSlides: vi.fn(async () => {}),
        addSlide: vi.fn(async () => {}),
      };
      const before = useApp.getState();
      useApp.setState({ ...more, deck: deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`)) });
      render(<Stage />);
      act(() => useApp.getState().setEditing(true));
      const mod = (key: string, more: KeyboardEventInit = {}) =>
        fireEvent.keyDown(document.body, { key, ctrlKey: true, ...more });
      // Off the rail they are not the slides'.
      for (const key of ["a", "d", "x"]) mod(key);
      expect(more.selectAllSlides).not.toHaveBeenCalled();
      expect(more.duplicateSlides).not.toHaveBeenCalled();
      expect(more.cutSlides).not.toHaveBeenCalled();
      const rail = pressRail();
      for (const key of ["a", "d", "x"]) expect(mod(key)).toBe(false);
      expect(more.selectAllSlides).toHaveBeenCalledOnce();
      expect(more.duplicateSlides).toHaveBeenCalledExactlyOnceWith(["intro"]);
      expect(more.cutSlides).toHaveBeenCalledOnce();
      // A new slide, and the ends of the deck, wherever they are pressed.
      fireEvent.pointerDown(document.body);
      mod("N", { shiftKey: true });
      expect(more.addSlide).toHaveBeenCalledOnce();
      fireEvent.keyDown(document.body, { key: "End" });
      expect(useApp.getState().selected).toBe("outro");
      fireEvent.keyDown(document.body, { key: "Home" });
      expect(useApp.getState().selected).toBe("intro");

      // In View only what changes nothing is left: picking them all.
      act(() => useApp.getState().setEditing(false));
      for (const fn of Object.values(more)) fn.mockClear();
      fireEvent.pointerDown(rail);
      for (const key of ["a", "d", "x"]) mod(key);
      mod("n", { shiftKey: true });
      expect(more.selectAllSlides).toHaveBeenCalledOnce();
      expect(more.duplicateSlides).not.toHaveBeenCalled();
      expect(more.cutSlides).not.toHaveBeenCalled();
      expect(more.addSlide).not.toHaveBeenCalled();
      rail.remove();
      const { selectAllSlides, duplicateSlides, cutSlides, addSlide } = before;
      useApp.setState({ selectAllSlides, duplicateSlides, cutSlides, addSlide });
    });

    it("steps through the slides a search found with the arrows, as the rail lists only those", () => {
      render(<Stage />);
      act(() => {
        useApp.getState().setSearch({ query: "x" });
        useApp
          .getState()
          .setSearchMatches([
            { slide: "outro", index: 2, locked: false, notes: false, before: "", text: "x", after: "" },
          ]);
      });
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect(useApp.getState().selected).toBe("outro");
      fireEvent.keyDown(document.body, { key: "ArrowLeft" });
      expect(useApp.getState().selected).toBe("outro");
      act(() => useApp.getState().clearSearch());
      fireEvent.keyDown(document.body, { key: "ArrowLeft" });
      expect(useApp.getState().selected).toBe("#2");
      act(() => useApp.getState().select("intro"));
    });

    it("leaves a key alone that something took already, like a row being moved with the keyboard", () => {
      render(<Stage />);
      const taken = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
      taken.preventDefault();
      act(() => void document.body.dispatchEvent(taken));
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
      // In View the deck's history is there, but not what moves its slides.
      forward({ key: "ArrowDown", mod: true });
      expect(actions.moveSlides).not.toHaveBeenCalled();
      forward({ key: "z", mod: true });
      expect(actions.undo).toHaveBeenCalledOnce();
      // In Edit on a locked slide, where no editor takes the keys, the moves are too.
      act(() =>
        useApp.setState({
          deck: deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`)),
          selected: "intro",
          editing: true,
        }),
      );
      forward({ key: "ArrowDown", mod: true });
      expect(actions.moveSlides).toHaveBeenLastCalledWith(1);
      act(() => useApp.setState({ editing: false }));
      frame.remove();
    });

    it("Delete takes the one selected slide only when the rail was pressed last, several picked ones anyway", () => {
      useApp.setState({ deck: deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`)) });
      render(<Stage />);
      act(() => useApp.getState().setEditing(true));
      // Off the rail, Delete with nothing picked is not about the slide shown.
      fireEvent.keyDown(document.body, { key: "Delete" });
      fireEvent.keyDown(document.body, { key: "Backspace" });
      expect(actions.deleteSlides).not.toHaveBeenCalled();
      const rail = pressRail();
      fireEvent.keyDown(document.body, { key: "Delete" });
      expect(actions.deleteSlides).toHaveBeenLastCalledWith(["intro"]);
      fireEvent.keyDown(document.body, { key: "Backspace" });
      expect(actions.deleteSlides).toHaveBeenCalledTimes(2);
      actions.deleteSlides.mockClear();
      fireEvent.pointerDown(document.body);
      useApp.setState({ railSelected: ["intro", "outro"] });
      fireEvent.keyDown(document.body, { key: "Backspace" });
      expect(actions.deleteSlides).toHaveBeenCalledWith(["intro", "outro"]);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(useApp.getState().railSelected).toEqual([]);
      rail.remove();
      act(() => useApp.getState().setEditing(false));
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

    it("offers colors, which pick up the pen when no ink tool is in hand", () => {
      render(<Stage />);
      // With neither in hand the swatches show the pen's color.
      expect(pressed("Color #ef4444")).toBe(true);
      fireEvent.click(tool("Comment on an element"));
      fireEvent.click(tool("Color #3b82f6"));
      expect([pressed("Draw on the slide"), pressed("Comment on an element")]).toEqual([true, false]);
      expect(pressed("Color #3b82f6")).toBe(true);
      draw([[10, 10]]);
      expect(useApp.getState().sketches.intro?.[0]?.color).toBe("#3b82f6");
      // The highlighter keeps a color of its own.
      fireEvent.click(tool("Highlight on the slide"));
      expect(pressed("Color #facc15")).toBe(true);
    });

    it("undoes and clears marks", () => {
      render(<Stage />);
      const off = (name: string) => (tool(name) as HTMLButtonElement).disabled;
      expect([off("Remove last mark"), off("Clear marks on this slide")]).toEqual([true, true]);
      fireEvent.click(tool("Draw on the slide"));
      draw([[10, 10]]);
      draw([[20, 20]]);
      fireEvent.click(tool("Remove last mark"));
      expect(useApp.getState().sketches.intro).toHaveLength(1);
      fireEvent.click(tool("Clear marks on this slide"));
      expect(useApp.getState().sketches.intro).toEqual([]);
      expect([off("Remove last mark"), off("Clear marks on this slide")]).toEqual([true, true]);
    });

    it("has the review toggle with the comment tools", () => {
      const mark = { tool: "pen" as const, color: "#ef4444", points: [[0.5, 0.5]] as [number, number][] };
      act(() => useApp.setState({ sketches: { intro: [mark] } }));
      render(<Stage />);
      const review = within(screen.getByRole("group", { name: "Review" }));
      const toggle = review.getByRole("button", { name: "Show review marks and comments on the slides" });
      expect(toggle.textContent).toBe("Review marks");
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
      expect(review.getByRole("button", { name: "Comments (0)" })).toBeTruthy();
      expect(review.getByRole("button", { name: "Comment on an element" })).toBeTruthy();
    });

    it("shows and hides the review marks", () => {
      const mark = { tool: "pen" as const, color: "#ef4444", points: [[0.5, 0.5]] as [number, number][] };
      render(<Stage />);
      expect((tool("Show review marks and comments on the slides") as HTMLButtonElement).disabled).toBe(true);
      // Marks on any slide offer the toggle, even when the current slide has none.
      act(() => useApp.setState({ sketches: { "#2": [mark] } }));
      expect((tool("Show review marks and comments on the slides") as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(tool("Draw on the slide"));
      draw([[10, 10]]);
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(1);
      fireEvent.click(tool("Show review marks and comments on the slides"));
      expect(useApp.getState().reviewVisible).toBe(false);
      expect(pressed("Draw on the slide")).toBe(false);
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(0);
      expect((tool("Remove last mark") as HTMLButtonElement).disabled).toBe(true);
      expect(useApp.getState().sketches.intro).toHaveLength(1);
      // The toggle keeps its name; whether it is pressed says if the marks show.
      expect(pressed("Show review marks and comments on the slides")).toBe(false);
      fireEvent.click(tool("Show review marks and comments on the slides"));
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
      let undoLayout: () => void;

      beforeEach(() => {
        undoLayout = layOutStage();
        useApp.setState({ comments: {}, commentsHeld: {}, reviewVisible: true });
      });
      afterEach(() => {
        undoLayout();
        useApp.setState({ comments: {}, reviewVisible: true });
      });

      it("says in the empty comment how it is saved and how a line is added", () => {
        const { container } = render(<Stage />);
        fireEvent.click(tool("Comment on an element"));
        pick(container);
        expect((input() as HTMLTextAreaElement).placeholder).toBe(
          "Add a comment… Enter saves, Shift+Enter adds a line",
        );
      });

      it("opens the comment the list of comments asks for, on its slide", () => {
        useApp.setState({ comments: { outro: [{ ...comment, id: "last", text: "Thank them" }] }, selected: "intro" });
        render(<Stage />);
        expect(screen.queryByRole("textbox", { name: "Comment text" })).toBeNull();
        act(() => useApp.getState().showComment("outro", "last"));
        expect(useApp.getState().selected).toBe("outro");
        expect((input() as HTMLTextAreaElement).value).toBe("Thank them");
        expect(useApp.getState().commentAsked).toBeNull();
        // One that is gone by then opens nothing, and is not asked for again.
        fireEvent.keyDown(input(), { key: "Escape" });
        act(() => useApp.getState().showComment("intro", "gone"));
        expect(screen.queryByRole("textbox", { name: "Comment text" })).toBeNull();
        expect(useApp.getState().commentAsked).toBeNull();
        act(() => useApp.getState().select("intro"));
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

      it("makes a comment about the moment the timeline holds the slide at, and about the slide whenever otherwise", () => {
        const { container } = render(<Stage />);
        const write = (text: string) => {
          fireEvent.click(tool("Comment on an element"));
          pick(container);
          fireEvent.change(input(), { target: { value: text } });
        };
        const times = () => useApp.getState().comments.intro?.map((c) => c.time);
        // Held at a moment: the comment is about it, and says so while it is written.
        act(() => setSlideClock({ slide: "intro", at: 3.2449, paused: true }));
        write("Too fast");
        expect(screen.getByTestId("comment-moment").textContent).toBe("At 3.2 s after the slide shows");
        fireEvent.keyDown(input(), { key: "Enter" });
        expect(times()).toEqual([3.24]);
        // Playing on, held on another slide, or not on the timeline at all: about the slide.
        for (const clock of [{ slide: "intro", at: 1 }, { slide: "outro", at: 1, paused: true }, null]) {
          act(() => setSlideClock(clock));
          write("Bigger");
          expect(screen.queryByTestId("comment-moment")).toBeNull();
          fireEvent.keyDown(input(), { key: "Enter" });
        }
        expect(times()).toEqual([3.24, undefined, undefined, undefined]);
        // Opened again, it still says when, and changing its text keeps the moment.
        fireEvent.click(screen.getAllByTestId("comment-pin")[0]!);
        expect(screen.getByTestId("comment-moment").textContent).toContain("3.2 s");
        fireEvent.change(input(), { target: { value: "Much too fast" } });
        fireEvent.keyDown(input(), { key: "Enter" });
        expect(useApp.getState().comments.intro?.[0]).toMatchObject({ text: "Much too fast", time: 3.24 });
      });

      it("focuses the comment's text once it shows", async () => {
        const { container } = render(<Stage />);
        fireEvent.click(tool("Comment on an element"));
        pick(container);
        expect(document.activeElement).toBe(input());
        // The preview that took the press may take focus too; the field gets it back.
        frameOf(container).focus();
        await waitFor(() => expect(document.activeElement).toBe(input()));
      });

      it("dictates into the comment at the caret, and Enter keeps what is still being said", async () => {
        const { listen } = await import("@tauri-apps/api/event");
        vi.mocked(invoke).mockImplementation(async (cmd: string) => {
          if (cmd === "voice_status") return { modelReady: true, modelBytes: 1, downloading: false, recording: false };
          if (cmd === "stop_recording") return "much bigger";
          return undefined;
        });
        const { container } = render(<Stage />);
        fireEvent.click(tool("Comment on an element"));
        pick(container);
        fireEvent.change(input(), { target: { value: "Make it" } });
        fireEvent.click(screen.getByRole("button", { name: "Dictate the comment" }));
        await screen.findByRole("button", { name: /Stop dictating/ });
        const partial = await waitFor(() => {
          const call = vi.mocked(listen).mock.calls.findLast(([name]) => name === "voice-partial");
          return call![1] as (event: { payload: string }) => void;
        });
        act(() => partial({ payload: "much" }));
        expect((input() as HTMLTextAreaElement).value).toBe("Make it much");
        fireEvent.keyDown(input(), { key: "Enter" });
        await waitFor(() =>
          expect(useApp.getState().comments.intro?.map((c) => c.text)).toEqual(["Make it much bigger"]),
        );
        expect(screen.queryByRole("dialog")).toBeNull();
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

      it("shows what a comment says while its pin is pointed at or focused", () => {
        useApp.setState({ comments: { intro: [comment, { ...comment, id: "second", text: "Bolder", x: 0.9 }] } });
        render(<Stage />);
        const bubbles = () => screen.queryAllByTestId("comment-bubble").map((b) => b.textContent);
        expect(bubbles()).toEqual([]);
        const [first, second] = screen.getAllByTestId("comment-pin") as [HTMLElement, HTMLElement];
        fireEvent.pointerEnter(first);
        expect(bubbles()).toEqual(["Bigger"]);
        fireEvent.pointerEnter(second);
        fireEvent.pointerLeave(first);
        expect(bubbles()).toEqual(["Bolder"]);
        // Near the right edge it opens towards the middle of the slide.
        expect(screen.getByTestId("comment-bubble").style.transform).toContain("-100%");
        fireEvent.pointerLeave(second);
        expect(bubbles()).toEqual([]);
        fireEvent.focus(first);
        expect(bubbles()).toEqual(["Bigger"]);
        fireEvent.blur(first);
        expect(bubbles()).toEqual([]);
      });

      it("shows every comment's text when asked to, but the open one's", () => {
        useApp.setState({ comments: { intro: [comment, { ...comment, id: "second", text: "Bolder" }] } });
        render(<Stage />);
        const bubbles = () => screen.queryAllByTestId("comment-bubble").map((b) => b.textContent);
        fireEvent.click(tool("Show every comment's text next to its pin"));
        expect(useApp.getState().commentTexts).toBe(true);
        expect(localStorage.getItem("slopslide.commentTexts")).toBe("true");
        expect(bubbles()).toEqual(["Bigger", "Bolder"]);
        fireEvent.click(screen.getByRole("button", { name: "Comment 1" }));
        expect(bubbles()).toEqual(["Bolder"]);
        fireEvent.keyDown(input(), { key: "Escape" });
        fireEvent.click(tool("Show a comment's text only when its pin is pointed at"));
        expect(bubbles()).toEqual([]);
      });

      it("says in the text when the element is gone", () => {
        useApp.setState({ comments: { intro: [comment] }, commentTexts: true });
        const { container } = render(<Stage />);
        fromFrame(container, {
          type: "slop:comment-spots",
          slide: "intro",
          spots: [{ id: "first", x: 0.25, y: 0.5, found: false }],
        });
        expect(screen.getByTestId("comment-bubble").textContent).toContain("gone");
        act(() => useApp.setState({ commentTexts: false }));
      });

      it("closes a comment taken off the slide while it is open, without bringing it back", () => {
        useApp.setState({ comments: { intro: [comment] } });
        render(<Stage />);
        fireEvent.click(screen.getByRole("button", { name: "Comment 1" }));
        fireEvent.change(input(), { target: { value: "Smaller" } });
        act(() => useApp.getState().removeSentComments([comment]));
        expect(screen.queryByRole("dialog", { name: "Comment" })).toBeNull();
        expect(useApp.getState().comments.intro).toEqual([]);
      });

      it("shows pins in View and Edit, and not while the review is hidden", () => {
        useApp.setState({ comments: { intro: [comment] } });
        render(<Stage />);
        act(() => useApp.getState().setMode("settings"));
        expect(screen.queryByTestId("comment-pin")).toBeNull();
        act(() => useApp.getState().setMode("edit"));
        expect(screen.getByTestId("comment-pin")).toBeTruthy();
        act(() => useApp.getState().setMode("view"));
        expect(screen.getByTestId("comment-pin")).toBeTruthy();
        fireEvent.click(tool("Show review marks and comments on the slides"));
        expect(screen.queryByTestId("comment-pin")).toBeNull();
      });

      describe("on an area", () => {
        const SHOT = "/home/.slopslides/sessions/1-ab/sketches/1-ab.png";
        const drawer = () => screen.getByTestId("area-drawer");
        const drag = (points: [number, number][]) => {
          const [first, ...rest] = points;
          fireEvent.pointerDown(drawer(), { button: 0, clientX: first![0], clientY: first![1], pointerId: 1 });
          for (const [x, y] of rest) fireEvent.pointerMove(drawer(), { clientX: x, clientY: y, pointerId: 1 });
          const last = points.at(-1)!;
          fireEvent.pointerUp(drawer(), { clientX: last[0], clientY: last[1], pointerId: 1 });
        };

        beforeEach(() => {
          useApp.setState({ composerImages: [] });
          vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "capture_area" ? SHOT : undefined));
        });

        it("screenshots the area dragged out, and hands the screenshot to the chat with the comment", async () => {
          render(<Stage />);
          fireEvent.click(tool("Comment on an area (rectangle)"));
          expect(pressed("Comment on an area (rectangle)")).toBe(true);
          // The slide is 1000×500 on screen.
          drag([
            [100, 50],
            [250, 150],
            [400, 250],
          ]);
          const dialog = await screen.findByRole("dialog", { name: "New comment" });
          expect(dialog.textContent).toContain("rectangle");
          expect(invoke).toHaveBeenCalledWith("capture_area", {
            id: useApp.getState().deck!.id,
            rect: { x: 100, y: 50, width: 300, height: 200 },
            viewport: { width: window.innerWidth, height: window.innerHeight },
            outline: [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          });
          expect(screen.getAllByTestId("comment-area")).toHaveLength(1);
          expect(document.activeElement).toBe(input());
          fireEvent.change(input(), { target: { value: "Too crowded" } });
          fireEvent.keyDown(input(), { key: "Enter" });
          const area = {
            shape: "rect",
            points: [
              [0.1, 0.1],
              [0.4, 0.5],
            ],
          };
          expect(useApp.getState().comments.intro).toEqual([
            { id: expect.any(String), text: "Too crowded", x: 0.1, y: 0.1, area },
          ]);
          expect(useApp.getState().composerImages).toEqual([SHOT]);
          expect(screen.getAllByTestId("comment-area")).toHaveLength(1);
          expect(screen.getAllByTestId("comment-pin").map((p) => p.textContent)).toEqual(["1"]);
        });

        it("hands nothing to the chat when the comment is dropped", async () => {
          render(<Stage />);
          fireEvent.click(tool("Comment on an area (rectangle)"));
          drag([
            [100, 50],
            [400, 250],
          ]);
          await screen.findByRole("dialog", { name: "New comment" });
          fireEvent.keyDown(input(), { key: "Escape" });
          expect(useApp.getState().comments.intro ?? []).toEqual([]);
          expect(useApp.getState().composerImages).toEqual([]);
          expect(screen.queryByTestId("comment-area")).toBeNull();
        });

        it("makes nothing of a click", async () => {
          render(<Stage />);
          fireEvent.click(tool("Comment on an area (rectangle)"));
          drag([[100, 50]]);
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(screen.queryByRole("dialog")).toBeNull();
          expect(invoke).not.toHaveBeenCalledWith("capture_area", expect.anything());
        });

        it("draws with the shape picked from its menu, which it remembers", async () => {
          render(<Stage />);
          fireEvent.click(tool("Area shape"));
          fireEvent.click(screen.getByRole("menuitemradio", { name: "Lasso" }));
          expect(screen.queryByRole("menu")).toBeNull();
          expect(pressed("Comment on an area (lasso)")).toBe(true);
          drag([
            [100, 100],
            [500, 100],
            [300, 400],
          ]);
          await screen.findByRole("dialog", { name: "New comment" });
          const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "capture_area");
          expect((call![1] as { outline: unknown[] }).outline).toHaveLength(3);
          fireEvent.change(input(), { target: { value: "This bit" } });
          fireEvent.click(screen.getByRole("button", { name: "Save" }));
          expect(useApp.getState().comments.intro?.[0]?.area?.shape).toBe("lasso");
          expect(localStorage.getItem("slopslides.areaShape")).toBe("lasso");
        });

        it("takes turns with picking elements and the pens, and Escape puts it away", () => {
          render(<Stage />);
          const area = "Comment on an area (rectangle)";
          fireEvent.click(tool(area));
          fireEvent.click(tool("Comment on an element"));
          expect([pressed(area), pressed("Comment on an element")]).toEqual([false, true]);
          fireEvent.click(tool(area));
          expect([pressed(area), pressed("Comment on an element")]).toEqual([true, false]);
          fireEvent.click(tool("Draw on the slide"));
          expect([pressed(area), pressed("Draw on the slide")]).toEqual([false, true]);
          fireEvent.click(tool(area));
          expect(pressed("Draw on the slide")).toBe(false);
          fireEvent.keyDown(document.body, { key: "Escape" });
          expect(pressed(area)).toBe(false);
          expect(screen.queryByTestId("area-drawer")).toBeNull();
        });
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
    const { saveSlideEdit, undo, redo, discardSlideEdits, tidyLayout } = useApp.getState();
    const toggleEditing = () => act(() => useApp.getState().setMode(useApp.getState().editing ? "view" : "edit"));
    const stageFrame = (container: HTMLElement) => container.querySelector("iframe")!;
    const MARKUP = `<section class="slide" id="intro"><h1 data-moved="" style="translate: 9px 0px;">Hello</h1></section>`;

    function fromFrame(frame: HTMLIFrameElement | null, data: unknown) {
      act(() => void window.dispatchEvent(new MessageEvent("message", { data, source: frame?.contentWindow ?? null })));
    }

    let undoLayout: () => void;

    beforeEach(() => {
      undoLayout = layOutStage();
      useApp.setState({ editing: false, editReload: 0, editBase: null, editedSlides: [], running: false });
    });
    afterEach(() => {
      undoLayout();
      useApp.setState({ saveSlideEdit, undo, redo, discardSlideEdits, tidyLayout });
      vi.restoreAllMocks();
    });

    it("locks Layout and Tidy layout on a locked slide, and edits nothing on one, staying in edit mode", () => {
      const locked = deckFor(DECK_HTML.replace(`id="outro"`, `id="outro" data-locked`));
      useApp.setState({ deck: locked, templates: [] });
      render(<Stage />);
      toggleEditing();
      expect(useApp.getState().editing).toBe(true);
      expect(screen.queryByText("Locked")).toBeNull();

      const edited = () =>
        [...document.querySelectorAll("iframe")].some((f) => f.getAttribute("src")?.includes("edit="));
      expect(edited()).toBe(true);
      act(() => useApp.getState().select("outro"));
      // Still Edit mode, for the slide list and the timeline, but no editor and none of its tools.
      expect(useApp.getState().editing).toBe(true);
      expect(edited()).toBe(false);
      expect(screen.queryByRole("toolbar", { name: "Edit tools" })).toBeNull();
      expect(screen.queryByRole("toolbar", { name: "View tools" })).toBeNull();
      expect(screen.getByRole("status").textContent).toContain("This slide is locked");
      // The timeline's tools stay, as in either ribbon.
      expect(screen.getByRole("button", { name: "Show the timeline under the slide" })).toBeTruthy();
      expect(screen.getByText("Locked")).toBeTruthy();
      expect((screen.getByRole("button", { name: /^Layout$/ }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: /Tidy layout/ }) as HTMLButtonElement).disabled).toBe(true);
      // Going back to a slide that is not locked, the editor is there again.
      act(() => useApp.getState().select("intro"));
      expect(edited()).toBe(true);
      expect(screen.getByRole("toolbar", { name: "Edit tools" })).toBeTruthy();
    });

    it("unlocks a locked slide from edit mode's note, and edits it then", async () => {
      const locked = deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`));
      useApp.setState({ deck: locked, templates: [] });
      vi.mocked(invoke).mockImplementation(async (command) =>
        command === "set_slides_locked" ? deckFor(DECK_HTML) : undefined,
      );
      render(<Stage />);
      toggleEditing();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Unlock" })));
      expect(invoke).toHaveBeenCalledWith("set_slides_locked", { id: locked.id, slides: ["intro"], locked: false });
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByRole("toolbar", { name: "Edit tools" })).toBeTruthy();
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

    it("shows the slide as it plays while narration plays over it, even in edit mode", () => {
      const { container } = render(<Stage />);
      toggleEditing();
      const sources = () => [...container.querySelectorAll("iframe")].map((f) => f.getAttribute("src") ?? "");
      expect(sources().some((src) => src.includes("edit="))).toBe(true);
      const selected = useApp.getState().selected!;
      act(() => setSlideClock({ slide: selected, at: 1 }));
      expect(sources().some((src) => !src.includes("edit=") && !src.includes("static"))).toBe(true);
      // Every frame of the slide gets the clock as it moves.
      const frames = [...container.querySelectorAll("iframe")];
      for (const frame of frames) fireEvent.load(frame);
      const posts = frames.map((frame) => vi.spyOn(frame.contentWindow!, "postMessage"));
      act(() => setSlideClock({ slide: selected, at: 1.1 }));
      const clocks = posts.flatMap((post) => post.mock.calls.map(([data]) => data));
      expect(clocks).toContainEqual({ type: "slop:clock", slide: selected, at: 1.1 });
      // Paused, or on another slide, it is the editor's again.
      act(() => setSlideClock({ slide: "elsewhere", at: 1.1 }));
      expect(sources().some((src) => src.includes("edit="))).toBe(true);
      act(() => setSlideClock(null));
      expect(sources().some((src) => src.includes("edit="))).toBe(true);
      toggleEditing();
    });

    it("has the search in the view ribbon, as its last section", () => {
      render(<Stage />);
      const ribbon = screen.getByRole("toolbar", { name: "View tools" });
      const sections = [...ribbon.querySelectorAll("fieldset")].map((group) => group.getAttribute("aria-label"));
      expect(sections).toEqual(["Mark up", "Review", "Animations", "Timeline", "Find"]);
      const find = within(ribbon).getByRole("group", { name: "Find" });
      expect(within(find).getByRole("textbox", { name: "Search slides" })).toBeTruthy();
    });

    it("plays the slide's animations, or shows its final state when asked to", () => {
      const { container } = render(<Stage />);
      const sources = () => [...container.querySelectorAll("iframe")].map((f) => f.getAttribute("src") ?? "");
      const choice = (name: RegExp) => screen.getByRole("button", { name });
      const chosen = () =>
        [/^Play the slide's animations/, /^Show the slide's final state/].map(
          (name) => choice(name).getAttribute("aria-pressed") === "true",
        );
      expect(chosen()).toEqual([true, false]);
      expect(sources().every((src) => !src.includes("static"))).toBe(true);

      fireEvent.click(choice(/^Show the slide's final state/));
      expect(chosen()).toEqual([false, true]);
      expect(useApp.getState().finalState).toBe(true);
      // A still like the thumbnail's, on the pasteboard and without the editor.
      expect(sources().some((src) => src.endsWith("&static&pan"))).toBe(true);
      // The other slides show their final state too.
      act(() => useApp.getState().select("outro"));
      expect(sources().some((src) => src.includes("slide=outro") && src.endsWith("&static&pan"))).toBe(true);

      // Narration playing over the slide still plays it.
      act(() => setSlideClock({ slide: "outro", at: 1 }));
      expect(sources().some((src) => src.includes("slide=outro") && !src.includes("static"))).toBe(true);
      act(() => setSlideClock(null));

      // So does the timeline holding it at a moment; let go, View has the still back.
      act(() => setSlideClock({ slide: "outro", at: 1, paused: true }));
      expect(sources().some((src) => src.includes("slide=outro") && !src.includes("static"))).toBe(true);
      act(() => setSlideClock(null));
      expect(sources().some((src) => src.includes("slide=outro") && src.endsWith("&static&pan"))).toBe(true);

      fireEvent.click(choice(/^Play the slide's animations/));
      expect(chosen()).toEqual([true, false]);
      expect(sources().some((src) => src.includes("slide=outro") && !src.includes("static"))).toBe(true);
    });

    it("has the search in View mode only", () => {
      render(<Stage />);
      expect(screen.getByRole("textbox", { name: "Search slides" })).toBeTruthy();
      act(() => useApp.getState().setMode("edit"));
      expect(screen.queryByRole("textbox", { name: "Search slides" })).toBeNull();
    });

    it("shows each mode's tools above the slide, and only there", () => {
      render(<Stage />);
      const sketch = () => screen.queryByRole("toolbar", { name: "View tools" });
      const edit = () => screen.queryByRole("toolbar", { name: "Edit tools" });
      expect(sketch()).not.toBeNull();
      expect(edit()).toBeNull();
      act(() => useApp.getState().setMode("edit"));
      expect(sketch()).toBeNull();
      expect(edit()).not.toBeNull();
      // Undo and redo live in the top bar, leaving the ribbon the row's whole width.
      for (const name of ["Undo", "Redo"]) expect(screen.queryByRole("button", { name })).toBeNull();
      act(() => useApp.getState().setMode("view"));
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
      act(() => useApp.getState().setMode("settings"));
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
        expect(button("Select and move").getAttribute("aria-pressed")).toBe("true");
        fireEvent.click(button("Add a rectangle"));
        expect(useApp.getState().editTool).toBe("rect");
        expect(button("Add a rectangle").getAttribute("aria-pressed")).toBe("true");
        expect(post).toHaveBeenLastCalledWith(
          { type: "slop:edit-tool", tool: "rect", style: DEFAULT_EDIT_STYLES.shape },
          "*",
        );
        fireEvent.click(button("Draw freehand"));
        expect(post).toHaveBeenLastCalledWith(
          { type: "slop:edit-tool", tool: "draw", style: DEFAULT_EDIT_STYLES.draw },
          "*",
        );
        fireEvent.click(button("Select and move"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-tool", tool: "select", style: undefined }, "*");
      });

      it("defaults to Resize and preserves Stretch across preview reloads", () => {
        const { frame, post } = enter();
        // How the handles change the size is with the selection's position and size.
        const geometry = { count: 1, x: 10, y: 20, w: 300, h: 200, rotation: 0 };
        fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry });
        fireEvent.click(button("Position and size"));
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
        fireEvent.click(button("Add text"));
        const post = vi.spyOn(frame.contentWindow!, "postMessage");
        fireEvent.load(frame);
        expect(post).toHaveBeenCalledWith(
          { type: "slop:edit-tool", tool: "text", style: DEFAULT_EDIT_STYLES.text },
          "*",
        );
      });

      it("follows the editor when it puts its tool away", () => {
        const { frame } = enter();
        fireEvent.click(button("Add an ellipse"));
        fromFrame(frame, { type: "slop:edit-tool", slide: "intro", tool: "select" });
        expect(useApp.getState().editTool).toBe("select");
        // Not from another slide, and not for tools it does not know.
        fireEvent.click(button("Add an ellipse"));
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
        fireEvent.click(button("Add text"));
        toggleEditing();
        toggleEditing();
        expect(useApp.getState().editTool).toBe("select");
      });

      it("has nothing to style until something is selected or a tool is picked", () => {
        const { frame } = enter();
        for (const name of ["Text color", "Bold", "Fill", "Border color", "Bring to front", "Delete"]) {
          expect(button(name).disabled).toBe(true);
        }
        select(frame);
        for (const name of ["Text color", "Bold", "Fill", "Border color", "Bring to front", "Delete"]) {
          expect(button(name).disabled).toBe(false);
        }
        select(frame, null);
        expect(button("Fill").disabled).toBe(true);
      });

      it("shows the selection's style", () => {
        const { frame } = enter();
        select(frame);
        expect((screen.getByLabelText("Font size") as HTMLInputElement).value).toBe("40");
        expect(button("Italic").getAttribute("aria-pressed")).toBe("true");
        expect(button("Bold").getAttribute("aria-pressed")).toBe("false");
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
        fireEvent.click(button("Bold"));
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
        expect(button("Bold").disabled).toBe(true);
        expect(button("Line color").disabled).toBe(false);
        expect((screen.getByLabelText("Line width") as HTMLSelectElement).value).toBe("6");
      });

      it("styles what the tool adds when nothing is selected", () => {
        const { post } = enter();
        fireEvent.click(button("Add text"));
        expect(button("Fill").disabled).toBe(false);
        fireEvent.click(button("Italic"));
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
        fireEvent.click(button("Red (#ef4444)"));
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
        fireEvent.click(button("Add an arrow"));
        expect(post).toHaveBeenLastCalledWith(
          { type: "slop:edit-tool", tool: "arrow", style: DEFAULT_EDIT_STYLES.draw },
          "*",
        );
        fromFrame(frame, { type: "slop:edit-tool", slide: "intro", tool: "select" });
        expect(useApp.getState().editTool).toBe("select");
      });

      // One case per shape: looping them all in one test outruns the timeout
      // on slower CI runners.
      it.each([
        ["Add a diamond (a decision in a flowchart)", "diamond", "shape"],
        ["Add a chevron (a step in a process)", "chevron", "shape"],
        ["Add a block arrow", "block-arrow", "shape"],
        ["Add a double-headed arrow", "double-arrow", "shape"],
        ["Add a hexagon (a preparation step)", "hexagon", "shape"],
        ["Add an octagon", "octagon", "shape"],
        ["Add a pentagon", "pentagon", "shape"],
        ["Add a parallelogram (input or output)", "parallelogram", "shape"],
        ["Add a trapezoid", "trapezoid", "shape"],
        ["Add a plus", "plus", "shape"],
        ["Add a cylinder (a database)", "cylinder", "shape"],
        ["Add a document", "document", "shape"],
        ["Add a heart", "heart", "shape"],
        ["Add a bracket", "bracket", "draw"],
        ["Add a brace", "brace", "draw"],
        ["Add an elbow connector (turns at right angles between the elements its ends stick to)", "elbow", "draw"],
        ["Add a curved connector (curves between the elements its ends stick to)", "curve", "draw"],
      ] as const)("offers %s in the shapes picker, and shows it picked", (name, tool, family) => {
        const { frame, post } = enter();
        const more = button("More shapes");
        fireEvent.click(more);
        const picker = screen.getByRole("dialog", { name: "More shapes" });
        fireEvent.click(within(picker).getByRole("button", { name }));
        expect(post).toHaveBeenLastCalledWith(
          { type: "slop:edit-tool", tool, style: DEFAULT_EDIT_STYLES[family] },
          "*",
        );
        // The picker closes; its button stands for the shape picked.
        expect(screen.queryByRole("dialog", { name: "More shapes" })).toBeNull();
        expect(more.getAttribute("aria-pressed")).toBe("true");
        fromFrame(frame, { type: "slop:edit-tool", slide: "intro", tool: "select" });
        expect(more.getAttribute("aria-pressed")).toBe("false");
      });

      it("dashes the selection's line or border", () => {
        const { frame, post } = enter();
        select(frame, { ...SELECTION, stroke: "#000000", strokeWidth: 4, dash: "dotted" });
        const dash = screen.getByLabelText("Border style") as HTMLSelectElement;
        expect(dash.value).toBe("dotted");
        fireEvent.change(dash, { target: { value: "dashed" } });
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { dash: "dashed" } }, "*");
        select(frame, { ...SELECTION, kind: "drawing", vector: true, text: false, dash: "solid" });
        expect((screen.getByLabelText("Line style") as HTMLSelectElement).value).toBe("solid");
      });

      it("sets a line's heads and route, for lines only", () => {
        const { frame, post } = enter();
        select(frame);
        expect(button("Line ends and route").disabled).toBe(true);
        select(frame, {
          ...SELECTION,
          kind: "drawing",
          vector: true,
          text: false,
          line: { start: null, end: "arrow", route: "straight" },
        });
        fireEvent.click(button("Line ends and route"));
        const panel = screen.getByRole("dialog", { name: "Line ends and route" });
        const start = within(panel).getByLabelText("Start") as HTMLSelectElement;
        expect(start.value).toBe("");
        expect((within(panel).getByLabelText("End") as HTMLSelectElement).value).toBe("arrow");
        fireEvent.change(start, { target: { value: "dot" } });
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { headStart: "dot" } }, "*");
        expect(within(panel).getByRole("button", { name: "Straight" }).getAttribute("aria-pressed")).toBe("true");
        fireEvent.click(within(panel).getByRole("button", { name: "Elbow" }));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { route: "elbow" } }, "*");
        // A line's heads and route are not the next line's.
        expect(useApp.getState().editStyles.draw).toEqual(DEFAULT_EDIT_STYLES.draw);
      });

      it("groups, ungroups and locks from the toolbar", () => {
        const { frame, post } = enter();
        expect(button("Group").disabled).toBe(true);
        expect(button("Lock").disabled).toBe(true);
        select(frame, { ...SELECTION, kind: "group", group: true });
        fromFrame(frame, {
          type: "slop:edit-geometry",
          slide: "intro",
          geometry: { count: 3, x: 0, y: 0, w: 1, h: 1 },
        });
        fireEvent.click(button("Group"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-group" }, "*");
        fireEvent.click(button("Ungroup"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-ungroup" }, "*");
        fireEvent.click(button("Lock"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-lock", locked: true }, "*");
        select(frame, { ...SELECTION, locked: true });
        expect(button("Unlock").getAttribute("aria-pressed")).toBe("true");
      });

      it("lists the slide's layers, to pick, lock and restack them", () => {
        const { frame, post } = enter();
        expect(button("Layers").disabled).toBe(true);
        fromFrame(frame, {
          type: "slop:edit-layers",
          slide: "intro",
          layers: [
            { path: [4], name: "Group of 2", group: true, selected: true, depth: 0 },
            { path: [4, 1], name: "Text: B", depth: 1 },
            { path: [4, 0], name: "Text: A", depth: 1 },
            { path: [0], name: "Heading: Hi", locked: true, depth: 0 },
          ],
        });
        fireEvent.click(button("Layers"));
        const panel = within(screen.getByRole("dialog", { name: "Layers" }));
        expect(panel.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
          "Group of 2",
          "Text: B",
          "Text: A",
          "Heading: Hi",
        ]);
        expect(panel.getByRole("button", { name: "Group of 2" }).getAttribute("aria-current")).toBe("true");
        fireEvent.click(panel.getByRole("button", { name: "Heading: Hi" }));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-select", path: [0] }, "*");
        fireEvent.click(panel.getByRole("button", { name: "Unlock Heading: Hi" }));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-lock", locked: false, path: [0] }, "*");
        // Up and down go among the layers of the same group, or of the slide.
        expect((panel.getByRole("button", { name: "Move Group of 2 up" }) as HTMLButtonElement).disabled).toBe(true);
        expect((panel.getByRole("button", { name: "Move Text: A down" }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(panel.getByRole("button", { name: "Move Text: A up" }));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-order", to: "forward", path: [4, 0], any: true }, "*");
        fireEvent.click(panel.getByRole("button", { name: "Move Group of 2 down" }));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-order", to: "backward", path: [4], any: true }, "*");
      });

      it("arms the format painter on the selection, and disarms it", () => {
        const { frame } = enter();
        const painter = "Format painter";
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
        expect((screen.getByLabelText("Opacity value") as HTMLInputElement).value).toBe("50");
        // All along the drag the slide shows the value, without saving it.
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-style", style: { opacity: 0.5 }, preview: true }, "*");
        expect(post).not.toHaveBeenCalledWith({ type: "slop:edit-style", style: expect.anything() }, "*");
        act(() => void opacity.dispatchEvent(new Event("change")));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { opacity: 0.5 } }, "*");
        // A drag given up with Escape is taken back, the panel staying open.
        fireEvent.input(opacity, { target: { value: "30" } });
        fireEvent.keyDown(opacity, { key: "Escape" });
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-style-cancel" }, "*");
        expect(screen.getByRole("dialog", { name: "Appearance" })).toBeTruthy();
        // The number can be typed, within the slider's range.
        const shadow = screen.getByLabelText("Shadow value") as HTMLInputElement;
        fireEvent.change(shadow, { target: { value: "500" } });
        fireEvent.keyDown(shadow, { key: "Enter" });
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { shadow: 80 } }, "*");
        const radius = screen.getByLabelText("Corner radius") as HTMLInputElement;
        fireEvent.input(radius, { target: { value: "20" } });
        act(() => void radius.dispatchEvent(new Event("change")));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { radius: 20 } }, "*");
        // Restyling leaves the next shape's defaults alone.
        expect(useApp.getState().editStyles.shape).toEqual(DEFAULT_EDIT_STYLES.shape);
      });

      it("changes a shape's proportions from the appearance panel, for shapes that have them", () => {
        const { frame, post } = enter();
        select(frame, { ...SELECTION, opacity: 1, shadow: 0, radius: null });
        fireEvent.click(button("Appearance"));
        expect(screen.queryByLabelText("Points")).toBeNull();
        select(frame, {
          ...SELECTION,
          opacity: 1,
          shadow: 0,
          radius: null,
          adjust: { value: 5, min: 3, max: 12, step: 1, label: "Points" },
        });
        const points = screen.getByLabelText("Points") as HTMLInputElement;
        expect([points.min, points.max, points.value]).toEqual(["3", "12", "5"]);
        fireEvent.input(points, { target: { value: "7" } });
        act(() => void points.dispatchEvent(new Event("change")));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { adjust: 7 } }, "*");
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
          expect(invoke).not.toHaveBeenCalledWith("import_assets", expect.anything());
          expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-paste-images" }), "*");
        });

        it("shows an error when the file cannot be imported", async () => {
          enter();
          vi.mocked(open).mockResolvedValue(["/tmp/a.png"] as never);
          vi.mocked(invoke).mockRejectedValue("disk full");
          fireEvent.click(button("Add an image from a file"));
          await waitFor(() => expect(lastError(useApp.getState())).toBe("disk full"));
          act(() => useApp.setState({ toasts: [] }));
        });

        it("offers the image panel for images only", () => {
          const { frame } = enter();
          select(frame);
          expect(button("Image options").disabled).toBe(true);
          select(frame, IMAGE);
          expect(button("Image options").disabled).toBe(false);
        });

        it("replaces, fits and positions the image", async () => {
          const { frame, post } = enter();
          select(frame, IMAGE);
          fireEvent.click(button("Image options"));
          fireEvent.change(screen.getByLabelText("Fit"), { target: { value: "cover" } });
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { fit: "cover" } }, "*");
          expect([...(screen.getByLabelText("Fit") as HTMLSelectElement).options].map((o) => o.text)).toEqual([
            "Fit inside",
            "Fill and crop",
            "Stretch",
          ]);
          fireEvent.click(button("Position 50% 0%"));
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { fitPosition: "50% 0%" } }, "*");
          expect(button("Position 50% 0%").title).toBe("Top");
          // Flipping is with the other flips, under Position and size.
          expect(
            within(screen.getByRole("dialog", { name: "Image options" })).queryByRole("button", { name: /Flip/ }),
          ).toBeNull();
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
          fireEvent.click(button("Image options"));
          const alt = screen.getByLabelText("Alt text");
          fireEvent.change(alt, { target: { value: "A cat" } });
          fireEvent.keyDown(alt, { key: "Enter" });
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { alt: "A cat" } }, "*");
          fireEvent.change(alt, { target: { value: "A dog" } });
          fireEvent.pointerDown(document.body);
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-style", style: { alt: "A dog" } }, "*");
          expect(screen.queryByRole("dialog", { name: "Image options" })).toBeNull();
        });
      });

      it("picks colors from swatches, none, or a custom color", () => {
        const { frame, post } = enter();
        select(frame);
        fireEvent.click(button("Fill"));
        fireEvent.click(button("Red (#ef4444)"));
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
        fireEvent.click(button("Delete"));
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
          expect(button("Underline").getAttribute("aria-pressed")).toBe("true");
          expect(button("Superscript").getAttribute("aria-pressed")).toBe("true");
          expect(button(/^Bulleted list/).getAttribute("aria-pressed")).toBe("true");
          fireEvent.click(button("Underline"));
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
          fireEvent.click(button("Bold"));
          expect(post).toHaveBeenCalledWith(style({ bold: true }), "*");
          expect(useApp.getState().editStyles).toEqual(DEFAULT_EDIT_STYLES);
        });

        it("keeps focus in the slide when a button is pressed, and ends typing on a press elsewhere", () => {
          const { frame, post } = enter();
          select(frame, TEXT);
          const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
          button("Bold").dispatchEvent(press);
          expect(press.defaultPrevented).toBe(true);
          fireEvent.pointerDown(button("Bold"));
          expect(post).not.toHaveBeenCalledWith({ type: "slop:edit-finish" }, "*");
          fireEvent.pointerDown(document.body);
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-finish" }, "*");
        });

        it("closes the toolbar's popup on Escape, pressed in the app or in the slide, staying in edit mode", () => {
          const { frame, post } = enter();
          select(frame, TEXT);
          const popup = () => screen.queryByRole("dialog", { name: "Text color" });
          fireEvent.click(button("Text color"));
          // The slide is told, so that it hands its Escape over instead of deselecting.
          expect(post).toHaveBeenCalledWith({ type: "slop:layer", open: true }, "*");
          fromFrame(frame, { type: "slop:dismiss" });
          expect(popup()).toBeNull();
          expect(post).toHaveBeenCalledWith({ type: "slop:layer", open: false }, "*");
          // Escape the player forwards as a key closes it too, before it means leaving edit mode.
          fireEvent.click(button("Text color"));
          fromFrame(frame, { type: "slop:key", key: "Escape", mod: false });
          expect(popup()).toBeNull();
          expect(useApp.getState().editing).toBe(true);
          fireEvent.click(button("Text color"));
          fireEvent.keyDown(document.body, { key: "Escape" });
          expect(popup()).toBeNull();
          expect(useApp.getState().editing).toBe(true);
          // With nothing open, Escape from the slide leaves edit mode, as before.
          fromFrame(frame, { type: "slop:key", key: "Escape", mod: false });
          expect(useApp.getState().editing).toBe(false);
        });

        it("closes the toolbar's popups on a press in the slide, leaving the typing to the editor", () => {
          const { frame, post } = enter();
          select(frame, TEXT);
          fireEvent.click(button("Text color"));
          expect(screen.getByRole("dialog", { name: "Text color" })).toBeTruthy();
          fromFrame(frame, { type: "slop:press" });
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

    /** Marks `slides` edited since edit mode started: changed from the hashes they had then. */
    const edited = (...slides: string[]) => {
      const { deck } = useApp.getState();
      const hashes = Object.fromEntries(deck!.slides.map((s) => [s.id, slides.includes(s.id) ? "before" : s.hash]));
      useApp.setState({ editBase: { version: "v1", hashes }, editedSlides: slides });
    };

    it("floats a discard button over the slide while there are edits, which discards them all", () => {
      const discard = vi.fn().mockResolvedValue(undefined);
      useApp.setState({ discardSlideEdits: discard });
      render(<Stage />);
      toggleEditing();
      const discardButton = () => screen.queryByRole("button", { name: /Discard changes/ });
      expect(discardButton()).toBeNull();
      act(() => edited("intro"));
      expect(discardButton()!.closest("[data-testid=stage-area]")).not.toBeNull();
      fireEvent.click(discardButton()!);
      expect(discard).toHaveBeenCalledWith();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("asks whether to discard only this slide when other slides were edited too", () => {
      const discard = vi.fn().mockResolvedValue(undefined);
      useApp.setState({ discardSlideEdits: discard, selected: "intro" });
      render(<Stage />);
      toggleEditing();
      act(() => edited("outro", "intro"));
      const open = () => fireEvent.click(screen.getByRole("button", { name: /Discard changes/ }));
      const dialog = () => screen.queryByRole("dialog", { name: "Discard changes" });

      open();
      expect(dialog()!.textContent).toContain("1 other slide");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(dialog()).toBeNull();
      expect(discard).not.toHaveBeenCalled();

      open();
      fireEvent.click(screen.getByRole("button", { name: "Only this slide" }));
      expect(discard).toHaveBeenLastCalledWith("intro");
      expect(dialog()).toBeNull();

      open();
      fireEvent.click(screen.getByRole("button", { name: "All 2 slides" }));
      expect(discard).toHaveBeenLastCalledWith();
    });

    it("says how many slides a discard reaches, on the button", () => {
      useApp.setState({ selected: "intro" });
      render(<Stage />);
      toggleEditing();
      const label = () => screen.getByRole("button", { name: /Discard changes/ }).textContent;
      act(() => edited("intro"));
      expect(label()).toBe("Discard changes");
      act(() => edited("intro", "outro", "#2"));
      expect(label()).toBe("Discard changes on 3 slides");
      act(() => edited("outro"));
      expect(label()).toBe("Discard changes on 1 other slide");
      act(() => edited("outro", "#2"));
      expect(label()).toBe("Discard changes on 2 other slides");
    });

    it("asks before it discards on slides other than the one shown, which has no changes itself", () => {
      const discard = vi.fn().mockResolvedValue(undefined);
      useApp.setState({ discardSlideEdits: discard, selected: "intro" });
      render(<Stage />);
      toggleEditing();
      act(() => edited("outro", "#2"));
      fireEvent.click(screen.getByRole("button", { name: /Discard changes/ }));
      const dialog = screen.getByRole("dialog", { name: "Discard changes" });
      expect(dialog.textContent).toContain("Discard changes on 2 other slides?");
      expect(dialog.textContent).toContain("The slide shown has no changes.");
      expect(discard).not.toHaveBeenCalled();
      // There is no "only this slide" to offer: it has nothing to discard.
      expect(screen.queryByRole("button", { name: "Only this slide" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(discard).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: /Discard changes/ }));
      fireEvent.click(screen.getByRole("button", { name: "Discard on 2 slides" }));
      expect(discard).toHaveBeenCalledExactlyOnceWith();
      expect(screen.queryByRole("dialog")).toBeNull();
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

    describe("after the editor saves", () => {
      const withHash = (hash: string) => {
        const deck = useApp.getState().deck!;
        return { ...deck, slides: deck.slides.map((s) => (s.id === "intro" ? { ...s, hash } : s)) };
      };
      const frames = (container: HTMLElement) => [...container.querySelectorAll("iframe")];
      /** The editor's preview, once it has loaded in place of the slide's. */
      const editorFrame = (container: HTMLElement) => {
        const frame = frames(container).at(-1)!;
        fireEvent.load(frame);
        expect(frames(container)).toEqual([frame]);
        return frame;
      };
      const commit = async (frame: HTMLIFrameElement, hash: string) => {
        vi.mocked(invoke).mockImplementation(async (command) =>
          command === "update_slide" ? withHash(hash) : undefined,
        );
        fromFrame(frame, { type: "slop:edit-commit", slide: "intro", markup: MARKUP, select: [0] });
        await waitFor(() => expect(useApp.getState().deck!.slides[0]!.hash).toBe(hash));
      };

      it("keeps the editor running on the version it saved, so what the user does next is not lost to a reload", async () => {
        useApp.setState({ selected: "intro" });
        const { container } = render(<Stage />);
        toggleEditing();
        const frame = editorFrame(container);
        const src = frame.getAttribute("src");
        await commit(frame, "saved-1");
        await commit(frame, "saved-2");
        expect(useApp.getState().editSaved).toEqual({ intro: "saved-2" });
        expect(frames(container)).toEqual([frame]);
        expect(frame.getAttribute("src")).toBe(src);
      });

      it("loads the slide again for a change the editor did not make, or a save that failed", async () => {
        useApp.setState({ selected: "intro" });
        const { container } = render(<Stage />);
        toggleEditing();
        const frame = editorFrame(container);
        await commit(frame, "saved-1");
        // The agent changes the slide.
        act(() => useApp.getState().setDeck(withHash("agent")));
        const [, next] = frames(container);
        expect(next!.getAttribute("src")).toContain("agent");
        fireEvent.load(next!);
        expect(frames(container)).toEqual([next]);
        // An undo back to what the editor saved shows the file, not what the editor has now.
        act(() => {
          useApp.getState().setDeck(withHash("saved-1"));
          useApp.setState((s) => ({ editReload: s.editReload + 1 }));
        });
        const undone = frames(container).at(-1)!;
        expect(undone).not.toBe(next);
        expect(undone.getAttribute("src")).toContain("saved-1");
      });

      it("forgets what the editor saved when edit mode is left", async () => {
        useApp.setState({ selected: "intro" });
        const { container } = render(<Stage />);
        toggleEditing();
        const frame = editorFrame(container);
        await commit(frame, "saved-1");
        toggleEditing();
        expect(useApp.getState().editSaved).toEqual({});
      });
    });

    it("deletes the editor's selection from the edit tools, enabled only while something is selected", () => {
      const { container } = render(<Stage />);
      toggleEditing();
      const frame = stageFrame(container);
      fireEvent.load(frame);
      const remove = () => screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
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
        await waitFor(() => expect(lastError(useApp.getState())).toBe("disk full"));
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

      it("takes the shortcuts on the selection pressed in the app as the slide does", () => {
        const { container } = render(<Stage />);
        toggleEditing();
        const { frame, post } = loaded(container);
        const press = (key: string, init: KeyboardEventInit = {}) =>
          fireEvent.keyDown(document.body, { key, metaKey: true, ...init });
        expect(press("]")).toBe(false);
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-order", to: "forward" }, "*");
        press("{", { shiftKey: true });
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-order", to: "back" }, "*");
        press("E", { shiftKey: true });
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-style", style: { align: "center" } }, "*");
        press(">", { shiftKey: true });
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-font-step", step: 1 }, "*");
        press("H", { shiftKey: true });
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-flip", axis: "x" }, "*");
        press("ç", { altKey: true, code: "KeyC" });
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-copy-style" }, "*");
        // Nothing is locked or unlocked without a selection; with one, its lock turns over.
        post.mockClear();
        press("¬", { altKey: true, code: "KeyL" });
        expect(post).not.toHaveBeenCalled();
        fromFrame(frame, {
          type: "slop:edit-selection",
          slide: "intro",
          selected: true,
          selection: { kind: "shape", text: true, locked: true },
        });
        press("¬", { altKey: true, code: "KeyL" });
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-lock", locked: false }, "*");
        // ⌘K opens the Link popover, from the app or asked for by the slide.
        press("k");
        expect(screen.getByRole("dialog", { name: "Link" })).toBeTruthy();
        fireEvent.keyDown(screen.getByLabelText("Link address"), { key: "Escape" });
        expect(screen.queryByRole("dialog", { name: "Link" })).toBeNull();
        fromFrame(frame, { type: "slop:edit-request", slide: "intro", what: "link" });
        expect(screen.getByRole("dialog", { name: "Link" })).toBeTruthy();
        // A key typed in a field is the field's.
        post.mockClear();
        fireEvent.keyDown(screen.getByLabelText("Link address"), { key: "]", metaKey: true });
        expect(post).not.toHaveBeenCalled();
      });

      it("tells the editor whether to snap, on every slide it loads and when the toggle changes", () => {
        const { container } = render(<Stage />);
        toggleEditing();
        const { frame, post } = loaded(container);
        post.mockClear();
        fireEvent.load(frame);
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-snap", on: true }, "*");
        fireEvent.click(screen.getByRole("button", { name: "Snap to guides" }));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-snap", on: false }, "*");
        post.mockClear();
        fireEvent.load(frame);
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-snap", on: false }, "*");
        act(() => useApp.getState().setEditSnap(true));
      });

      it("starts a request for a table from the Insert section, on the whole slide", () => {
        const ask = vi.fn().mockResolvedValue(undefined);
        const { askForInsert } = useApp.getState();
        useApp.setState({ askForInsert: ask });
        const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
          cb(0);
          return 0;
        });
        const { container } = render(<Stage />);
        toggleEditing();
        const { post } = loaded(container);
        fireEvent.click(screen.getByRole("button", { name: "Table…" }));
        expect(post).toHaveBeenCalledWith({ type: "slop:camera", home: true }, "*");
        expect(ask).toHaveBeenCalledWith("table");
        raf.mockRestore();
        useApp.setState({ askForInsert });
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
        expect(button("Position and size").hasAttribute("disabled")).toBe(true);
        // What waits for a selection says so.
        expect(button("Position and size").title).toBe("Select an element");
        expect(button("Align with the slide's left edges").title).toBe("Select an element");
        expect(button("Distribute vertically").title).toBe("Select three or more elements");
        fromFrame(frame, {
          type: "slop:edit-geometry",
          slide: "intro",
          geometry: { count: 3, x: 10, y: 20, w: 300, h: 200, rotation: null },
        });
        // Aligning and distributing are in the ribbon itself: several elements line up with each
        // other unless the slide is picked.
        expect(button("Align with the slide").getAttribute("aria-pressed")).toBe("false");
        fireEvent.click(button("Align left edges"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-align", to: "left", target: "selection" }, "*");
        fireEvent.click(button("Align with the slide"));
        expect(button("Align with the slide").getAttribute("aria-pressed")).toBe("true");
        fireEvent.click(button("Align left edges with the slide"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-align", to: "left", target: "slide" }, "*");
        fireEvent.click(button("Position and size"));
        fireEvent.click(button("Match width"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-match", axis: "w" }, "*");
        fireEvent.click(button("Match height"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-match", axis: "h" }, "*");
        // Each of several elements flips in its own place; they have no one rotation to turn.
        fireEvent.click(button("Flip horizontally"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-flip", axis: "x" }, "*");
        expect(button("Rotate 90° clockwise").hasAttribute("disabled")).toBe(true);
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
        fireEvent.click(button("Position and size"));
        expect(button("Distribute horizontally").hasAttribute("disabled")).toBe(true);
        // One element can only line up with the slide.
        expect(button("Align with the slide").hasAttribute("disabled")).toBe(true);
        expect(button("Match width").hasAttribute("disabled")).toBe(true);
        expect(button("Match width").title).toBe("Select two or more elements");
        fireEvent.click(button("Align with the slide's right edges"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-align", to: "right", target: "slide" }, "*");
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
        // A quarter turn either way, from the rotation the editor reports.
        fireEvent.click(button("Rotate 90° clockwise"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-geometry", rotation: 105 }, "*");
        fireEvent.click(button("Rotate 90° counterclockwise"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-geometry", rotation: -75 }, "*");
      });

      it("keeps the arrange panel open through the reload after a save, for the next change", () => {
        const button = (name: string) => screen.getByRole("button", { name });
        const { container } = render(<Stage />);
        toggleEditing();
        const { frame, post } = loaded(container);
        const geometry = { count: 1, x: 10, y: 20, w: 300, h: 200, rotation: 0 };
        fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry });
        fireEvent.click(button("Position and size"));
        fireEvent.click(button("Align with the slide's left edges"));
        // The save reloads the preview, which has nothing selected until the editor restores it.
        fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry: null });
        expect(screen.getByRole("dialog", { name: "Position and size" })).toBeTruthy();
        expect(button("Align with the slide's top edges").hasAttribute("disabled")).toBe(true);
        fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry: { ...geometry, x: 0 } });
        fireEvent.click(button("Align with the slide's top edges"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-align", to: "top", target: "slide" }, "*");
        expect((screen.getByLabelText("Distance from the slide's left edge") as HTMLInputElement).value).toBe("0");
      });

      it("keeps the field being typed in through the reload that tabbing out of another one causes", () => {
        const { container } = render(<Stage />);
        toggleEditing();
        const { frame, post } = loaded(container);
        const geometry = { count: 1, x: 10, y: 20, w: 300, h: 200, rotation: 0 };
        fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry });
        fireEvent.click(screen.getByRole("button", { name: "Position and size" }));
        const x = screen.getByLabelText("Distance from the slide's left edge") as HTMLInputElement;
        const y = screen.getByLabelText("Distance from the slide's top edge") as HTMLInputElement;
        x.focus();
        fireEvent.change(x, { target: { value: "42" } });
        // Tab: X applies as it loses focus, and Y takes it.
        y.focus();
        fireEvent.blur(x);
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-geometry", x: 42 }, "*");
        // The save reloads the preview, which has nothing selected for a moment.
        fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry: null });
        expect(y.disabled).toBe(false);
        expect(document.activeElement).toBe(y);
        fireEvent.change(y, { target: { value: "64" } });
        fireEvent.keyDown(y, { key: "Enter" });
        // Typed before the selection came back, it waits for it.
        expect(post).not.toHaveBeenCalledWith({ type: "slop:edit-geometry", y: 64 }, "*");
        fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry: { ...geometry, x: 42 } });
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-geometry", y: 64 }, "*");
      });

      it("drops a number typed for a selection that does not come back", () => {
        const now = vi.spyOn(Date, "now").mockReturnValue(1000);
        const { container } = render(<Stage />);
        toggleEditing();
        const { frame, post } = loaded(container);
        const geometry = { count: 1, x: 10, y: 20, w: 300, h: 200, rotation: 0 };
        fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry });
        fireEvent.click(screen.getByRole("button", { name: "Position and size" }));
        fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry: null });
        const y = screen.getByLabelText("Distance from the slide's top edge") as HTMLInputElement;
        fireEvent.change(y, { target: { value: "64" } });
        fireEvent.keyDown(y, { key: "Enter" });
        now.mockReturnValue(9000);
        fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry: { ...geometry, w: 50 } });
        expect(post).not.toHaveBeenCalledWith({ type: "slop:edit-geometry", y: 64 }, "*");
        now.mockRestore();
      });

      it("locks the aspect ratio for resizes, and keeps it locked through reloads", () => {
        const { container } = render(<Stage />);
        toggleEditing();
        const { frame, post } = loaded(container);
        fromFrame(frame, {
          type: "slop:edit-geometry",
          slide: "intro",
          geometry: { count: 1, x: 10, y: 20, w: 300, h: 200, rotation: 0 },
        });
        fireEvent.click(screen.getByRole("button", { name: "Position and size" }));
        const lock = screen.getByRole("button", { name: "Lock aspect ratio" });
        expect(lock.getAttribute("aria-pressed")).toBe("false");
        fireEvent.click(lock);
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-keep-ratio", on: true }, "*");
        expect(lock.getAttribute("aria-pressed")).toBe("true");
        post.mockClear();
        fireEvent.load(frame);
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-keep-ratio", on: true }, "*");
      });

      it("flips a shape from the arrange panel, keeping it open", () => {
        const button = (name: string) => screen.getByRole("button", { name });
        const { container } = render(<Stage />);
        toggleEditing();
        const { frame, post } = loaded(container);
        fromFrame(frame, {
          type: "slop:edit-geometry",
          slide: "intro",
          geometry: { count: 1, x: 10, y: 20, w: 300, h: 200, rotation: 0 },
        });
        fromFrame(frame, {
          type: "slop:edit-selection",
          slide: "intro",
          selected: true,
          selection: { kind: "shape", text: true, flippable: true, flipX: true },
        });
        fireEvent.click(button("Position and size"));
        expect(button("Flip horizontally").getAttribute("aria-pressed")).toBe("true");
        expect(button("Flip horizontally").title).toBe("Flip horizontally (Ctrl+Shift+H)");
        fireEvent.click(button("Flip horizontally"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-flip", axis: "x" }, "*");
        fireEvent.click(button("Flip vertically"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-flip", axis: "y" }, "*");
        expect(screen.getByRole("dialog", { name: "Position and size" })).toBeTruthy();
        // A text box would mirror its text, so it does not flip.
        fromFrame(frame, {
          type: "slop:edit-selection",
          slide: "intro",
          selected: true,
          selection: { kind: "text", text: true, flippable: false },
        });
        expect(button("Flip horizontally").hasAttribute("disabled")).toBe(true);
        expect(button("Flip horizontally").title).toBe("Text and plain boxes have nothing to flip");
        // A line is mirrored through its points.
        fromFrame(frame, {
          type: "slop:edit-selection",
          slide: "intro",
          selected: true,
          selection: { kind: "drawing", vector: true, flippable: true, line: { start: null, end: "arrow" } },
        });
        expect(button("Flip horizontally").hasAttribute("disabled")).toBe(false);
      });

      it("rotates the selection in 3D from the toolbar, with the reset in the middle", () => {
        const button = (name: string) => screen.getByRole("button", { name });
        const { container } = render(<Stage />);
        toggleEditing();
        const { frame, post } = loaded(container);
        const geometry = { count: 1, x: 10, y: 20, w: 300, h: 200, rotation: 0 };
        fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry });
        fireEvent.click(button("Position and size"));
        const grid = within(screen.getByRole("group", { name: "3D rotate" })).getAllByRole("button");
        expect(grid.map((b) => b.getAttribute("aria-label"))).toEqual([
          "Rotate top left 5° in 3D",
          "Rotate top 5° in 3D",
          "Rotate top right 5° in 3D",
          "Rotate left 5° in 3D",
          "Reset the 3D rotation",
          "Rotate right 5° in 3D",
          "Rotate bottom left 5° in 3D",
          "Rotate bottom 5° in 3D",
          "Rotate bottom right 5° in 3D",
        ]);
        const sent = [[5, -5], [5, 0], [5, 5], [0, -5], null, [0, 5], [-5, -5], [-5, 0], [-5, 5]];
        grid.forEach((b, i) => {
          // Pressing it leaves focus, and any text selection, in the slide.
          expect(fireEvent.mouseDown(b)).toBe(false);
          fireEvent.click(b);
          const step = sent[i];
          expect(post).toHaveBeenLastCalledWith(
            step ? { type: "slop:edit-tilt", x: step[0], y: step[1] } : { type: "slop:edit-tilt", reset: true },
            "*",
          );
        });
        // The panel stays through the preview's reload after a save, its buttons waiting for the selection.
        fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry: null });
        expect(button("Rotate top 5° in 3D").hasAttribute("disabled")).toBe(true);
        fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry });
        expect(button("Rotate top 5° in 3D").hasAttribute("disabled")).toBe(false);
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

      it("copies the slide, not an element, with ⌘C after a press on the slide rail", () => {
        const { container } = render(
          <>
            <Stage />
            <div data-slide-rail>
              <button type="button" data-testid="rail-slide" />
            </div>
          </>,
        );
        toggleEditing();
        const { post } = loaded(container);
        // Focus in the rail.
        fireEvent.keyDown(screen.getByTestId("rail-slide"), { key: "c", metaKey: true });
        expect(invoke).toHaveBeenCalledWith("copy_slides", { id: useApp.getState().deck!.id, slides: ["intro"] });
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-copy" }), "*");
        // Focus left on the body by the press (WebKit), until a press elsewhere.
        vi.mocked(invoke).mockClear();
        fireEvent.pointerDown(screen.getByTestId("rail-slide"));
        const copy = new KeyboardEvent("keydown", { key: "c", metaKey: true, cancelable: true, bubbles: true });
        act(() => void document.body.dispatchEvent(copy));
        expect(copy.defaultPrevented).toBe(true);
        expect(invoke).toHaveBeenCalledWith("copy_slides", expect.anything());
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-copy" }), "*");
        // ⌘X, ⌘D and ⌘A on the rail are about the slides too, not the slide's elements.
        const cutSlides = vi.fn(async () => {});
        const realCut = useApp.getState().cutSlides;
        useApp.setState({ cutSlides });
        fireEvent.keyDown(document.body, { key: "x", metaKey: true });
        expect(cutSlides).toHaveBeenCalledOnce();
        fireEvent.keyDown(document.body, { key: "a", metaKey: true });
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-copy" }), "*");
        expect(post).not.toHaveBeenCalledWith({ type: "slop:edit-select-all" }, "*");
        expect(useApp.getState().railSelected).toEqual(["intro", "#2", "outro"]);
        useApp.setState({ cutSlides: realCut, railSelected: [] });
        // ⌘V on the rail stays with the editor, whose paste takes slides as well.
        fireEvent.keyDown(document.body, { key: "v", metaKey: true });
        expect(invoke).toHaveBeenCalledWith("paste_from_clipboard", expect.anything());
        expect(invoke).not.toHaveBeenCalledWith("paste_slides", expect.anything());
        vi.mocked(invoke).mockClear();
        fireEvent.pointerDown(container);
        fireEvent.keyDown(document.body, { key: "c", metaKey: true });
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-copy", cut: false }, "*");
        expect(invoke).not.toHaveBeenCalledWith("copy_slides", expect.anything());
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
          command === "paste_slides"
            ? { deck: pasted, previous: "<old>", source: "<new>", created: ["pasted"] }
            : { kind: "slide" },
        );
        const { container } = render(<Stage />);
        toggleEditing();
        const { post } = loaded(container);
        await act(async () => void fireEvent.keyDown(document.body, { key: "v", metaKey: true }));
        await waitFor(() => expect(useApp.getState().selected).toBe("pasted"));
        expect(invoke).toHaveBeenCalledWith("paste_slides", { id: deck.id, after: "intro" });
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
        await waitFor(() => expect(lastError(useApp.getState())).toBe("no clipboard"));
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
      useApp.setState({ undo });
      const { container } = render(<Stage />);
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
      useApp.setState({ undo, redo });
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
        danger: expect.any(String),
        guide: expect.any(String),
        handle: expect.any(String),
        handleForeground: expect.any(String),
        overlay: expect.any(String),
        overlayForeground: expect.any(String),
        scrim: expect.any(String),
        search: expect.any(String),
        searchActive: expect.any(String),
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
      // The stage is 960px wide for a 1920px slide in these tests: fit to it, the slide shows at 50%.
      const zoom = () => screen.getByRole("button", { name: /^Zoom: / });
      const level = () => zoom().textContent;
      const enterEditing = () => {
        const utils = render(<Stage />);
        toggleEditing();
        const frames = utils.container.querySelectorAll("iframe");
        const frame = frames[frames.length - 1]!;
        return { ...utils, frame };
      };
      const pickLevel = (name: string) => {
        fireEvent.click(zoom());
        fireEvent.click(within(screen.getByRole("menu", { name: "Zoom level" })).getByRole("menuitemradio", { name }));
      };

      it("always shows the zoom: Fit for the whole slide, else the slide's real size in percent", () => {
        const { frame } = enterEditing();
        fireEvent.load(frame);
        expect(level()).toBe("Fit");
        fromFrame(frame, { type: "slop:view", slide: "intro", x: 0, y: 0, k: 1 });
        expect(level()).toBe("Fit");
        fromFrame(frame, { type: "slop:view", slide: "intro", x: -400, y: 120, k: 0.5 });
        expect(level()).toBe("25%");
        // Panned only, it is no longer the whole slide in the middle, at the size it fits at.
        fromFrame(frame, { type: "slop:view", slide: "intro", x: 30, y: 0, k: 1 });
        expect(level()).toBe("50%");
        const post = vi.spyOn(frame.contentWindow!, "postMessage");
        pickLevel("Fit");
        expect(post).toHaveBeenCalledWith({ type: "slop:camera", home: true }, "*");
        expect(screen.queryByRole("menu")).toBeNull();
        fromFrame(frame, { type: "slop:view", slide: "intro", x: 0, y: 0, k: 1 });
        expect(level()).toBe("Fit");
      });

      it("zooms out and in by a step, and to the levels of its menu, around the middle of the view", () => {
        const { container } = render(<Stage />);
        const viewer = stageFrame(container);
        fireEvent.load(viewer);
        const post = vi.spyOn(viewer.contentWindow!, "postMessage");
        fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:camera", zoomBy: 1.25 }, "*");
        fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:camera", zoomBy: 0.8 }, "*");
        expect(screen.getByRole("button", { name: "Zoom in" }).title).toBe("Zoom in (Ctrl++)");
        expect(screen.getByRole("button", { name: "Zoom out" }).title).toBe("Zoom out (Ctrl+-)");

        fireEvent.click(zoom());
        const items = within(screen.getByRole("menu", { name: "Zoom level" })).getAllByRole("menuitemradio");
        expect(items.map((item) => item.textContent)).toEqual(["Fit", "50%", "100%", "200%"]);
        expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
        fireEvent.click(items[2]!);
        // 100% is the slide's own pixels: twice the size it fits this stage at.
        expect(post).toHaveBeenCalledWith({ type: "slop:camera", zoomTo: 2 }, "*");
        fromFrame(viewer, { type: "slop:view", slide: "intro", x: 0, y: 0, k: 2 });
        expect(level()).toBe("100%");
        fireEvent.click(zoom());
        expect(screen.getByRole("menuitemradio", { name: "100%" }).getAttribute("aria-checked")).toBe("true");
        fireEvent.click(screen.getByRole("menuitemradio", { name: "200%" }));
        expect(post).toHaveBeenCalledWith({ type: "slop:camera", zoomTo: 4 }, "*");
      });

      it("zooms with ⌘+ / ⌘- and fits with ⌘0 or 0 pressed in the app, unless typing or presenting", () => {
        const { container } = render(
          <>
            <Stage />
            <textarea data-testid="composer" />
          </>,
        );
        const viewer = stageFrame(container);
        fireEvent.load(viewer);
        const post = vi.spyOn(viewer.contentWindow!, "postMessage");
        const camera = () => post.mock.calls.filter(([data]) => (data as { type?: string }).type === "slop:camera");
        const press = (key: string, more: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key, ...more });
        expect(press("=", { ctrlKey: true })).toBe(false);
        expect(post).toHaveBeenLastCalledWith({ type: "slop:camera", zoomBy: 1.25 }, "*");
        press("+", { ctrlKey: true, shiftKey: true });
        expect(camera()).toHaveLength(2);
        press("-", { ctrlKey: true });
        expect(post).toHaveBeenLastCalledWith({ type: "slop:camera", zoomBy: 0.8 }, "*");
        press("0", { ctrlKey: true });
        expect(post).toHaveBeenLastCalledWith({ type: "slop:camera", home: true }, "*");
        press("0");
        expect(camera()).toHaveLength(5);
        // Not with Alt, not from a field, not during a show.
        press("=", { ctrlKey: true, altKey: true });
        fireEvent.keyDown(screen.getByTestId("composer"), { key: "0" });
        fireEvent.keyDown(screen.getByTestId("composer"), { key: "=", ctrlKey: true });
        act(() => useApp.setState({ presenting: true }));
        press("0");
        act(() => useApp.setState({ presenting: false }));
        expect(camera()).toHaveLength(5);
      });

      it("ignores views from other slides or windows", () => {
        const { frame } = enterEditing();
        fromFrame(frame, { type: "slop:view", slide: "other", x: 5, y: 5, k: 2 });
        fromFrame(null, { type: "slop:view", slide: "intro", x: 5, y: 5, k: 2 });
        fromFrame(frame, { type: "slop:view", slide: "intro", x: "a", y: 5, k: 2 });
        expect(level()).toBe("Fit");
        fromFrame(frame, { type: "slop:view", slide: "intro", x: 5, y: 5, k: 2 });
        expect(level()).toBe("100%");
      });

      it("pans and zooms in view mode too, and keeps the view entering and leaving edit mode", () => {
        const { container } = render(<Stage />);
        const viewer = stageFrame(container);
        fireEvent.load(viewer);
        fromFrame(viewer, { type: "slop:view", slide: "intro", x: 40, y: -20, k: 2 });
        expect(level()).toBe("100%");
        toggleEditing();
        expect(level()).toBe("100%");
        const editor = [...container.querySelectorAll("iframe")].at(-1)!;
        const post = vi.spyOn(editor.contentWindow!, "postMessage");
        fireEvent.load(editor);
        expect(post).toHaveBeenCalledWith({ type: "slop:camera", x: 40, y: -20, k: 2 }, "*");
        toggleEditing();
        expect(level()).toBe("100%");
      });

      it("starts each slide centered at full size", () => {
        const { container } = render(<Stage />);
        fromFrame(stageFrame(container), { type: "slop:view", slide: "intro", x: 40, y: -20, k: 2 });
        expect(level()).toBe("100%");
        act(() => useApp.getState().select("outro"));
        expect(level()).toBe("Fit");
        const post = vi.spyOn(stageFrame(container).contentWindow!, "postMessage");
        fireEvent.load(stageFrame(container));
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:camera" }), "*");
        act(() => useApp.getState().select("intro"));
        expect(level()).toBe("Fit");
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
      // "Copy" is not "Copy style".
      const named = (name: string) => new RegExp(`^${name}(?! style)`);
      const item = (name: string) => screen.getByRole("menuitem", { name: named(name) }) as HTMLButtonElement;
      const noItem = (name: string) => expect(screen.queryByRole("menuitem", { name: named(name) })).toBeNull();

      function open(element: typeof ELEMENT | null = ELEMENT, more: Record<string, unknown> = {}) {
        const { container } = render(<Stage />);
        toggleEditing();
        const frame = stageFrame(container);
        fireEvent.load(frame);
        const post = vi.spyOn(frame.contentWindow!, "postMessage");
        // The right-click is a press in the slide first, which the preview reports.
        fromFrame(frame, { type: "slop:press" });
        post.mockClear();
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 100, y: 50, element, ...more });
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

      it("groups several, takes a group apart, and locks or unlocks, when each applies", () => {
        const { frame, post } = open();
        // One plain element can be neither grouped nor taken apart.
        noItem("Group");
        noItem("Ungroup");
        expect(item("Lock").textContent).toContain("Ctrl+Alt+L");
        fireEvent.click(item("Lock"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-lock", locked: true }, "*");
        const selection = (look: object) =>
          fromFrame(frame, { type: "slop:edit-selection", slide: "intro", selected: true, selection: look });
        fromFrame(frame, {
          type: "slop:edit-geometry",
          slide: "intro",
          geometry: { count: 2, x: 0, y: 0, w: 1, h: 1 },
        });
        selection({ kind: "group", group: true });
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 1, y: 1, element: ELEMENT });
        fireEvent.click(item("Group"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-group" }, "*");
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 1, y: 1, element: ELEMENT });
        fireEvent.click(item("Ungroup"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-ungroup" }, "*");
        // What is locked can be unlocked and copied, and asked about; nothing that would change it.
        selection({ kind: "group", group: true, locked: true });
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 1, y: 1, element: ELEMENT });
        expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
          "UnlockCtrl+Alt+L",
          "CopyCtrl+C",
          "Ask the agent about this…",
        ]);
        fireEvent.click(item("Unlock"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-lock", locked: false }, "*");
      });

      it("edits text, and copies and pastes a look, where each applies", () => {
        const { frame, post } = open(ELEMENT, { editable: true });
        // Nothing was copied yet.
        noItem("Paste style");
        fireEvent.click(item("Edit text"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-edit-text" }, "*");
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 1, y: 1, element: ELEMENT });
        noItem("Edit text");
        fireEvent.click(screen.getByRole("menuitem", { name: /^Copy style/ }));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-copy-style" }, "*");
        // The editor hands the look over, and the app keeps it for any slide.
        const style = { vector: false, shared: { opacity: 1 }, paint: {}, text: {} };
        fromFrame(frame, { type: "slop:edit-style-copied", slide: "intro", style });
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 1, y: 1, element: ELEMENT });
        fireEvent.click(item("Paste style"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-paste-style", style }, "*");
        // The editor's own shortcut asks for it too.
        post.mockClear();
        fromFrame(frame, { type: "slop:edit-request", slide: "intro", what: "paste-style" });
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-paste-style", style }, "*");
        act(() => useApp.setState({ copiedStyle: null }));
      });

      it("flips what can be flipped, offered only then", () => {
        const { frame, post } = open();
        expect(screen.queryByRole("menuitem", { name: "Flip horizontally" })).toBeNull();
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
        fromFrame(frame, {
          type: "slop:edit-selection",
          slide: "intro",
          selected: true,
          selection: { kind: "shape", text: true, flippable: true, flipY: true },
        });
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 1, y: 1, element: ELEMENT });
        fireEvent.click(item("Flip horizontally"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-flip", axis: "x" }, "*");
        expect(screen.queryByRole("menu")).toBeNull();
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 1, y: 1, element: ELEMENT });
        fireEvent.click(item("Flip vertically"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-flip", axis: "y" }, "*");
      });

      it("opens a drawing in the SVG editor, offered only for drawings", () => {
        const { frame, post } = open();
        expect(screen.queryByRole("menuitem", { name: "Edit in the SVG editor" })).toBeNull();
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
        fromFrame(frame, {
          type: "slop:edit-menu",
          slide: "intro",
          x: 1,
          y: 1,
          element: { ...ELEMENT, markup: '<svg viewBox="0 0 1 1"></svg>', name: "<svg>" },
        });
        fireEvent.click(item("Edit in the SVG editor"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-open-svg" }, "*");
        expect(screen.queryByRole("menu")).toBeNull();
      });

      it("hands a drawing the slide editor opens to the SVG editor, for the slide shown only", async () => {
        const { frame } = open();
        const drawing = {
          type: "slop:edit-open-svg",
          path: [2],
          markup: "<svg><rect></rect></svg>",
          width: 300,
          height: 150,
          color: "red",
          vars: { "--brand": "#f00" },
        };
        fromFrame(frame, { ...drawing, slide: "outro" });
        expect(useSvgEditor.getState().edit).toBeNull();
        fromFrame(frame, { ...drawing, slide: "intro" });
        await waitFor(() =>
          expect(useSvgEditor.getState().edit).toMatchObject({
            slide: "intro",
            path: [2],
            original: "<svg><rect></rect></svg>",
            size: { w: 300, h: 150 },
            vars: { "--brand": "#f00" },
          }),
        );
        expect(useApp.getState().sidebarTab).toBe("svg");
        useSvgEditor.setState({ edit: null });
      });

      it("pastes from the clipboard", async () => {
        vi.mocked(invoke).mockResolvedValue({ kind: "element", html: "<p>Pasted</p>" });
        const { post } = open();
        fireEvent.click(item("Paste"));
        // Where the menu was opened, in the preview's pixels.
        await waitFor(() =>
          expect(post).toHaveBeenCalledWith({ type: "slop:edit-paste", html: "<p>Pasted</p>", x: 100, y: 50 }, "*"),
        );
      });

      it("pastes with ⌘V where the element was copied from, giving no point", async () => {
        vi.mocked(invoke).mockResolvedValue({ kind: "element", html: "<p>Pasted</p>" });
        const { frame, post } = open();
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
        fromFrame(frame, { type: "slop:key", key: "v", mod: true, shift: false });
        await waitFor(() => expect(post).toHaveBeenCalledWith({ type: "slop:edit-paste", html: "<p>Pasted</p>" }, "*"));
      });

      it("offers on an empty spot only what applies there", () => {
        const { frame, post } = open(null);
        expect(screen.getByRole("menu", { name: "Slide" })).toBeTruthy();
        expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
          "PasteCtrl+V",
          "Select allCtrl+A",
          "Slide background…",
        ]);
        fireEvent.click(item("Select all"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-select-all" }, "*");
        // With something locked on the slide, it can all be unlocked from here.
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 1, y: 1, element: null, locked: true });
        fireEvent.click(item("Unlock all on this slide"));
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-unlock-all" }, "*");
        // The slide's background opens in the ribbon.
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 1, y: 1, element: null });
        fireEvent.click(item("Slide background"));
        expect(screen.getByRole("dialog", { name: "Slide background" })).toBeTruthy();
      });

      it("asks the agent about every selected element", () => {
        const ask = vi.fn().mockResolvedValue(undefined);
        const { askAboutElements } = useApp.getState();
        useApp.setState({ askAboutElements: ask });
        const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
          cb(0);
          return 0;
        });
        const other = { ...ELEMENT, path: "#intro > p:nth-child(2)", name: "<p>" };
        open(ELEMENT, { elements: [ELEMENT, other] });
        // One element's own choices give way.
        noItem("Tidy this");
        fireEvent.click(item("Ask the agent about these 2 elements…"));
        expect(ask).toHaveBeenCalledWith([ELEMENT, other]);
        raf.mockRestore();
        useApp.setState({ askAboutElements });
      });

      it("hands the element to the agent with the view reset, the menu gone first", () => {
        const ask = vi.fn().mockResolvedValue(undefined);
        const { askAboutElements } = useApp.getState();
        useApp.setState({ askAboutElements: ask });
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
        expect(ask).toHaveBeenCalledWith([ELEMENT]);
        raf.mockRestore();
        useApp.setState({ askAboutElements });
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
        noItem("Tidy this");
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
        fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 1, y: 1, element: ELEMENT });
        act(() => useApp.setState({ running: true }));
        expect(item("Tidy this").disabled).toBe(true);
        expect(item("Tidy this").title).toBe("The agent is busy");
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
        fireEvent.keyDown(document.activeElement!, { key: "Home" });
        expect(document.activeElement).toBe(item("Cut"));
        fireEvent.keyDown(document.activeElement!, { key: "End" });
        expect(document.activeElement).toBe(item("Tidy this"));
        expect(useApp.getState().selected).toBe("intro");
        fireEvent.keyDown(document.activeElement!, { key: "t" });
        expect(useApp.getState().editTool).toBe("select");
      });
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
