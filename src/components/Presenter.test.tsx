import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setFullscreen = vi.fn(async () => {});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setFullscreen }) }));

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { Presenter } from "./Presenter";

beforeEach(() => {
  setFullscreen.mockClear();
  useApp.setState({ deck: deckFor(DECK_HTML), selected: "outro", presenting: true, revealRev: 0 });
});

const frame = () => screen.getByTitle("Presentation") as HTMLIFrameElement;

function fromFrame(data: unknown, source: MessageEventSource | null = frame().contentWindow) {
  act(() => void window.dispatchEvent(new MessageEvent("message", { data, source })));
}

describe("Presenter", () => {
  it("plays the whole deck from the selected slide", () => {
    render(<Presenter />);
    expect(frame().getAttribute("src")).toBe("/__deck/talk/deck.html?v=shell-1#outro");
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("encodes positional slide ids in the hash", () => {
    useApp.setState({ selected: "#2" });
    render(<Presenter />);
    expect(frame().getAttribute("src")).toBe("/__deck/talk/deck.html?v=shell-1#%232");
  });

  it("starts at the beginning without a selection", () => {
    useApp.setState({ selected: null });
    render(<Presenter />);
    expect(frame().getAttribute("src")).toBe("/__deck/talk/deck.html?v=shell-1");
  });

  it("does not restart when the editor selection follows the show", () => {
    render(<Presenter />);
    fromFrame({ type: "slop:slide", id: "intro" });
    expect(useApp.getState().selected).toBe("intro");
    expect(frame().getAttribute("src")).toContain("#outro");
  });

  it("goes full screen for the show and back afterwards", () => {
    const { unmount } = render(<Presenter />);
    expect(setFullscreen).toHaveBeenCalledWith(true);
    unmount();
    expect(setFullscreen).toHaveBeenLastCalledWith(false);
  });

  it("Escape ends the show, from the app or from inside the slide", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useApp.getState().presenting).toBe(false);
    useApp.setState({ presenting: true });
    fromFrame({ type: "slop:key", key: "Escape" });
    expect(useApp.getState().presenting).toBe(false);
  });

  it("hands other keys to the player", () => {
    render(<Presenter />);
    const focus = vi.spyOn(frame(), "focus");
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(focus).toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith({ type: "slop:go", key: "ArrowRight" }, "*");
    expect(useApp.getState().presenting).toBe(true);
  });

  it("ignores messages that are not from the show", () => {
    render(<Presenter />);
    fromFrame({ type: "slop:key", key: "Escape" }, window);
    fromFrame({ type: "slop:slide", id: "intro" }, null);
    fromFrame({ type: "slop:slide", id: null });
    fromFrame("not an object");
    expect(useApp.getState().presenting).toBe(true);
    expect(useApp.getState().selected).toBe("outro");
  });

  it("stops listening after the show", () => {
    const { unmount } = render(<Presenter />);
    unmount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useApp.getState().presenting).toBe(true);
  });

  it("renders nothing without a deck", () => {
    useApp.setState({ deck: null });
    render(<Presenter />);
    expect(screen.queryByTitle("Presentation")).toBeNull();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});

describe("Presenter tools", () => {
  const layer = () => screen.getByTestId("annotation-layer");
  const tool = (name: RegExp) => screen.getByRole("button", { name });
  const pressed = (name: RegExp) => tool(name).getAttribute("aria-pressed") === "true";
  const strokes = () => layer().querySelectorAll("[data-stroke]");

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 500));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function draw(points: [number, number][]) {
    const [first, ...rest] = points;
    fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: first![0], clientY: first![1], pointerId: 1 });
    for (const [x, y] of rest) fireEvent.pointerMove(layer(), { buttons: 1, clientX: x, clientY: y, pointerId: 1 });
    fireEvent.pointerUp(layer(), { pointerId: 1 });
  }

  it("starts with the slide clickable and no tool", () => {
    render(<Presenter />);
    expect(pressed(/^Pointer/)).toBe(true);
    expect(layer().style.pointerEvents).toBe("none");
  });

  it("keyboard shortcuts pick tools, and the same key puts the tool away", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "p" });
    expect(pressed(/^Pen/)).toBe(true);
    expect(layer().style.pointerEvents).toBe("auto");
    fireEvent.keyDown(document.body, { key: "H" });
    expect(pressed(/^Highlighter/)).toBe(true);
    fireEvent.keyDown(document.body, { key: "e" });
    expect(pressed(/^Eraser/)).toBe(true);
    fireEvent.keyDown(document.body, { key: "l" });
    expect(pressed(/^Laser/)).toBe(true);
    fireEvent.keyDown(document.body, { key: "l" });
    expect(pressed(/^Pointer/)).toBe(true);
  });

  it("shortcuts also work while the slide has focus", () => {
    render(<Presenter />);
    fromFrame({ type: "slop:key", key: "p", mod: false });
    expect(pressed(/^Pen/)).toBe(true);
  });

  it("tool shortcuts are not passed on to the player", () => {
    render(<Presenter />);
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    fireEvent.keyDown(document.body, { key: "p" });
    expect(post).not.toHaveBeenCalled();
  });

  it("Escape puts the tool away first, then ends the show", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "p" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(pressed(/^Pointer/)).toBe(true);
    expect(useApp.getState().presenting).toBe(true);
    fromFrame({ type: "slop:key", key: "Escape" });
    expect(useApp.getState().presenting).toBe(false);
  });

  it("toolbar buttons pick tools and end the show", () => {
    render(<Presenter />);
    fireEvent.click(tool(/^Highlighter/));
    expect(pressed(/^Highlighter/)).toBe(true);
    fireEvent.click(tool(/^End show/));
    expect(useApp.getState().presenting).toBe(false);
  });

  it("the pen draws strokes in fractions of the screen", () => {
    render(<Presenter />);
    fireEvent.click(tool(/^Pen/));
    draw([
      [100, 100],
      [200, 150],
      [300, 250],
    ]);
    expect(strokes()).toHaveLength(1);
    const path = strokes()[0]!;
    expect(path.getAttribute("d")).toBe("M100 100L200 150L300 250");
    expect(path.getAttribute("stroke")).toBe("#ef4444");
    expect(path.getAttribute("stroke-width")).toBe("4");
  });

  it("the highlighter draws wide, translucent strokes", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "h" });
    draw([
      [0, 0],
      [500, 250],
    ]);
    const path = strokes()[0]!;
    expect(path.getAttribute("stroke")).toBe("#facc15");
    expect(path.getAttribute("stroke-width")).toBe("28");
    expect(path.getAttribute("stroke-opacity")).toBe("0.4");
  });

  it("a tap leaves a dot the size of the tool, not a highlighted screen", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "h" });
    draw([[300, 200]]);
    expect(layer().querySelector("path")).toBeNull();
    const dot = strokes()[0]!;
    expect(dot.tagName).toBe("circle");
    expect(dot.getAttribute("cx")).toBe("300");
    expect(dot.getAttribute("cy")).toBe("200");
    expect(dot.getAttribute("r")).toBe("14");
    expect(dot.getAttribute("fill")).toBe("#facc15");
    expect(dot.getAttribute("fill-opacity")).toBe("0.4");
    fireEvent.keyDown(document.body, { key: "p" });
    draw([[10, 10]]);
    expect(strokes()[1]!.getAttribute("r")).toBe("2");
  });

  it("draws in pixels so strokes keep their width, and follows resizes", () => {
    const resized: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "p" });
    draw([
      [100, 100],
      [500, 250],
    ]);
    const svg = layer().querySelector("svg")!;
    expect(svg.hasAttribute("viewBox")).toBe(false);
    expect(strokes()[0]!.hasAttribute("vector-effect")).toBe(false);
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 2000, 1000));
    act(() => resized.forEach((callback) => callback()));
    expect(strokes()[0]!.getAttribute("d")).toBe("M200 200L1000 500");
  });

  it("colors apply to the active ink tool", () => {
    render(<Presenter />);
    expect(screen.queryByRole("button", { name: /^Color/ })).toBeNull();
    fireEvent.click(tool(/^Pen/));
    fireEvent.click(tool(/Color #3b82f6/));
    expect(tool(/Color #3b82f6/).getAttribute("aria-pressed")).toBe("true");
    draw([
      [10, 10],
      [20, 20],
    ]);
    expect(strokes()[0]!.getAttribute("stroke")).toBe("#3b82f6");
    fireEvent.click(tool(/^Highlighter/));
    expect(tool(/Color #facc15/).getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores right clicks and moves without a press", () => {
    render(<Presenter />);
    fireEvent.click(tool(/^Pen/));
    fireEvent.pointerDown(layer(), { button: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(layer(), { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(layer());
    expect(strokes()).toHaveLength(0);
  });

  it("undo removes the last stroke, clear removes them all", () => {
    render(<Presenter />);
    expect((tool(/^Undo/) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(tool(/^Pen/));
    draw([[10, 10]]);
    draw([[20, 20]]);
    draw([[30, 30]]);
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    expect(strokes()).toHaveLength(2);
    fromFrame({ type: "slop:key", key: "z", mod: true });
    expect(strokes()).toHaveLength(1);
    fireEvent.click(tool(/^Undo/));
    expect(strokes()).toHaveLength(0);
    draw([[10, 10]]);
    draw([[20, 20]]);
    fireEvent.keyDown(document.body, { key: "c" });
    expect(strokes()).toHaveLength(0);
    draw([[10, 10]]);
    fireEvent.click(tool(/^Clear slide/));
    expect(strokes()).toHaveLength(0);
  });

  it("modifier shortcuts other than undo are left alone", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "p", metaKey: true });
    expect(pressed(/^Pointer/)).toBe(true);
  });

  it("the eraser removes the strokes it touches", () => {
    render(<Presenter />);
    fireEvent.click(tool(/^Pen/));
    draw([[10, 10]]);
    draw([[20, 20]]);
    draw([[30, 30]]);
    fireEvent.click(tool(/^Eraser/));
    fireEvent.pointerDown(strokes()[1]!, { button: 0, buttons: 1 });
    expect(strokes()).toHaveLength(2);
    fireEvent.pointerMove(strokes()[0]!, { buttons: 0 });
    expect(strokes()).toHaveLength(2);
    fireEvent.pointerMove(strokes()[0]!, { buttons: 1 });
    expect(strokes()).toHaveLength(1);
    fireEvent.pointerDown(layer(), { button: 0, buttons: 1 });
    expect(strokes()).toHaveLength(1);
  });

  it("keeps ink with the slide it was drawn on", () => {
    render(<Presenter />);
    fromFrame({ type: "slop:slide", id: "intro", index: 0 });
    fireEvent.click(tool(/^Pen/));
    draw([[10, 10]]);
    fromFrame({ type: "slop:slide", id: null, index: 1 });
    expect(strokes()).toHaveLength(0);
    draw([[20, 20]]);
    draw([[30, 30]]);
    fromFrame({ type: "slop:slide", id: "intro", index: 0 });
    expect(strokes()).toHaveLength(1);
    fromFrame({ type: "slop:slide", id: null, index: 1 });
    expect(strokes()).toHaveLength(2);
  });

  it("the laser shows a dot that follows the pointer", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "l" });
    expect(layer().style.cursor).toBe("none");
    expect(screen.queryByTestId("laser")).toBeNull();
    fireEvent.pointerMove(layer(), { clientX: 120, clientY: 80 });
    const dot = screen.getByTestId("laser");
    expect(dot.style.left).toBe("120px");
    expect(dot.style.top).toBe("80px");
    fireEvent.pointerDown(layer(), { button: 0, clientX: 120, clientY: 80 });
    fireEvent.pointerUp(layer());
    expect(strokes()).toHaveLength(0);
    fireEvent.pointerLeave(layer());
    expect(screen.queryByTestId("laser")).toBeNull();
  });

  it("the toolbar shows on hover and briefly after shortcuts", () => {
    vi.useFakeTimers();
    try {
      render(<Presenter />);
      const bar = screen.getByRole("toolbar");
      expect(bar.dataset.visible).toBe("true");
      act(() => void vi.advanceTimersByTime(2000));
      expect(bar.dataset.visible).toBe("false");
      fireEvent.mouseEnter(screen.getByTestId("presenter-toolbar-zone"));
      expect(bar.dataset.visible).toBe("true");
      fireEvent.mouseLeave(screen.getByTestId("presenter-toolbar-zone"));
      expect(bar.dataset.visible).toBe("false");
      fireEvent.keyDown(document.body, { key: "p" });
      expect(bar.dataset.visible).toBe("true");
      act(() => void vi.advanceTimersByTime(2000));
      expect(bar.dataset.visible).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("toolbar buttons do not steal focus from the slide", () => {
    render(<Presenter />);
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    tool(/^Pen/).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
