import { describe, expect, it } from "vitest";

import { DEFAULT_EDIT_STYLES, familyOf, familyOfKind, parseSelection, stepFontSize, toolbarState, type EditSelection } from "./editTools";

const SELECTION: EditSelection = {
  kind: "text",
  text: true,
  vector: false,
  color: "#111111",
  fontSize: 48,
  bold: false,
  italic: false,
  align: "left",
  valign: "top",
  fill: null,
  stroke: null,
  strokeWidth: 0,
};

describe("edit tools", () => {
  it("steps font sizes through a scale", () => {
    expect(stepFontSize(48, 1)).toBe(56);
    expect(stepFontSize(48, -1)).toBe(40);
    // Sizes off the scale snap onto it.
    expect(stepFontSize(50, 1)).toBe(56);
    expect(stepFontSize(50, -1)).toBe(48);
    expect(stepFontSize(240, 1)).toBe(240);
    expect(stepFontSize(12, -1)).toBe(12);
  });

  it("groups tools and added elements into families that share defaults", () => {
    expect(["select", "text", "rect", "rounded", "ellipse", "draw"].map((t) => familyOf(t as never))).toEqual([
      null,
      "text",
      "shape",
      "shape",
      "shape",
      "draw",
    ]);
    expect(["text", "shape", "drawing", "element", "media"].map(familyOfKind)).toEqual(["text", "shape", "draw", null, null]);
  });

  it("shows the selection, else what the tool adds, else nothing", () => {
    expect(toolbarState(SELECTION, "rect", DEFAULT_EDIT_STYLES)).toMatchObject({ style: SELECTION, text: true, valign: true, selected: true });
    expect(toolbarState({ ...SELECTION, valign: null }, "select", DEFAULT_EDIT_STYLES)?.valign).toBe(false);
    expect(toolbarState(null, "rect", DEFAULT_EDIT_STYLES)).toEqual({
      style: DEFAULT_EDIT_STYLES.shape,
      text: true,
      vector: false,
      valign: true,
      selected: false,
    });
    expect(toolbarState(null, "draw", DEFAULT_EDIT_STYLES)).toMatchObject({ text: false, vector: true, valign: false });
    expect(toolbarState(null, "select", DEFAULT_EDIT_STYLES)).toBeNull();
  });

  it("parses what the editor reports, dropping anything malformed", () => {
    expect(parseSelection(SELECTION)).toEqual(SELECTION);
    expect(parseSelection(null)).toBeNull();
    expect(parseSelection({ text: true })).toBeNull();
    expect(
      parseSelection({ kind: "element", color: "red", fill: "#ABCDEF", fontSize: "big", align: "justify", valign: "baseline", strokeWidth: NaN }),
    ).toEqual({
      kind: "element",
      text: false,
      vector: false,
      color: null,
      fontSize: null,
      bold: false,
      italic: false,
      align: "left",
      valign: null,
      fill: "#abcdef",
      stroke: null,
      strokeWidth: 0,
    });
  });
});
