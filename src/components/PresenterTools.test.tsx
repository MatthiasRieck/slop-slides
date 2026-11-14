import { act, createEvent, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Counted, to tell what drawing works out again: the paths of the ink, and its pixel positions.
vi.mock("../lib/ink", async (original) => {
  const actual = await original<typeof import("../lib/ink")>();
  return { ...actual, strokePath: vi.fn(actual.strokePath), toPixels: vi.fn(actual.toPixels) };
});

import * as ink from "../lib/ink";
import { fakeCanvas2D } from "../test/fakeCanvas";
import { countRenders } from "../test/renderCounts";
import { AnnotationLayer, useAnnotations } from "./PresenterTools";

const { strokePath: fullPath } = await vi.importActual<typeof import("../lib/ink")>("../lib/ink");

/** The ink layer with its annotations, as the stage and the show have it; `pick` picks a tool. */
let annotations: ReturnType<typeof useAnnotations>;
function Ink({ zoom }: { zoom?: number }) {
  annotations = useAnnotations("one");
  return <AnnotationLayer annotations={annotations} zoom={zoom} />;
}

const layer = () => screen.getByTestId("annotation-layer");
const strokes = () => layer().querySelectorAll("[data-stroke]");
const pick = (tool: Parameters<typeof annotations.setTool>[0]) => act(() => annotations.setTool(tool));

function draw(points: [number, number][]) {
  const [first, ...rest] = points;
  fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: first![0], clientY: first![1], pointerId: 1 });
  for (const [x, y] of rest) fireEvent.pointerMove(layer(), { buttons: 1, clientX: x, clientY: y, pointerId: 1 });
  fireEvent.pointerUp(layer(), { pointerId: 1 });
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 500));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(ink.strokePath).mockClear();
  vi.mocked(ink.toPixels).mockClear();
});

