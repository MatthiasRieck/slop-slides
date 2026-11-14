// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_EDIT_STYLES, EDIT_COLORS } from "./editTools";
import { DEFAULT_COLORS, INK_COLORS, LASER_RGB } from "./ink";
import {
  colorLabel,
  mixColor,
  parseHexInput,
  parseRecentColors,
  RECENT_COLORS,
  rgbChannels,
  SWATCHES,
  swatchName,
  withRecentColor,
} from "./palette";

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

describe("naming and typing colors", () => {
  it("names the swatches, and no other color", () => {
    expect(swatchName(SWATCHES.blue)).toBe("Blue");
    expect(swatchName(SWATCHES.blue.toUpperCase())).toBe("Blue");
    expect(swatchName("#123456")).toBeNull();
    expect(swatchName(null)).toBeNull();
    expect(colorLabel(SWATCHES.red)).toBe(`Red (${SWATCHES.red})`);
    expect(colorLabel("#123456")).toBe("#123456");
  });

  it("reads a typed hex value, with or without the #, three digits or six", () => {
    expect(parseHexInput(" #3B82F6 ")).toBe(SWATCHES.blue);
    expect(parseHexInput("3b82f6")).toBe(SWATCHES.blue);
    expect(parseHexInput("#abc")).toBe("#aabbcc");
    for (const text of ["", "#", "#12", "#12345", "#1234567", "blue", "#ggg"]) expect(parseHexInput(text)).toBeNull();
  });

  it("remembers the colors picked last, the latest first, each once", () => {
    let recent: string[] = [];
    for (const n of [1, 2, 3, 2]) recent = withRecentColor(recent, `#00000${n}`);
    expect(recent).toEqual(["#000002", "#000003", "#000001"]);
    for (let n = 0; n < 10; n++) recent = withRecentColor(recent, `#1111${10 + n}`);
    expect(recent).toHaveLength(RECENT_COLORS);
    expect(recent[0]).toBe("#111119");
  });
});

describe("deck color mixes and remembered colors", () => {
  it("mixes a color with white for a tint and with black for a shade", () => {
    expect(mixColor("#000000", 0.5)).toBe("#808080");
    expect(mixColor("#ffffff", -0.5)).toBe("#808080");
    expect(mixColor("#3b82f6", 0)).toBe("#3b82f6");
    expect(mixColor("#3b82f6", 1)).toBe("#ffffff");
  });

  it("takes back only the well-formed colors it remembered, as many as it keeps", () => {
    expect(parseRecentColors(["#112233", "red", 4, "#ABCDEF", "#445566"])).toEqual(["#112233", "#445566"]);
    expect(parseRecentColors("nope")).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) => `#00000${i}`);
    expect(parseRecentColors(many)).toHaveLength(RECENT_COLORS);
  });
});
