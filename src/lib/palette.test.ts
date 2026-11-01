import { describe, expect, it } from "vitest";
import { DEFAULT_EDIT_STYLES, EDIT_COLORS } from "./editTools";
import { DEFAULT_COLORS, INK_COLORS, LASER_RGB } from "./ink";
import { rgbChannels, SWATCHES } from "./palette";

describe("palette", () => {
  it("reads the channels of a color", () => {
    expect(rgbChannels("#ef4444")).toBe("239 68 68");
    expect(rgbChannels("#000000")).toBe("0 0 0");
  });

  it("offers the same swatches in the edit toolbar, and a subset of them for ink", () => {
    expect(EDIT_COLORS).toEqual(Object.values(SWATCHES));
    expect(EDIT_COLORS).toEqual(expect.arrayContaining(INK_COLORS));
    expect(EDIT_COLORS).toEqual(expect.arrayContaining(Object.values(DEFAULT_COLORS)));
  });

  it("starts the edit tools on swatches", () => {
    const used = Object.values(DEFAULT_EDIT_STYLES)
      .flatMap((style) => [style.color, style.fill, style.stroke])
      .filter((color) => color != null);
    expect(EDIT_COLORS).toEqual(expect.arrayContaining(used));
  });

  it("draws the laser in the swatches' red", () => {
    expect(LASER_RGB).toBe(rgbChannels(SWATCHES.red));
  });
});
