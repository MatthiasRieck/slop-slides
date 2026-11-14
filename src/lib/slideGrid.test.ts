// @vitest-environment node
import { describe, expect, it } from "vitest";

import { dropSide, GRID_SIZES, type GridCell, gridSize, gridStep } from "./slideGrid";

describe("gridSize", () => {
  it("keeps a size within the slider's range, on its steps, and falls back on the usual one", () => {
    expect(gridSize(233)).toBe(240);
    expect(gridSize(10)).toBe(GRID_SIZES.min);
    expect(gridSize(9999)).toBe(GRID_SIZES.max);
    expect(gridSize("big")).toBe(GRID_SIZES.initial);
    expect(gridSize(Number.NaN)).toBe(GRID_SIZES.initial);
  });
});

describe("gridStep", () => {
  const cell = (id: string, row: number, column: number): GridCell => ({
    id,
    left: column * 110,
    top: row * 80,
    width: 100,
    height: 60,
  });
  // Three to a row; a section starts a new row after "c", whose row is short.
  const cells = [cell("a", 0, 0), cell("b", 0, 1), cell("c", 0, 2), cell("d", 1, 0), cell("e", 2, 0), cell("f", 2, 1)];

  it("goes to the slide nearest across on the row above or below", () => {
    expect(gridStep(cells, "b", 1)).toBe("d");
    expect(gridStep(cells, "d", 1)).toBe("e");
    expect(gridStep(cells, "f", -1)).toBe("d");
    expect(gridStep(cells, "e", -1)).toBe("d");
    expect(gridStep(cells, "d", -1)).toBe("a");
  });

  it("goes nowhere from the first row up, the last row down, or a slide not shown", () => {
    expect(gridStep(cells, "c", -1)).toBeNull();
    expect(gridStep(cells, "f", 1)).toBeNull();
    expect(gridStep(cells, "x", 1)).toBeNull();
  });
});

describe("dropSide", () => {
  const keys = ["a", "b", "c", "d"];
  it("says which side of a row the dragged rows land on", () => {
    expect(dropSide(keys, ["a"], "a", "c")).toBe("after");
    expect(dropSide(keys, ["d"], "d", "b")).toBe("before");
    expect(dropSide(keys, ["b", "c"], "b", "c")).toBeNull();
    expect(dropSide(keys, ["a"], "a", "zz")).toBeNull();
  });
});
