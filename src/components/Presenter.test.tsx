import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setFullscreen = vi.fn(async () => {});
const invoke = vi.fn();
const emit = vi.fn(async () => {});
const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: (...args: unknown[]) => emit(...(args as [])),
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setFullscreen }) }));
const playNarration = vi.fn();
vi.mock("../lib/narrationAudio", () => ({ playNarration: (...args: unknown[]) => playNarration(...args) }));

import { LASER_SIZE, TRAIL_FADE_MS, TRAIL_HOLD_MS } from "../lib/ink";
import { saveVideoOptions } from "../lib/video";
import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { fakeCanvas2D } from "../test/fakeCanvas";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { Presenter } from "./Presenter";
import { fitWidth, formatElapsed, remaining } from "./PresenterPanel";
import { PresenterWindow } from "./PresenterWindow";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  emit.mockClear();
  listeners.clear();
  localStorage.removeItem("slopslide.presenterBudget");
  localStorage.removeItem("slopslide.presenterPanel");
  setFullscreen.mockClear();
  useApp.setState({ deck: deckFor(DECK_HTML), selected: "outro", presenting: true, screens: null, revealRev: 0 });
});

const frame = () => screen.getByTitle("Presentation") as HTMLIFrameElement;

function fromFrame(data: unknown, source: MessageEventSource | null = frame().contentWindow) {
  act(() => void window.dispatchEvent(new MessageEvent("message", { data, source })));
}

