import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import { flushReviewSave, SKETCH_TARGET_ATTR, useApp } from "../store";
import { DEFAULT_EDIT_STYLES } from "../lib/editTools";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { Stage } from "./Stage";

// Drawing schedules a save of the review marks; finish it here, not in the next test.
afterEach(() => flushReviewSave());

beforeEach(() => {
  useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", presenting: false, sketches: {}, reviewVisible: true });
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

    it("shows and hides the review marks", () => {
      const mark = { tool: "pen" as const, color: "#ef4444", points: [[0.5, 0.5]] as [number, number][] };
      render(<Stage />);
      expect(screen.queryByRole("button", { name: "Hide review marks" })).toBeNull();
      // Marks on any slide offer the toggle, even when the current slide has none.
      act(() => useApp.setState({ sketches: { "#2": [mark] } }));
      fireEvent.click(tool("Draw on the slide"));
      draw([[10, 10]]);
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(1);
      fireEvent.click(tool("Hide review marks"));
      expect(useApp.getState().reviewVisible).toBe(false);
      expect(pressed("Draw on the slide")).toBe(false);
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(0);
      expect(screen.queryByRole("button", { name: "Undo mark" })).toBeNull();
      expect(useApp.getState().sketches.intro).toHaveLength(1);
      fireEvent.click(tool("Show review marks"));
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(1);
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
    const editButton = () => screen.getByRole("button", { name: "Edit text and move elements" });
    const editing = () => editButton().getAttribute("aria-pressed") === "true";
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
          this.callback([{ target, contentRect: { width: 960, height: 540 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
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

    it("shows a pencil icon on the edit button", () => {
      render(<Stage />);
      expect(editButton().querySelector("svg.lucide-pencil")).not.toBeNull();
      expect(editButton().querySelector("svg.lucide-move")).toBeNull();
    });

    it("toggles edit mode, which loads the slide editor into the preview", () => {
      const { container } = render(<Stage />);
      expect(stageFrame(container).getAttribute("src")).not.toContain("edit=");
      fireEvent.click(editButton());
      expect(editing()).toBe(true);
      expect(useApp.getState().editing).toBe(true);
      const sources = [...container.querySelectorAll("iframe")].map((f) => f.getAttribute("src"));
      expect(sources.some((src) => src?.includes("&static&pan&edit=0"))).toBe(true);
      fireEvent.click(editButton());
      expect(useApp.getState().editing).toBe(false);
    });

    it("takes turns with the sketch tools", () => {
      render(<Stage />);
      fireEvent.click(screen.getByRole("button", { name: "Draw on the slide" }));
      fireEvent.click(editButton());
      expect(editing()).toBe(true);
      expect(screen.queryByRole("button", { name: "Draw on the slide" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Accept/ }));
      expect(screen.getByRole("button", { name: "Draw on the slide" }).getAttribute("aria-pressed")).toBe("false");
    });

    it("marks the slide and shows the edit bar while editing", () => {
      const { container } = render(<Stage />);
      const slide = () => container.querySelector("[data-sketch-target]")!;
      expect(slide().hasAttribute("data-editing")).toBe(false);
      expect(screen.queryByRole("toolbar", { name: "Edit tools" })).toBeNull();
      fireEvent.click(editButton());
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
        fireEvent.click(editButton());
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
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-tool", tool: "rect", style: DEFAULT_EDIT_STYLES.shape }, "*");
        fireEvent.click(button("Draw freehand (D)"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-tool", tool: "draw", style: DEFAULT_EDIT_STYLES.draw }, "*");
        fireEvent.click(button("Select and move (V)"));
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-tool", tool: "select", style: undefined }, "*");
      });

      it("tells a reloaded editor the current tool", () => {
        const { frame } = enter();
        fireEvent.click(button("Add text (T)"));
        const post = vi.spyOn(frame.contentWindow!, "postMessage");
        fireEvent.load(frame);
        expect(post).toHaveBeenCalledWith({ type: "slop:edit-tool", tool: "text", style: DEFAULT_EDIT_STYLES.text }, "*");
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
        fireEvent.click(editButton());
        fireEvent.click(editButton());
        expect(useApp.getState().editTool).toBe("select");
      });

      it("has nothing to style until something is selected or a tool is picked", () => {
        const { frame } = enter();
        for (const name of ["Text color", "Bold", "Fill", "Border color", "Bring to front", "Delete (⌫)"]) {
          expect(button(name).disabled).toBe(true);
        }
        select(frame);
        for (const name of ["Text color", "Bold", "Fill", "Border color", "Bring to front", "Delete (⌫)"]) {
          expect(button(name).disabled).toBe(false);
        }
        select(frame, null);
        expect(button("Fill").disabled).toBe(true);
      });

      it("shows the selection's style", () => {
        const { frame } = enter();
        select(frame);
        expect(screen.getByLabelText("Font size").textContent).toBe("40");
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
        expect(useApp.getState().editStyles.shape).toMatchObject({ fontSize: 48, bold: true, valign: "bottom", strokeWidth: 8 });
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
        select(frame, { ...SELECTION, kind: "drawing", text: false, vector: true, stroke: "#ef4444", strokeWidth: 6, fill: null });
        expect(button("Bold").disabled).toBe(true);
        expect(button("Line color").disabled).toBe(false);
        expect((screen.getByLabelText("Line width") as HTMLSelectElement).value).toBe("6");
      });

      it("styles what the tool adds when nothing is selected", () => {
        const { post } = enter();
        fireEvent.click(button("Add text (T)"));
        expect(button("Fill").disabled).toBe(false);
        fireEvent.click(button("Italic"));
        expect(useApp.getState().editStyles.text.italic).toBe(true);
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-style" }), "*");
        expect(post).toHaveBeenLastCalledWith({ type: "slop:edit-tool", tool: "text", style: { ...DEFAULT_EDIT_STYLES.text, italic: true } }, "*");
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
      fireEvent.click(editButton());
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
      fireEvent.click(editButton());
      const frame = stageFrame(container);
      fromFrame(frame, { type: "slop:edit-commit", slide: "intro", markup: MARKUP, select: [0] });
      expect(save).toHaveBeenCalledWith("intro", MARKUP);
      // Not from another slide, a stray window, or outside edit mode.
      fromFrame(frame, { type: "slop:edit-commit", slide: "outro", markup: MARKUP, select: null });
      fromFrame(null, { type: "slop:edit-commit", slide: "intro", markup: MARKUP, select: null });
      fireEvent.click(editButton());
      fromFrame(frame, { type: "slop:edit-commit", slide: "intro", markup: MARKUP, select: null });
      expect(save).toHaveBeenCalledTimes(1);
    });

    it("selects the edited element again once the slide reloads", () => {
      useApp.setState({ saveSlideEdit: vi.fn().mockResolvedValue(undefined) });
      const { container } = render(<Stage />);
      fireEvent.click(editButton());
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
      fireEvent.click(editButton());
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
      fireEvent.click(editButton());
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
      const colors = { type: "slop:canvas", color: expect.any(String), accent: expect.any(String), border: expect.any(String) };
      expect(viewPost).toHaveBeenCalledWith(colors, "*");
      fireEvent.click(editButton());
      expect(slideBox().style.width).toBe("960px");
      const frame = [...container.querySelectorAll("iframe")].at(-1)!;
      expect(frame.getAttribute("src")).toContain("edit=");
      expect(frame.style.width).toBe("2048px");
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      fireEvent.load(frame);
      expect(post).toHaveBeenCalledWith(colors, "*");
      fireEvent.click(editButton());
      expect(slideBox().style.width).toBe("960px");
    });

    describe("pasteboard view", () => {
      const resetButton = () => screen.queryByRole("button", { name: /^\d+%$/ });
      const enterEditing = () => {
        const utils = render(<Stage />);
        fireEvent.click(editButton());
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
        fireEvent.click(editButton());
        expect(resetButton()!.textContent).toBe("200%");
        const editor = [...container.querySelectorAll("iframe")].at(-1)!;
        const post = vi.spyOn(editor.contentWindow!, "postMessage");
        fireEvent.load(editor);
        expect(post).toHaveBeenCalledWith({ type: "slop:camera", x: 40, y: -20, k: 2 }, "*");
        fireEvent.click(editButton());
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
        const ink = () => screen.getByTestId("annotation-view");
        expect(ink().style.transform).toBe("");
        // Slide pixels on a 960px wide slide: half a CSS px each.
        fromFrame(stageFrame(container), { type: "slop:view", slide: "intro", x: 40, y: -20, k: 2 });
        expect(ink().style.transform).toBe("translate(20px, -10px) scale(2)");
        expect(ink().contains(screen.getByTestId("annotation-layer"))).toBe(true);
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
      fireEvent.click(editButton());
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
      fireEvent.click(editButton());
      fromFrame(stageFrame(container), { type: "slop:edit-overflow", slide: "other", items: ["x"] });
      fromFrame(null, { type: "slop:edit-overflow", slide: "intro", items: ["x"] });
      expect(screen.queryByText("Overflow")).toBeNull();
      fromFrame(stageFrame(container), { type: "slop:edit-overflow", slide: "intro", items: ["x"] });
      expect(screen.getByText("Overflow")).toBeTruthy();
      fireEvent.click(editButton());
      expect(screen.queryByText("Overflow")).toBeNull();
    });
  });
});
