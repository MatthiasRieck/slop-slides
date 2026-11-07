import { describe, expect, it } from "vitest";
import {
  applyPreset,
  colorAt,
  fromOklch,
  parseColor,
  rimColors,
  rotatePalette,
  toHex,
  toOklch,
  wheelPoints,
} from "./colorWheel";
import { PALETTE_PRESETS } from "./palette";

const hex = (text: string) => toHex(parseColor(text)!);
const oklch = (text: string) => toOklch(parseColor(text)!);

describe("color wheel", () => {
  it("reads the CSS colors a palette holds", () => {
    expect(hex("#FFF")).toBe("#ffffff");
    expect(hex("#11223380")).toBe("#11223380");
    expect(hex("white")).toBe("#ffffff");
    expect(hex("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(hex("rgba(0, 0, 255, 0.5)")).toBe("#0000ff80");
    expect(hex("rgb(0 128 0 / 50%)")).toBe("#00800080");
    expect(hex("rgb(100% 0% 0%)")).toBe("#ff0000");
    expect(hex("hsl(120 100% 25%)")).toBe("#008000");
    expect(hex("hsla(0, 100%, 50%, 1)")).toBe("#ff0000");
    expect(hex("oklch(0.628 0.2577 29.23)")).toBe("#ff0000");
    expect(hex("oklch(100% 0 0)")).toBe("#ffffff");
    expect(parseColor("var(--accent)")).toBeNull();
    expect(parseColor("#12")).toBeNull();
    expect(parseColor("rgb(x, 0, 0)")).toBeNull();
  });

  it("goes to OKLCH and back", () => {
    for (const color of ["#e30613", "#05d9e8", "#1c1b19", "#f4f1ea", "#7b61ff"]) {
      expect(toHex(fromOklch(oklch(color)))).toBe(color);
    }
    const red = oklch("#ff0000");
    expect(red.l).toBeCloseTo(0.628, 3);
    expect(red.c).toBeCloseTo(0.2577, 3);
    expect(red.h).toBeCloseTo(29.23, 1);
    expect(oklch("#808080").c).toBeLessThan(1e-3);
  });

  it("pulls a color outside sRGB back in, keeping its lightness and hue", () => {
    const vivid = fromOklch({ l: 0.7, c: 0.4, h: 150, a: 1 });
    const back = toOklch(vivid);
    expect(back.l).toBeCloseTo(0.7, 2);
    expect(back.h).toBeCloseTo(150, 0);
    expect(back.c).toBeLessThan(0.4);
  });

  it("turns every color of a palette, leaving grays and what it cannot read", () => {
    const palette = [
      { name: "accent", value: "#e30613" },
      { name: "ink", value: "#111111" },
      { name: "shade", value: "color-mix(in srgb, var(--accent) 20%, transparent)" },
      { name: "glass", value: "rgba(227, 6, 19, 0.5)" },
    ];
    const turned = rotatePalette(palette, 120);
    const accent = oklch(turned[0]!.value);
    expect(accent.h).toBeCloseTo((oklch("#e30613").h + 120) % 360, 0);
    expect(accent.l).toBeCloseTo(oklch("#e30613").l, 2);
    expect(turned[1]).toEqual(palette[1]);
    expect(turned[2]).toEqual(palette[2]);
    // See-through stays see-through.
    expect(turned[3]!.value).toMatch(/^#[0-9a-f]{6}80$/);
    // A full turn comes back.
    expect(rotatePalette(palette, 360)[0]!.value).toBe("#e30613");
  });

  it("places the palette on the wheel by hue and chroma", () => {
    const points = wheelPoints([
      { name: "a", value: "#ff0000" },
      { name: "b", value: "#808080" },
      { name: "c", value: "var(--a)" },
    ]);
    expect(points.map((p) => p.name)).toEqual(["a", "b"]);
    expect(points[0]!.angle).toBeCloseTo(29.23, 1);
    expect(points[0]!.radius).toBeCloseTo(0.2577 / 0.32, 2);
    expect(points[1]!.radius).toBeLessThan(0.01);
    expect(points[0]!.hex).toBe("#ff0000");
  });

  it("picks the color at a spot on the wheel, as light as the one it moves", () => {
    const moved = oklch(colorAt("#e30613", 250, 0.5)!);
    expect(moved.h).toBeCloseTo(250, 0);
    expect(moved.c).toBeCloseTo(0.16, 2);
    expect(moved.l).toBeCloseTo(oklch("#e30613").l, 2);
    expect(colorAt("var(--x)", 0, 0)).toBeNull();
  });

  it("draws the rim all the way round", () => {
    const rim = rimColors(6);
    expect(rim).toHaveLength(7);
    expect(rim[6]).toBe(rim[0]);
  });

  describe("presets", () => {
    const midnight = PALETTE_PRESETS.find((p) => p.id === "midnight")!.colors;

    it("gives each role its color, by name or a name it goes by", () => {
      const out = applyPreset(
        [
          { name: "background", value: "#ffffff" },
          { name: "ink", value: "#111111" },
          { name: "brand", value: "#e30613" },
          { name: "wash", value: "rgba(255, 255, 255, 0.5)" },
        ],
        midnight,
      );
      expect(out[0]).toEqual({ name: "background", value: midnight.bg });
      expect(out[1]).toEqual({ name: "ink", value: midnight.ink });
      expect(out[2]).toEqual({ name: "brand", value: midnight.accent });
      // Not a role: it moves as the background (the nearest role) did, and stays see-through.
      expect(oklch(out[3]!.value).l).toBeCloseTo(oklch(midnight.bg!).l, 1);
      expect(out[3]!.value).toMatch(/80$/);
    });

    it("carries a color with no role along with the nearest one", () => {
      const out = applyPreset(
        [
          { name: "accent", value: "#e30613" },
          { name: "accent-dark", value: "#a0040d" },
        ],
        midnight,
      );
      const before = oklch("#a0040d");
      const accentShift = oklch(midnight.accent!).h - oklch("#e30613").h;
      expect(oklch(out[1]!.value).h).toBeCloseTo((before.h + accentShift + 360) % 360, 0);
    });

    it("pairs colors up by lightness when no role is in common", () => {
      const out = applyPreset(
        [
          { name: "sky", value: "#ffffff" },
          { name: "night", value: "#000000" },
        ],
        midnight,
      );
      expect(out.find((c) => c.name === "night")!.value).toBe(midnight.bg);
      expect(out.find((c) => c.name === "sky")!.value).toBe(midnight.ink);
    });

    it("leaves colors it cannot read", () => {
      const out = applyPreset([{ name: "x", value: "light-dark(#fff, #000)" }], midnight);
      expect(out).toEqual([{ name: "x", value: "light-dark(#fff, #000)" }]);
    });
  });
});