describe("Presenter", () => {
  it("plays the whole deck from the selected slide", () => {
    render(<Presenter />);
    expect(frame().getAttribute("src")).toBe("/__deck/.file/decks/talk/deck.html?v=shell-1&show#outro");
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("encodes positional slide ids in the hash", () => {
    useApp.setState({ selected: "#2" });
    render(<Presenter />);
    expect(frame().getAttribute("src")).toBe("/__deck/.file/decks/talk/deck.html?v=shell-1&show#%232");
  });

  it("starts at the beginning without a selection", () => {
    useApp.setState({ selected: null });
    render(<Presenter />);
    expect(frame().getAttribute("src")).toBe("/__deck/.file/decks/talk/deck.html?v=shell-1&show");
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

  it("has previous and next buttons that drive the player", () => {
    render(<Presenter />);
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    fireEvent.click(screen.getByLabelText("Next slide"));
    expect(post).toHaveBeenLastCalledWith({ type: "slop:go", key: "ArrowRight" }, "*");
    fireEvent.click(screen.getByLabelText("Previous slide"));
    expect(post).toHaveBeenLastCalledWith({ type: "slop:go", key: "ArrowLeft" }, "*");
  });

  describe("playing by itself", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      playNarration.mockReset();
      useNarration.setState({ audio: {}, audioDeck: null });
      saveVideoOptions({
        secondsPerSlide: 3,
        fps: 30,
        animate: true,
        narration: true,
        pauseBefore: 0.5,
        pauseAfter: 1,
      });
    });
    afterEach(() => {
      vi.useRealTimers();
      localStorage.clear();
    });
    const nexts = (post: { mock: { calls: unknown[][] } }) =>
      post.mock.calls.filter(([m]) => (m as { key?: string }).key === "ArrowRight").length;

    it("shows each slide for the set time, then moves on, stopping after the last", async () => {
      render(<Presenter />);
      const post = vi.spyOn(frame().contentWindow!, "postMessage");
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      fireEvent.click(screen.getByLabelText("Play"));
      await act(async () => vi.advanceTimersByTime(2900));
      expect(nexts(post)).toBe(0);
      await act(async () => vi.advanceTimersByTime(100));
      expect(nexts(post)).toBe(1);
      fromFrame({ type: "slop:slide", id: "outro", index: 2 });
      await act(async () => vi.advanceTimersByTime(3000));
      expect(nexts(post)).toBe(1);
      expect(screen.getByLabelText("Play")).toBeTruthy();
      expect(playNarration).not.toHaveBeenCalled();
    });

    it("speaks a slide's narration between its pauses, staying until they end", async () => {
      let end!: () => void;
      const stop = vi.fn();
      playNarration.mockImplementation(async () => ({ ended: new Promise<void>((r) => (end = r)), stop }));
      useNarration.setState({
        audioDeck: deckFor(DECK_HTML).id,
        audio: { intro: { slide: "intro", state: "ready", seconds: 10 } },
      });
      render(<Presenter />);
      const post = vi.spyOn(frame().contentWindow!, "postMessage");
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      fireEvent.click(screen.getByLabelText("Play"));
      await act(async () => vi.advanceTimersByTime(400));
      expect(playNarration).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(100));
      expect(playNarration).toHaveBeenCalledWith(deckFor(DECK_HTML).id, "intro");
      // Longer than the set time: the slide waits for the narration.
      await act(async () => vi.advanceTimersByTime(9500));
      expect(nexts(post)).toBe(0);
      await act(async () => end());
      await act(async () => vi.advanceTimersByTime(900));
      expect(nexts(post)).toBe(0);
      await act(async () => vi.advanceTimersByTime(100));
      expect(nexts(post)).toBe(1);
    });

    it("pausing stops the narration and the show stays", async () => {
      const stop = vi.fn();
      playNarration.mockImplementation(async () => ({ ended: new Promise<void>(() => {}), stop }));
      useNarration.setState({
        audioDeck: deckFor(DECK_HTML).id,
        audio: { intro: { slide: "intro", state: "ready", seconds: 10 } },
      });
      render(<Presenter />);
      const post = vi.spyOn(frame().contentWindow!, "postMessage");
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      fireEvent.click(screen.getByLabelText("Play"));
      await act(async () => vi.advanceTimersByTime(600));
      fireEvent.click(screen.getByLabelText("Pause"));
      expect(stop).toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(nexts(post)).toBe(0);
    });

    it("leaves out-of-date audio and narration the settings turned off unspoken", async () => {
      useNarration.setState({
        audioDeck: deckFor(DECK_HTML).id,
        audio: { intro: { slide: "intro", state: "stale", seconds: 10 } },
      });
      render(<Presenter />);
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      fireEvent.click(screen.getByLabelText("Play"));
      await act(async () => vi.advanceTimersByTime(5000));
      expect(playNarration).not.toHaveBeenCalled();
    });
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

  it("keeps the ink on the slide as it is zoomed and panned, ignoring nonsense", () => {
    render(<Presenter />);
    const zoom = () => {
      const { left, top, width, height, transform } = screen.getByTestId("annotation-zoom").style;
      return { left, top, width, height, transform };
    };
    expect(zoom()).toEqual({ left: "0px", top: "0px", width: "100%", height: "100%", transform: "" });
    fromFrame({ type: "slop:zoom", x: -100, y: -50, k: 2 });
    // Laid out at the zoomed size, not CSS-scaled, so the ink is not stretched blurry.
    expect(zoom()).toEqual({ left: "-100px", top: "-50px", width: "200%", height: "200%", transform: "" });
    fromFrame({ type: "slop:zoom", x: "a", y: 0, k: 1 });
    fromFrame({ type: "slop:zoom", x: 0, y: 0, k: 1 }, window);
    expect(zoom()).toEqual({ left: "-100px", top: "-50px", width: "200%", height: "200%", transform: "" });
  });

  it("0 fits the slide to the screen again, from the app too", () => {
    render(<Presenter />);
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    fireEvent.keyDown(document.body, { key: "0" });
    expect(post).toHaveBeenCalledWith({ type: "slop:camera", home: true }, "*");
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:go" }), "*");
  });

  it("offers to fit the slide again once it is zoomed or panned", () => {
    render(<Presenter />);
    const recenter = () => screen.queryByTitle(/fit to the screen/);
    expect(recenter()).toBeNull();
    fromFrame({ type: "slop:zoom", x: 10, y: 0, k: 1 });
    expect(recenter()!.textContent).toBe("100%");
    fromFrame({ type: "slop:zoom", x: -100, y: -50, k: 2 });
    expect(recenter()!.textContent).toBe("200%");
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    fireEvent.click(recenter()!);
    expect(post).toHaveBeenCalledWith({ type: "slop:camera", home: true }, "*");
    fromFrame({ type: "slop:zoom", x: 0, y: 0, k: 1 });
    expect(recenter()).toBeNull();
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
    expect(path.getAttribute("d")).toBe("M100 100L150 125Q200 150 300 250");
    expect(path.getAttribute("stroke")).toBe("#ef4444");
    expect(path.getAttribute("stroke-width")).toBe("4");
  });

  /** A move that also carries the samples the browser coalesced into it, the event's own last. */
  function moveThrough(samples: [number, number][]) {
    const [x, y] = samples[samples.length - 1]!;
    const event = createEvent.pointerMove(layer(), { buttons: 1, clientX: x, clientY: y, pointerId: 1 });
    const coalesced = samples.map(([clientX, clientY]) => ({ clientX, clientY }));
    Object.assign(event, { getCoalescedEvents: () => coalesced });
    fireEvent(layer(), event);
  }

  it("the pen keeps every sample of a fast move, not just one per frame", () => {
    render(<Presenter />);
    fireEvent.click(tool(/^Pen/));
    fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 1 });
    moveThrough([
      [200, 100],
      [200, 200],
      [100, 200],
    ]);
    fireEvent.pointerUp(layer(), { pointerId: 1 });
    expect(strokes()[0]!.getAttribute("d")).toBe("M100 100L150 100Q200 100 200 150Q200 200 100 200");
  });

  it("draws ink as vectors at the zoomed size, thickening with the slide", () => {
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
    fireEvent.click(tool(/^Pen/));
    draw([
      [100, 100],
      [200, 150],
    ]);
    fireEvent.keyDown(document.body, { key: "h" });
    draw([[300, 200]]);
    // The layer now measures twice the size, as it would once laid out at 200%.
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(-100, -50, 2000, 1000));
    fromFrame({ type: "slop:zoom", x: -100, y: -50, k: 2 });
    // Redrawn right in the resize callback, before the browser paints, so zooming doesn't flicker.
    for (const callback of resized) callback();
    const [pen, dot] = strokes();
    expect(pen!.getAttribute("d")).toBe("M200 200L400 300");
    expect(pen!.getAttribute("stroke-width")).toBe("8");
    expect(dot!.getAttribute("r")).toBe("28");
    expect(layer().querySelector("svg")!.style.transform).toBe("");
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
    act(() => {
      for (const callback of resized) callback();
    });
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

  /** Records what is painted on the laser trail's canvas. */
  function paintedTrail() {
    const painted = { strokes: [] as number[], images: [] as { shadowBlur: number; shadowColor: string }[] };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      const ctx = fakeCanvas2D(this);
      // The visible canvas is in the document; the scratch canvas the trail is drawn on first is not.
      if (this.isConnected) {
        const clear = ctx.clearRect;
        ctx.clearRect = () => {
          clear();
          painted.strokes = ctx.strokes;
          painted.images = ctx.images;
        };
      } else {
        ctx.clearRect = () => {
          ctx.strokes = [];
          painted.strokes = ctx.strokes;
        };
      }
      return ctx as unknown as CanvasRenderingContext2D;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext);
    return painted;
  }

  function dragLaser() {
    fireEvent.keyDown(document.body, { key: "l" });
    // Just moving the laser leaves no trail.
    fireEvent.pointerMove(layer(), { buttons: 0, clientX: 100, clientY: 100 });
    expect(screen.queryByTestId("laser-trail")).toBeNull();
    fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(layer(), { buttons: 1, clientX: 200, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(layer(), { buttons: 1, clientX: 300, clientY: 150, pointerId: 1 });
    fireEvent.pointerUp(layer(), { pointerId: 1 });
  }

  it("dragging the laser leaves a trail that lingers, then fades away", () => {
    vi.useFakeTimers();
    try {
      const painted = paintedTrail();
      render(<Presenter />);
      dragLaser();
      expect(screen.getByTestId("laser-trail")).toBeTruthy();
      expect(painted.strokes).toEqual([LASER_SIZE, LASER_SIZE]);
      expect(strokes()).toHaveLength(0);
      act(() => void vi.advanceTimersByTime(TRAIL_HOLD_MS - 100));
      expect(painted.strokes).toEqual([LASER_SIZE, LASER_SIZE]);
      act(() => void vi.advanceTimersByTime(100 + TRAIL_FADE_MS / 2));
      expect(painted.strokes).toHaveLength(2);
      for (const width of painted.strokes) {
        expect(width).toBeGreaterThan(0);
        expect(width).toBeLessThan(LASER_SIZE);
      }
      act(() => void vi.advanceTimersByTime(TRAIL_FADE_MS));
      expect(screen.queryByTestId("laser-trail")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the laser trail keeps every sample of a fast move", () => {
    const painted = paintedTrail();
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "l" });
    fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 1 });
    moveThrough([
      [200, 100],
      [200, 200],
      [100, 200],
    ]);
    expect(painted.strokes).toEqual([LASER_SIZE, LASER_SIZE, LASER_SIZE]);
  });

  it("a fresh laser trail is as wide as the dot and glows like it", () => {
    const painted = paintedTrail();
    render(<Presenter />);
    dragLaser();
    fireEvent.pointerMove(layer(), { buttons: 0, clientX: 300, clientY: 150 });
    const dot = screen.getByTestId("laser");
    expect(`${painted.strokes[0]}px`).toBe(dot.style.width);
    const colors = (css: string) => css.match(/rgb\([^)]*\)/g)!.map((c) => c.replace(/\s+/g, " "));
    const glow = painted.images.filter((i) => i.shadowBlur > 0).map((i) => i.shadowColor);
    expect(new Set(glow)).toEqual(new Set(colors(dot.style.boxShadow)));
  });

  it("a zoomed-in laser trail only gets a canvas the size of the screen", () => {
    paintedTrail();
    const zoomed = { left: -1000, top: -500, width: window.innerWidth * 4, height: window.innerHeight * 4 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      ...zoomed,
      x: zoomed.left,
      y: zoomed.top,
    } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(zoomed.width);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(zoomed.height);
    render(<Presenter />);
    dragLaser();
    const canvas = screen.getByTestId("laser-trail") as HTMLCanvasElement;
    expect([canvas.style.left, canvas.style.top]).toEqual(["1000px", "500px"]);
    expect([canvas.style.width, canvas.style.height]).toEqual([`${window.innerWidth}px`, `${window.innerHeight}px`]);
    const scale = window.devicePixelRatio || 1;
    expect([canvas.width, canvas.height]).toEqual([window.innerWidth * scale, window.innerHeight * scale]);
  });

  it("putting the laser away clears its trail", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "l" });
    fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(layer(), { buttons: 1, clientX: 200, clientY: 100, pointerId: 1 });
    expect(screen.queryByTestId("laser-trail")).not.toBeNull();
    fireEvent.keyDown(document.body, { key: "l" });
    expect(screen.queryByTestId("laser-trail")).toBeNull();
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

  it("the arrow buttons show at the start, on hover and briefly after shortcuts", () => {
    vi.useFakeTimers();
    try {
      render(<Presenter />);
      const next = screen.getByLabelText("Next slide");
      const zone = screen.getByTestId("nav-zone");
      expect(next.dataset.visible).toBe("true");
      act(() => void vi.advanceTimersByTime(2000));
      expect(next.dataset.visible).toBe("false");
      fireEvent.mouseEnter(zone);
      expect(next.dataset.visible).toBe("true");
      fireEvent.mouseLeave(zone);
      expect(next.dataset.visible).toBe("false");
      fireEvent.keyDown(document.body, { key: "p" });
      expect(next.dataset.visible).toBe("true");
      act(() => void vi.advanceTimersByTime(2000));
      expect(next.dataset.visible).toBe("false");
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

describe("presenter view", () => {
  const panel = () => screen.queryByRole("complementary", { name: "Presenter view" });
  const notes = () => screen.getByTestId("presenter-notes").textContent;
  const deck = (hidden: string[] = []) => {
    const base = deckFor(DECK_HTML);
    return {
      ...base,
      slides: base.slides.map((s) => ({ ...s, notes: `Notes of ${s.id}`, hidden: hidden.includes(s.id) })),
    };
  };
  beforeEach(() => useApp.setState({ deck: deck(), selected: "intro" }));
  afterEach(() => vi.useRealTimers());

  it("stays closed until asked for, then remembers", () => {
    const { unmount } = render(<Presenter />);
    expect(panel()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Presenter view" }));
    expect(panel()).toBeTruthy();
    unmount();
    render(<Presenter />);
    expect(panel()).toBeTruthy();
  });

  it("N toggles it, from the app or from inside the slide", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "n" });
    expect(panel()).toBeTruthy();
    fromFrame({ type: "slop:key", key: "N" });
    expect(panel()).toBeNull();
    fireEvent.keyDown(document.body, { key: "n", metaKey: true });
    expect(panel()).toBeNull();
  });

  it("shows the notes of the slide on screen and follows the show", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "n" });
    expect(notes()).toBe("Notes of intro");
    fromFrame({ type: "slop:slide", id: "outro", index: 2 });
    expect(notes()).toBe("Notes of outro");
  });

  it("says when a slide has no notes", () => {
    useApp.setState({ deck: deckFor(DECK_HTML) });
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "n" });
    expect(notes()).toBe("No notes for this slide.");
  });

  it("previews the next shown slide, skipping hidden ones, and says when there is none", () => {
    useApp.setState({ deck: deck(["#2"]) });
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "n" });
    expect(screen.getByText("Slide 1 of 2")).toBeTruthy();
    fromFrame({ type: "slop:slide", id: "outro", index: 1 });
    expect(screen.getByText("Slide 2 of 2")).toBeTruthy();
    expect(screen.getByText("The end of the show.")).toBeTruthy();
  });

  it("counts the time since the show started, even while closed, and restarts", () => {
    vi.useFakeTimers();
    render(<Presenter />);
    act(() => void vi.advanceTimersByTime(65_000));
    fireEvent.keyDown(document.body, { key: "n" });
    expect(screen.getByRole("timer").textContent).toBe("1:05");
    act(() => void vi.advanceTimersByTime(2_000));
    expect(screen.getByRole("timer").textContent).toBe("1:07");
    fireEvent.click(screen.getByRole("button", { name: "Restart the timer" }));
    expect(screen.getByRole("timer").textContent).toBe("0:00");
    act(() => void vi.advanceTimersByTime(3_000));
    expect(screen.getByRole("timer").textContent).toBe("0:03");
  });

  it("shows the time left against the total time and the time on the slide against its own", () => {
    vi.useFakeTimers();
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "n" });
    fireEvent.change(screen.getByLabelText("Total time in minutes"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Per slide in minutes"), { target: { value: "0.5" } });
    act(() => void vi.advanceTimersByTime(20_000));
    expect(screen.getByTestId("total-left").textContent).toBe("0:40 left");
    expect(screen.getByTestId("slide-time").textContent).toBe("slide0:20 / 0:30");
    act(() => void vi.advanceTimersByTime(50_000));
    expect(screen.getByTestId("total-left").textContent).toBe("+0:10 over");
    // A new slide starts its own time, the show's keeps running.
    fromFrame({ type: "slop:slide", index: 1, id: "outro" });
    expect(screen.getByTestId("slide-time").textContent).toBe("slide0:00 / 0:30");
    expect(screen.getByRole("timer").textContent).toBe("1:10");
    expect(JSON.parse(localStorage.getItem("slopslide.presenterBudget") ?? "")).toEqual({ total: 1, perSlide: 0.5 });
  });

  it("remembers the times and shows no budget without one", () => {
    localStorage.setItem("slopslide.presenterBudget", JSON.stringify({ total: 20, perSlide: -3 }));
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "n" });
    expect((screen.getByLabelText("Total time in minutes") as HTMLInputElement).value).toBe("20");
    expect((screen.getByLabelText("Per slide in minutes") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("total-left").textContent).toBe("20:00 left");
  });

  it("counts down the time set on the slide, and the slides' times added up", () => {
    localStorage.setItem("slopslide.presenterBudget", JSON.stringify({ total: 0, perSlide: 5 }));
    const deck = deckFor(DECK_HTML);
    const slides = deck.slides.map((s) => ({ ...s, time: s.id === "intro" ? 90 : 0 }));
    useApp.setState({ deck: { ...deck, slides }, selected: "intro" });
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "n" });
    expect(screen.getByTestId("slide-time").textContent).toBe("slide0:00 / 1:30");
    expect(screen.getByTestId("total-left").textContent).toBe("1:30 left");
    // A slide without a time of its own has the time per slide.
    fromFrame({ type: "slop:slide", index: 1, id: "outro" });
    expect(screen.getByTestId("slide-time").textContent).toBe("slide0:00 / 5:00");
  });

  it("counts down the rest and then up past the end", () => {
    expect(remaining(0, 1)).toEqual({ text: "1:00", over: false });
    expect(remaining(59_500, 1)).toEqual({ text: "0:01", over: false });
    expect(remaining(60_000, 1)).toEqual({ text: "0:00", over: false });
    expect(remaining(65_000, 1)).toEqual({ text: "+0:05", over: true });
  });

  it("formats the time", () => {
    expect(formatElapsed(-5)).toBe("0:00");
    expect(formatElapsed(59_999)).toBe("0:59");
    expect(formatElapsed(247_000)).toBe("4:07");
    expect(formatElapsed(3_847_000)).toBe("1:04:07");
    expect(formatElapsed(36_000_000)).toBe("10:00:00");
  });

  it("keeps the slide's focus when its buttons are pressed", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "n" });
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    screen.getByRole("button", { name: "Restart the timer" }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("Presenter on several screens", () => {
  const choice = { audience: 1, presenter: 0 };

  it("moves the show to its screen before going full screen, and closes the presenter view after", async () => {
    useApp.setState({ screens: choice });
    const { unmount } = render(<Presenter />);
    expect(setFullscreen).not.toHaveBeenCalled();
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("present_on", { audience: 1, presenter: 0 });
    expect(setFullscreen).toHaveBeenCalledWith(true);
    unmount();
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("close_presenter_view");
  });

  it("places and closes in the order asked, however long each takes", async () => {
    useApp.setState({ screens: choice });
    let finishPlacing = () => {};
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => (finishPlacing = resolve)));
    const { unmount } = render(<Presenter />);
    await act(async () => {});
    unmount();
    render(<Presenter />);
    await act(async () => {});
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["present_on"]);
    await act(async () => finishPlacing());
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["present_on", "close_presenter_view", "present_on"]);
  });

  it("stays out of full screen when the show ends while it is being placed", async () => {
    useApp.setState({ screens: choice });
    let finishPlacing = () => {};
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => (finishPlacing = resolve)));
    const { unmount } = render(<Presenter />);
    await act(async () => {});
    unmount();
    await act(async () => finishPlacing());
    expect(setFullscreen).not.toHaveBeenCalledWith(true);
  });

  it("keeps the presenter view off the audience's screen and feeds it to its own window", async () => {
    useApp.setState({ screens: choice });
    localStorage.setItem("slopslide.presenterPanel", "true");
    render(<Presenter />);
    await act(async () => {});
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(emit).toHaveBeenCalledWith("presenter:state", expect.objectContaining({ slide: "outro" }));
    fromFrame({ type: "slop:slide", index: 0, id: "intro" });
    expect(emit).toHaveBeenLastCalledWith("presenter:state", expect.objectContaining({ slide: "intro" }));
    emit.mockClear();
    listeners.get("presenter:ready")?.({ payload: null });
    expect(emit).toHaveBeenCalledWith("presenter:state", expect.objectContaining({ slide: "intro" }));
  });

  it("takes keys and the end of the show from the presenter view", async () => {
    useApp.setState({ screens: choice });
    render(<Presenter />);
    await act(async () => {});
    const post = vi.spyOn(frame().contentWindow as Window, "postMessage");
    listeners.get("presenter:key")?.({ payload: "ArrowRight" });
    expect(post).toHaveBeenCalledWith({ type: "slop:go", key: "ArrowRight" }, "*");
    act(() => listeners.get("presenter:exit")?.({ payload: null }));
    expect(useApp.getState().presenting).toBe(false);
  });

  it("without a presenter view only moves the show", async () => {
    useApp.setState({ screens: { audience: 1, presenter: null } });
    render(<Presenter />);
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("present_on", { audience: 1, presenter: null });
    expect(emit).not.toHaveBeenCalled();
  });

  it("goes full screen where it is when presenting on one screen", () => {
    render(<Presenter />);
    expect(invoke).not.toHaveBeenCalled();
    expect(setFullscreen).toHaveBeenCalledWith(true);
  });
});

