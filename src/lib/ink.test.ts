import { describe, expect, it } from "vitest";

import { INK_STYLE, inkBounds, isDot, SLIDE_SIZE, strokePath, TOOL_KEYS, toFraction, toPixels, zoomBox, type Stroke } from "./ink";

describe("strokePath", () => {
  it("draws a line through every point", () => {
    expect(
      strokePath([
        [10, 20],
        [30, 40],
        [50, 60],
      ]),
    ).toBe("M10 20L30 40L50 60");
  });

  it("draws nothing without points", () => {
    expect(strokePath([])).toBe("");
  });
});

describe("toPixels", () => {
  it("scales fractions of the screen to pixels", () => {
    expect(
      toPixels(
        [
          [0.5, 0.25],
          [1, 1],
        ],
        1920,
        1080,
      ),
    ).toEqual([
      [960, 270],
      [1920, 1080],
    ]);
  });

  it("rounds to a tenth of a pixel", () => {
    expect(toPixels([[0.3333, 0.6667]], 1000, 100)).toEqual([[333.3, 66.7]]);
  });
});

describe("isDot", () => {
  it("is true for a tap, also when the pointer reported the same spot again", () => {
    expect(isDot([[5, 5]])).toBe(true);
    expect(
      isDot([
        [5, 5],
        [5, 5],
      ]),
    ).toBe(true);
  });

  it("is false once the pointer moved, and for no points", () => {
    expect(
      isDot([
        [5, 5],
        [5, 6],
      ]),
    ).toBe(false);
    expect(isDot([])).toBe(false);
  });
});

describe("toFraction", () => {
  it("maps a pointer position to fractions of the rect", () => {
    expect(toFraction(600, 300, new DOMRect(100, 100, 1000, 400))).toEqual([0.5, 0.5]);
    expect(toFraction(100, 500, new DOMRect(100, 100, 1000, 400))).toEqual([0, 1]);
  });

  it("rounds to keep stored strokes small", () => {
    expect(toFraction(1, 2, new DOMRect(0, 0, 3, 3))).toEqual([0.3333, 0.6667]);
  });

  it("survives an unmeasured rect", () => {
    expect(toFraction(5, 7, new DOMRect(0, 0, 0, 0))).toEqual([5, 7]);
  });
});

describe("zoomBox", () => {
  it("lays the layer out where the zoom puts it, at the zoomed size", () => {
    expect(zoomBox(0, 0, 1)).toEqual({ left: "0px", top: "0px", width: "100%", height: "100%" });
    expect(zoomBox(-100, 25.5, 2.5)).toEqual({ left: "-100px", top: "25.5px", width: "250%", height: "250%" });
  });
});

describe("TOOL_KEYS", () => {
  it("binds the drawing tools to their initials", () => {
    expect(TOOL_KEYS).toEqual({ l: "laser", p: "pen", h: "highlighter", e: "eraser" });
  });
});

describe("inkBounds", () => {
  const pen = (points: [number, number][]): Stroke => ({ tool: "pen", color: "#ef4444", points });

  it("is null without ink", () => {
    expect(inkBounds([])).toBeNull();
    expect(inkBounds([pen([])])).toBeNull();
  });

  it("covers every stroke in slide pixels, padded by the ink width", () => {
    const pad = INK_STYLE.pen.width;
    expect(
      inkBounds([
        pen([
          [0.25, 0.5],
          [0.5, 0.25],
        ]),
        pen([[0.75, 0.75]]),
      ]),
    ).toEqual({ left: 480 - pad, top: 270 - pad, right: 1440 + pad, bottom: 810 + pad });
  });

  it("pads highlighter strokes more than pen strokes", () => {
    const point: [number, number][] = [[0.5, 0.5]];
    const marker = inkBounds([{ tool: "highlighter", color: "#facc15", points: point }])!;
    const line = inkBounds([pen(point)])!;
    expect(marker.right - marker.left).toBeGreaterThan(line.right - line.left);
  });

  it("stays on the slide", () => {
    expect(
      inkBounds([
        pen([
          [0, 0],
          [1, 1],
        ]),
      ]),
    ).toEqual({ left: 0, top: 0, right: SLIDE_SIZE.width, bottom: SLIDE_SIZE.height });
  });
});
