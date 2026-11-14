import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useApp } from "../../store";
import { DECK_HTML, deckFor } from "../../test/fixtures";
import { Stage } from "../Stage";
import { zoomKey } from "./usePasteboard";

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

function fromFrame(frame: HTMLIFrameElement, data: unknown) {
  act(() => void window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow })));
}

describe("the slide editor's keys pressed in the app", () => {
  const { selectRelative, undo, askForEditPanel } = useApp.getState();
  let undoLayout: () => void;

  beforeEach(() => {
    undoLayout = layOutStage();
    useApp.setState({
      deck: deckFor(DECK_HTML),
      selected: "intro",
      presenting: false,
      editing: false,
      editReload: 0,
      editBase: null,
      editedSlides: [],
      railSelected: [],
      slideMode: "view",
    });
  });
  afterEach(() => {
    undoLayout();
    useApp.setState({ selectRelative, undo, askForEditPanel });
    vi.restoreAllMocks();
  });

  /** The stage in edit mode, with `selection` reported as the editor's, and what is posted to its preview. */
  const editStage = (selection: Record<string, unknown> | null) => {
    const { container } = render(
      <>
        <Stage />
        <button type="button">Elsewhere</button>
        <div data-slide-rail="">
          <button type="button">Rail</button>
        </div>
      </>,
    );
    act(() => useApp.getState().setMode("edit"));
    const frame = container.querySelector("iframe")!;
    fireEvent.load(frame);
    fromFrame(frame, { type: "slop:edit-selection", slide: "intro", selected: !!selection, selection });
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    return { frame, post };
  };

  it("nudges and deletes what is selected on the slide with the arrows and Delete, instead of changing slide", () => {
    const go = vi.fn();
    useApp.setState({ selectRelative: go });
    const { post } = editStage({ kind: "shape", text: true });
    const elsewhere = screen.getByText("Elsewhere");
    fireEvent.keyDown(elsewhere, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(elsewhere, { key: "Backspace" });
    expect(post).toHaveBeenCalledWith({ type: "slop:edit-key", key: "ArrowRight", shift: true }, "*");
    expect(post).toHaveBeenCalledWith({ type: "slop:edit-key", key: "Backspace", shift: false }, "*");
    expect(go).not.toHaveBeenCalled();
    // In the slide list, the arrows are the slides'.
    fireEvent.keyDown(screen.getByText("Rail"), { key: "ArrowRight" });
    expect(go).toHaveBeenCalledWith(1);
  });

  it("changes slide with the arrows when nothing is selected, or while typing in the slide", () => {
    const go = vi.fn();
    useApp.setState({ selectRelative: go });
    const { frame, post } = editStage(null);
    fireEvent.keyDown(screen.getByText("Elsewhere"), { key: "ArrowRight" });
    expect(go).toHaveBeenCalledTimes(1);
    fromFrame(frame, {
      type: "slop:edit-selection",
      slide: "intro",
      selected: true,
      selection: { kind: "text", editing: true },
    });
    fireEvent.keyDown(screen.getByText("Elsewhere"), { key: "ArrowRight" });
    expect(go).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-key" }), "*");
  });

  it("undoes the typing first with ⌘Z while the slide's text is being typed", () => {
    const appUndo = vi.fn(async () => {});
    useApp.setState({ undo: appUndo });
    const { post } = editStage({ kind: "text", text: true, editing: true });
    fireEvent.keyDown(screen.getByText("Elsewhere"), { key: "z", ctrlKey: true, metaKey: true });
    fireEvent.keyDown(screen.getByText("Elsewhere"), { key: "z", ctrlKey: true, metaKey: true, shiftKey: true });
    expect(post).toHaveBeenCalledWith({ type: "slop:edit-undo", redo: false }, "*");
    expect(post).toHaveBeenCalledWith({ type: "slop:edit-undo", redo: true }, "*");
    expect(appUndo).not.toHaveBeenCalled();
  });

  it("pastes the clipboard's text alone, as a text box, with ⇧⌘V on the slide", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command === "read_clipboard_text" ? "Plain words" : undefined,
    );
    const { frame, post } = editStage({ kind: "image" });
    await act(async () => fromFrame(frame, { type: "slop:key", key: "v", mod: true, shift: true }));
    expect(invoke).toHaveBeenCalledWith("read_clipboard_text");
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "slop:edit-paste-text", text: "Plain words" }),
      "*",
    );
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-flip" }), "*");
  });

  it("asks for Replace image… when the editor says an image was double-clicked", () => {
    const ask = vi.fn();
    useApp.setState({ askForEditPanel: ask });
    const { frame } = editStage({ kind: "image" });
    fromFrame(frame, { type: "slop:edit-request", slide: "intro", what: "replace-image" });
    expect(ask).toHaveBeenCalledWith("replace-image");
  });
});

describe("zoomKey", () => {
  const key = (k: string, more: Partial<KeyboardEvent> = {}) =>
    zoomKey({ key: k, code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...more });

  it("zooms in, out and to fit with the modifier, and fits with a plain 0", () => {
    expect(key("=", { ctrlKey: true, metaKey: true })).toBe("in");
    expect(key("-", { ctrlKey: true, metaKey: true })).toBe("out");
    expect(key("0", { ctrlKey: true, metaKey: true })).toBe("fit");
    expect(key("0")).toBe("fit");
  });

  it("shows the real size with ⇧0 and the selection with ⇧2, by their place on the keyboard", () => {
    expect(key(")", { shiftKey: true, code: "Digit0" })).toBe("actual");
    expect(key("=", { shiftKey: true, code: "Digit0" })).toBe("actual");
    expect(key("@", { shiftKey: true, code: "Digit2" })).toBe("selection");
    expect(key('"', { shiftKey: true, code: "Digit2" })).toBe("selection");
    // Where Shift types the digit itself, it is the digit; with Alt, nothing.
    expect(key("0", { shiftKey: true, code: "Digit0" })).toBe("fit");
    expect(key("2", { shiftKey: true, code: "Digit2" })).toBeNull();
    expect(key("@", { shiftKey: true, altKey: true, code: "Digit2" })).toBeNull();
    // ⌘1 to ⌘3 are the modes'.
    expect(key("1", { ctrlKey: true, metaKey: true })).toBeNull();
  });
});
