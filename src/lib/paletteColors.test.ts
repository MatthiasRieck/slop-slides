import { describe, expect, it } from "vitest";
import { DEFAULT_EDIT_STYLES } from "./editTools";
import { SWATCHES } from "./palette";
import {
  freeName,
  normalizeColor,
  PaletteWriter,
  paletteName,
  paletteStyle,
  paletteSwatches,
  paletteToolStyle,
  parsePaletteAdditions,
  SHADOW_COLOR,
} from "./paletteColors";

const PALETTE = [
  { name: "bg", value: "#FFF" },
  { name: "ink", value: "#1c1b19" },
  { name: "accent", value: "#d6461f" },
];

describe("palette colors", () => {
  it("normalizes colors to compare them", () => {
    expect(normalizeColor("#FFF")).toBe("#ffffff");
    expect(normalizeColor("#abcf")).toBe("#aabbcc");
    expect(normalizeColor("#AABBCCFF")).toBe("#aabbcc");
    expect(normalizeColor("#aabbcc80")).toBe("#aabbcc80");
    expect(normalizeColor(" RGB(0, 0, 0) ")).toBe("rgb(0,0,0)");
  });

  it("reads the name a reference names", () => {
    expect(paletteName("var(--accent)")).toBe("accent");
    expect(paletteName(" var( --chart-2 ) ")).toBe("chart-2");
    expect(paletteName("#fff")).toBeNull();
    expect(paletteName(null)).toBeNull();
  });

  it("finds a free name", () => {
    expect(freeName("ink", new Set())).toBe("ink");
    expect(freeName("ink", new Set(["ink", "ink-2"]))).toBe("ink-3");
    expect(freeName("custom", new Set(), true)).toBe("custom-1");
    expect(freeName("custom", new Set(["custom-1"]), true)).toBe("custom-2");
  });

  it("refers to the palette color a pick equals, and adds one it lacks as custom-N", () => {
    const pending = new Map<string, string>();
    const writer = new PaletteWriter(PALETTE, pending);
    expect(writer.reference("#ffffff")).toBe("var(--bg)");
    expect(writer.reference("var(--whatever)")).toBe("var(--whatever)");
    expect(writer.reference("#123456")).toBe("var(--custom-1)");
    expect(writer.reference("#654321")).toBe("var(--custom-2)");
    expect(writer.additions()).toEqual({ "custom-1": "#123456", "custom-2": "#654321" });
    // A later pick, before the save lands, finds the pending color and sends it along again.
    const next = new PaletteWriter(PALETTE, pending);
    expect(next.reference("#123456")).toBe("var(--custom-1)");
    expect(next.reference("#abcdef")).toBe("var(--custom-3)");
    expect(next.additions()).toEqual({ "custom-1": "#123456", "custom-3": "#abcdef" });
    expect(new PaletteWriter(PALETTE, new Map()).additions()).toBeUndefined();
  });

  it("puts a restyle's colors in the palette, and gives a shadow its color", () => {
    const writer = new PaletteWriter(PALETTE, new Map());
    expect(paletteStyle({ color: "#d6461f", fill: "#00ff00", stroke: null, shadow: 12 }, writer)).toEqual({
      color: "var(--accent)",
      fill: "var(--custom-1)",
      stroke: null,
      shadow: 12,
    });
    expect(writer.additions()).toEqual({ "custom-1": "#00ff00", [SHADOW_COLOR.name]: SHADOW_COLOR.value });
    // A palette that has a shadow color keeps it.
    const own = new PaletteWriter([...PALETTE, { name: SHADOW_COLOR.name, value: "#330000" }], new Map());
    paletteStyle({ shadow: 4 }, own);
    expect(own.additions()).toBeUndefined();
  });

  it("gives new elements the deck's own colors for the editor's defaults", () => {
    const writer = new PaletteWriter(PALETTE, new Map());
    expect(paletteToolStyle(DEFAULT_EDIT_STYLES.shape, "shape", writer)).toMatchObject({
      color: "var(--bg)",
      fill: "var(--accent)",
    });
    expect(paletteToolStyle(DEFAULT_EDIT_STYLES.draw, "draw", writer)).toMatchObject({ stroke: "var(--ink)" });
    expect(writer.additions()).toBeUndefined();
    // A color the user chose for the tool stays theirs, added under its use.
    const own = new PaletteWriter(PALETTE, new Map());
    expect(paletteToolStyle({ ...DEFAULT_EDIT_STYLES.text, color: "#00ff00" }, "text", own)).toMatchObject({
      color: "var(--text-color)",
    });
    expect(own.additions()).toEqual({ "text-color": "#00ff00" });
    expect(paletteToolStyle(undefined, null, own)).toBeUndefined();
  });

  it("adds the editor's defaults to a deck without a palette, named for what they do", () => {
    const writer = new PaletteWriter([], new Map());
    expect(paletteToolStyle(DEFAULT_EDIT_STYLES.shape, "shape", writer)).toMatchObject({
      color: "var(--on-accent)",
      fill: "var(--accent)",
    });
    expect(writer.additions()).toEqual({ "on-accent": SWATCHES.white, accent: SWATCHES.blue });
  });

  it("shows the palette as the slide resolves it", () => {
    expect(
      paletteSwatches(
        [
          { name: "a", value: "oklch(0.5 0.1 20)" },
          { name: "b", value: "#00ff00" },
        ],
        [{ name: "a", value: "#112233" }],
      ),
    ).toEqual([
      { name: "a", value: "#112233" },
      { name: "b", value: "#00ff00" },
    ]);
  });

  it("reads the palette colors an editor commit carries", () => {
    expect(parsePaletteAdditions({ "custom-1": "#ff0000", "bad name": "#000", n: 3 })).toEqual([
      { name: "custom-1", value: "#ff0000" },
    ]);
    expect(parsePaletteAdditions({})).toBeUndefined();
    expect(parsePaletteAdditions("x")).toBeUndefined();
    expect(parsePaletteAdditions(undefined)).toBeUndefined();
  });
});
