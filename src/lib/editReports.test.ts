import { describe, expect, it } from "vitest";

import type { EditGeometry, EditLayer } from "./arrange";
import { sameColors, sameFonts, sameGeometry, sameLayers, sameSelection, sameTexts } from "./editReports";
import { type EditSelection, parseSelection } from "./editTools";

const selection = (more: Record<string, unknown> = {}) => parseSelection({ kind: "text", text: true, ...more })!;
const geometry = (more: Partial<EditGeometry> = {}): EditGeometry => ({
  count: 1,
  x: 10,
  y: 20,
  w: 300,
  h: 200,
  rotation: 0,
  ...more,
});
const layer = (more: Partial<EditLayer> = {}): EditLayer => ({
  path: [0, 1],
  name: "Title",
  group: false,
  locked: false,
  held: false,
  selected: false,
  depth: 1,
  ...more,
});

describe("reports from the slide editor", () => {
  it("takes a selection reported again as the same, whatever it holds", () => {
    const line = { start: "arrow", end: null, route: "elbow" };
    const adjust = { value: 5, min: 3, max: 12, step: 1, label: "Points" };
    expect(sameSelection(selection({ bold: true, line, adjust }), selection({ bold: true, line, adjust }))).toBe(true);
    expect(sameSelection(null, null)).toBe(true);
  });

  it("tells selections apart by any field, also of the line and the proportions", () => {
    const was = selection({ color: "#111111", line: { start: null, end: "arrow", route: "straight" } });
    expect(sameSelection(was, selection({ color: "#222222", line: was.line }))).toBe(false);
    expect(sameSelection(was, selection({ color: "#111111", line: { ...was.line, route: "curved" } }))).toBe(false);
    expect(sameSelection(was, selection({ color: "#111111" }))).toBe(false);
    expect(sameSelection(was, null)).toBe(false);
    expect(sameSelection(null, was)).toBe(false);
    const star = selection({ adjust: { value: 5, min: 3, max: 12, step: 1, label: "Points" } });
    const more = selection({ adjust: { value: 6, min: 3, max: 12, step: 1, label: "Points" } });
    expect(sameSelection(star, more)).toBe(false);
  });

  it("covers every field a selection has", () => {
    const was = selection();
    for (const key of Object.keys(was) as (keyof EditSelection)[]) {
      const changed = { ...was, [key]: typeof was[key] === "boolean" ? !was[key] : "changed" } as EditSelection;
      expect(sameSelection(was, changed), key).toBe(false);
    }
  });

  it("compares where the selection is", () => {
    expect(sameGeometry(geometry(), geometry())).toBe(true);
    expect(sameGeometry(geometry(), geometry({ x: 11 }))).toBe(false);
    expect(sameGeometry(geometry(), geometry({ rotation: null }))).toBe(false);
    expect(sameGeometry(geometry(), null)).toBe(false);
    expect(sameGeometry(null, null)).toBe(true);
  });

  it("compares the layers, with their paths and state", () => {
    expect(sameLayers([layer(), layer({ path: [2] })], [layer(), layer({ path: [2] })])).toBe(true);
    expect(sameLayers([layer()], [layer({ selected: true })])).toBe(false);
    expect(sameLayers([layer()], [layer({ path: [0, 2] })])).toBe(false);
    expect(sameLayers([layer()], [layer({ path: [0] })])).toBe(false);
    expect(sameLayers([layer()], [layer(), layer()])).toBe(false);
    expect(sameLayers([], [])).toBe(true);
  });

  it("compares lists of texts, fonts and colors in their order", () => {
    expect(sameTexts(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameTexts(["a", "b"], ["b", "a"])).toBe(false);
    const inter = { name: "Inter", stack: "Inter, sans-serif" };
    expect(sameFonts([inter], [{ ...inter }])).toBe(true);
    expect(sameFonts([inter], [{ ...inter, stack: "Inter" }])).toBe(false);
    expect(sameColors([{ name: "--accent", value: "#ff0000" }], [{ name: "--accent", value: "#ff0000" }])).toBe(true);
    expect(sameColors([{ name: "--accent", value: "#ff0000" }], [{ name: "--ink", value: "#ff0000" }])).toBe(false);
  });
});