describe("useAnnotations", () => {
  it("hands out the same functions on every render, whatever changed", () => {
    const { result, rerender } = renderHook(({ slide }) => useAnnotations(slide), { initialProps: { slide: "one" } });
    const first = result.current;
    act(() => first.setTool("pen"));
    act(() => first.addStroke({ tool: "pen", color: "#f00", points: [[0.1, 0.1]] }));
    rerender({ slide: "two" });
    const later = result.current;
    expect(later).not.toBe(first);
    for (const name of ["setTool", "setColor", "addStroke", "erase", "undo", "redo", "clear", "handleKey"] as const) {
      expect(later[name], name).toBe(first[name]);
    }
  });

  it("is the same object from one render to the next while nothing in it changed", () => {
    const { result, rerender } = renderHook(() => useAnnotations("one"));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("has its lasting functions work on the slide and the tool of the moment", () => {
    const { result, rerender } = renderHook(({ slide }) => useAnnotations(slide), { initialProps: { slide: "one" } });
    const { addStroke, undo, handleKey, setColor } = result.current;
    act(() => addStroke({ tool: "pen", color: "#f00", points: [[0.1, 0.1]] }));
    expect(result.current.strokes).toHaveLength(1);
    rerender({ slide: "two" });
    expect(result.current.strokes).toHaveLength(0);
    act(() => addStroke({ tool: "pen", color: "#00f", points: [[0.2, 0.2]] }));
    act(() => addStroke({ tool: "pen", color: "#00f", points: [[0.3, 0.3]] }));
    expect(result.current.strokes).toHaveLength(2);
    act(() => undo());
    expect(result.current.strokes).toHaveLength(1);
    rerender({ slide: "one" });
    expect(result.current.strokes).toHaveLength(1);
    // The highlighter's key, pressed again, puts it away: the function knows the tool in hand.
    act(() => void handleKey("h", false));
    expect(result.current.tool).toBe("highlighter");
    act(() => setColor("#0f0"));
    expect(result.current.colors.highlighter).toBe("#0f0");
    act(() => void handleKey("h", false));
    expect(result.current.tool).toBe("pointer");
  });
});

describe("AnnotationLayer", () => {
  /** Thirty strokes on the slide, each a short line. */
  const drawMany = () => {
    for (let i = 0; i < 30; i++) {
      draw([
        [20 + i * 30, 50],
        [30 + i * 30, 90],
        [40 + i * 30, 60],
      ]);
    }
  };

  it("works out no path but the one being drawn as the pen moves, and only for its new points", () => {
    render(<Ink />);
    pick("pen");
    drawMany();
    expect(strokes()).toHaveLength(30);
    vi.mocked(ink.strokePath).mockClear();
    vi.mocked(ink.toPixels).mockClear();

    const moves: [number, number][] = Array.from({ length: 20 }, (_, i) => [100 + i * 13, 200 + ((i * 37) % 90)]);
    fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: 100, clientY: 200, pointerId: 1 });
    vi.mocked(ink.toPixels).mockClear();
    for (const [x, y] of moves) fireEvent.pointerMove(layer(), { buttons: 1, clientX: x, clientY: y, pointerId: 1 });

    // None of the thirty strokes on the slide was drawn again.
    expect(ink.strokePath).not.toHaveBeenCalled();
    // Each move placed its own point, not the stroke so far.
    expect(ink.toPixels).toHaveBeenCalledTimes(moves.length);
    for (const [points] of vi.mocked(ink.toPixels).mock.calls) expect(points).toHaveLength(1);

    // What shows is the path of the whole stroke all the same.
    const drawn: [number, number][] = [[100, 200], ...moves];
    const draft = screen.getByTestId("ink-draft").querySelector("path")!;
    expect(draft.getAttribute("d")).toBe(fullPath(drawn));
    expect(draft.style.display).toBe("");

    fireEvent.pointerUp(layer(), { pointerId: 1 });
    expect(screen.queryByTestId("ink-draft")).toBeNull();
    expect(strokes()).toHaveLength(31);
    expect(strokes()[30]!.getAttribute("d")).toBe(fullPath(drawn));
    // Finishing it drew that one stroke, and no other.
    expect(ink.strokePath).toHaveBeenCalledTimes(1);
  });

  it("shows a stroke that has not moved as a dot, and as a line from its first move on", () => {
    render(<Ink />);
    pick("highlighter");
    fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: 300, clientY: 200, pointerId: 1 });
    const draft = screen.getByTestId("ink-draft");
    const [dot, line] = [draft.querySelector("circle")!, draft.querySelector("path")!];
    expect([dot.getAttribute("cx"), dot.getAttribute("cy"), dot.getAttribute("r")]).toEqual(["300", "200", "14"]);
    expect([dot.style.display, line.style.display]).toEqual(["", "none"]);
    fireEvent.pointerMove(layer(), { buttons: 1, clientX: 340, clientY: 220, pointerId: 1 });
    expect([dot.style.display, line.style.display]).toEqual(["none", ""]);
    expect(line.getAttribute("d")).toBe("M300 200L340 220");
    // The stroke in hand is not one the eraser could take yet.
    expect(strokes()).toHaveLength(0);
  });

  it("keeps every sample of a fast move in the stroke being drawn", () => {
    render(<Ink />);
    pick("pen");
    fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 1 });
    const event = createEvent.pointerMove(layer(), { buttons: 1, clientX: 100, clientY: 200, pointerId: 1 });
    const samples = [
      { clientX: 200, clientY: 100 },
      { clientX: 200, clientY: 200 },
      { clientX: 100, clientY: 200 },
    ];
    Object.assign(event, { getCoalescedEvents: () => samples });
    fireEvent(layer(), event);
    const draft = screen.getByTestId("ink-draft").querySelector("path")!;
    expect(draft.getAttribute("d")).toBe("M100 100L150 100Q200 100 200 150Q200 200 100 200");
  });

  it("draws only the strokes after an erased one again, and none of their paths", () => {
    render(<Ink />);
    pick("pen");
    drawMany();
    pick("eraser");
    vi.mocked(ink.strokePath).mockClear();
    fireEvent.pointerDown(strokes()[10]!, { button: 0, buttons: 1 });
    expect(strokes()).toHaveLength(29);
    // The strokes keep their paths; those after the gap only learn their new place in the list.
    expect(ink.strokePath).not.toHaveBeenCalled();
    expect([...strokes()].map((stroke) => stroke.getAttribute("data-stroke"))).toEqual(
      Array.from({ length: 29 }, (_, i) => String(i)),
    );
  });

  it("works out the paths again when the layer resizes, once, and not for a zoom alone", () => {
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
    const { rerender } = render(<Ink zoom={1} />);
    pick("pen");
    draw([
      [100, 100],
      [200, 150],
    ]);
    draw([
      [300, 100],
      [400, 150],
    ]);
    vi.mocked(ink.strokePath).mockClear();
    rerender(<Ink zoom={2} />);
    expect(ink.strokePath).not.toHaveBeenCalled();
    expect(strokes()[0]!.getAttribute("stroke-width")).toBe("8");
    // The same size reported again draws nothing.
    act(() => resized.forEach((callback) => void callback()));
    expect(ink.strokePath).not.toHaveBeenCalled();
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 2000, 1000));
    act(() => resized.forEach((callback) => void callback()));
    expect(ink.strokePath).toHaveBeenCalledTimes(2);
    expect(strokes()[0]!.getAttribute("d")).toBe("M200 200L400 300");
    vi.unstubAllGlobals();
  });

  it("neither measures nor renders for a zoom or a resize while there is nothing to draw, and draws at the zoom of then", () => {
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
    const { rerender } = render(<Ink zoom={1} />);
    const measured = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    measured.mockClear();
    const counts = countRenders();
    // A pinch: the layer is laid out larger with every frame, and told the zoom.
    for (let k = 2; k <= 30; k++) {
      measured.mockReturnValue(new DOMRect(0, 0, 1000 * k, 500 * k));
      rerender(<Ink zoom={k} />);
      act(() => resized.forEach((callback) => void callback()));
    }
    counts.stop();
    expect(counts.of("Ink")).toBe(29);
    expect(counts.of("AnnotationLayer")).toBe(0);
    expect(measured).not.toHaveBeenCalled();
    // A pen picked up: the layer is measured as it is now, and draws at the zoom of now.
    measured.mockReturnValue(new DOMRect(0, 0, 30_000, 15_000));
    pick("pen");
    draw([
      [3000, 3000],
      [6000, 4500],
    ]);
    expect(strokes()[0]!.getAttribute("d")).toBe("M3000 3000L6000 4500");
    expect(strokes()[0]!.getAttribute("stroke-width")).toBe("120");
    vi.unstubAllGlobals();
  });

  describe("the laser", () => {
    /** Counts how often the trail's canvas is painted. */
    function countPaints() {
      const count = { paints: 0 };
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
        const ctx = fakeCanvas2D(this);
        if (this.isConnected) {
          const clear = ctx.clearRect;
          ctx.clearRect = () => {
            clear();
            count.paints++;
          };
        }
        return ctx as unknown as CanvasRenderingContext2D;
      } as unknown as typeof HTMLCanvasElement.prototype.getContext);
      return count;
    }

    it("moves its dot without rendering the ink layer", () => {
      render(<Ink />);
      pick("laser");
      fireEvent.pointerMove(layer(), { clientX: 50, clientY: 60 });
      const dot = screen.getByTestId("laser");
      const svg = layer().querySelector("svg")!;
      const watch = new MutationObserver(() => {});
      watch.observe(layer(), { childList: true, subtree: true, attributes: true });
      for (let i = 1; i <= 20; i++) fireEvent.pointerMove(layer(), { clientX: 50 + i * 10, clientY: 60 + i });
      // Nothing in the layer changed but the dot's place.
      const changed = watch.takeRecords();
      watch.disconnect();
      expect(changed.every((record) => record.target === dot && record.attributeName === "style")).toBe(true);
      expect(dot.style.transform).toBe("translate(250px, 80px)");
      expect(layer().querySelector("svg")).toBe(svg);
    });

    it("paints a held trail once per move, and not again while it rests", () => {
      vi.useFakeTimers();
      try {
        const count = countPaints();
        render(<Ink />);
        pick("laser");
        fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 1 });
        const mounted = count.paints;
        for (let i = 1; i <= 5; i++) {
          fireEvent.pointerMove(layer(), { buttons: 1, clientX: 100 + i * 20, clientY: 100, pointerId: 1 });
        }
        expect(count.paints).toBe(mounted + 5);
        // Held, it looks the same from one frame to the next.
        act(() => void vi.advanceTimersByTime(ink.TRAIL_HOLD_MS - 100));
        expect(count.paints).toBe(mounted + 5);
        // Thinning away, it is painted frame by frame, until it is gone.
        act(() => void vi.advanceTimersByTime(200));
        expect(count.paints).toBeGreaterThan(mounted + 5);
        act(() => void vi.advanceTimersByTime(ink.TRAIL_FADE_MS + 100));
        expect(screen.queryByTestId("laser-trail")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives the trail a canvas around the trail, not one over the whole layer", () => {
      countPaints();
      render(<Ink />);
      pick("laser");
      fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: 400, clientY: 250, pointerId: 1 });
      fireEvent.pointerMove(layer(), { buttons: 1, clientX: 460, clientY: 260, pointerId: 1 });
      const canvas = screen.getByTestId("laser-trail") as HTMLCanvasElement;
      const side = (name: string) => Number.parseFloat(canvas.style.getPropertyValue(name));
      expect(side("left")).toBeLessThanOrEqual(400 - ink.TRAIL_GLOW);
      expect(side("left") + side("width")).toBeGreaterThanOrEqual(460 + ink.TRAIL_GLOW);
      expect(side("top")).toBeLessThanOrEqual(250 - ink.TRAIL_GLOW);
      expect(side("top") + side("height")).toBeGreaterThanOrEqual(260 + ink.TRAIL_GLOW);
      // The layer is 1000 × 500.
      expect(side("width")).toBeLessThan(400);
      expect(side("height")).toBeLessThan(300);
    });
  });
});