describe("PresenterWindow", () => {
  it("asks for the show and displays the slide, notes and next slide it is sent", async () => {
    render(<PresenterWindow />);
    await act(async () => {});
    expect(emit).toHaveBeenCalledWith("presenter:ready");
    const deck = deckFor(DECK_HTML);
    act(() => listeners.get("presenter:state")?.({ payload: { deck, slide: deck.slides[0]?.id } }));
    expect(screen.getByRole("complementary")).toBeTruthy();
    expect(screen.getByText("Now")).toBeTruthy();
    expect(screen.getByText("Next")).toBeTruthy();
    expect(screen.getByTestId("presenter-notes").textContent).toBe(deck.slides[0]?.notes || "No notes for this slide.");
  });

  it("sizes the slides by the room's height as well as its width", () => {
    expect(fitWidth({ width: 1920, height: 960 })).toBe("min(100cqw, 200cqh)");
    expect(fitWidth({ width: 1000, height: 2000 })).toBe("min(100cqw, 50cqh)");
  });

  it("sends the keys pressed in it to the show, and Escape ends the show", async () => {
    render(<PresenterWindow />);
    await act(async () => {});
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(emit).toHaveBeenCalledWith("presenter:key", "ArrowRight");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(emit).toHaveBeenCalledWith("presenter:exit");
  });
});
