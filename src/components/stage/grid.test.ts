import { describe, expect, it } from "vitest";

import { arenaAround, gridCells, gridLayout, inPreview } from "./grid";

const WIDE = 16 / 9;

describe("gridLayout", () => {
  it("shows one slide as large as fits the box", () => {
    expect(gridLayout(1, 960, 540, WIDE)).toEqual({ cols: 1, rows: 1, width: 960 });
    expect(gridLayout(1, 400, 900, WIDE)).toEqual({ cols: 1, rows: 1, width: 400 });
  });

  it("puts the slides in the columns that show them largest", () => {
    const shape = (n: number, w: number, h: number) => {
      const { cols, rows } = gridLayout(n, w, h, WIDE);
      return `${cols}x${rows}`;
    };
    // A wide area takes them in a row or two, a tall one above each other.
    expect(shape(2, 1600, 600)).toBe("2x1");
    expect(shape(2, 600, 1200)).toBe("1x2");
    expect(shape(3, 1600, 700)).toBe("2x2");
    expect(shape(3, 2400, 500)).toBe("3x1");
    expect(shape(3, 600, 1200)).toBe("1x3");
    expect(shape(4, 1600, 900)).toBe("2x2");
    expect(shape(4, 600, 1600)).toBe("1x4");
    expect(shape(6, 1600, 600)).toBe("3x2");
    expect(shape(6, 800, 1200)).toBe("2x3");
  });

  it("sizes the slides to fit with the gaps between them", () => {
    // Two in a row are as wide as half the box less the gap; the height does not limit them.
    expect(gridLayout(2, 960, 540, WIDE).width).toBe(468);
    // Two above each other are as high as half the box less the gap.
    expect(gridLayout(2, 600, 1200, WIDE, 0).width).toBe(600);
    expect(gridLayout(2, 1000, 1024, WIDE, 24).width).toBeCloseTo(500 * WIDE);
    // Nothing fits a box smaller than the gaps.
    expect(gridLayout(3, 10, 10, WIDE).width).toBe(0);
  });
});

describe("gridCells", () => {
  it("places the slides row by row, the gap apart", () => {
    const grid = gridCells(4, { cols: 2, rows: 2, width: 160 }, WIDE, 20);
    expect(grid.cell).toEqual({ width: 160, height: 90 });
    expect(grid).toMatchObject({ width: 340, height: 200 });
    expect(grid.cells).toEqual([
      { x: 0, y: 0 },
      { x: 180, y: 0 },
      { x: 0, y: 110 },
      { x: 180, y: 110 },
    ]);
  });

  it("centers a last row that is not full", () => {
    const three = gridCells(3, { cols: 2, rows: 2, width: 160 }, WIDE, 20);
    expect(three.cells[2]).toEqual({ x: 90, y: 110 });
    const five = gridCells(5, { cols: 3, rows: 2, width: 160 }, WIDE, 20);
    expect(five.cells.slice(3)).toEqual([
      { x: 90, y: 110 },
      { x: 270, y: 110 },
    ]);
  });
});

describe("arenaAround", () => {
  it("is the area itself around its middle", () => {
    expect(arenaAround({ x: 500, y: 300 }, { width: 1000, height: 600 })).toEqual({ width: 1000, height: 600 });
  });

  it("reaches the far edge of the area from a slide off its middle", () => {
    // A slide in the left quarter needs one and a half areas to cover the right edge.
    expect(arenaAround({ x: 250, y: 300 }, { width: 1000, height: 600 })).toEqual({ width: 1500, height: 600 });
    expect(arenaAround({ x: 900, y: 100 }, { width: 1000, height: 600 })).toEqual({ width: 1800, height: 1000 });
  });
});

describe("inPreview", () => {
  it("gives another slide's corner in the pixels of the preview, which has its own slide in the middle", () => {
    const size = { width: 1920, height: 1080 };
    // At half size, an arena of 2000 × 1000 is a preview of 4000 × 2000: its slide starts at 1040, 460.
    expect(inPreview({ x: 0, y: 0 }, { width: 2000, height: 1000 }, size, 0.5)).toEqual({ x: 1040, y: 460 });
    // A slide 980 to the right on the screen is 1960 of the preview's pixels on.
    expect(inPreview({ x: 980, y: -300 }, { width: 2000, height: 1000 }, size, 0.5)).toEqual({ x: 3000, y: -140 });
  });
});
