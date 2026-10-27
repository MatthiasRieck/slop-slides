import { describe, expect, it } from "vitest";

import {
  DEFAULT_EDIT_STYLES,
  defaultsFrom,
  type EditSelection,
  familyOf,
  familyOfKind,
  firstFamily,
  fontChoices,
  linkedSlide,
  normalizeHref,
  parseFontSize,
  parseFonts,
  parseSelection,
  SYSTEM_FONTS,
  stepFontSize,
  toolbarState,
} from "./editTools";

const SELECTION: EditSelection = {
  kind: "text",
  text: true,
  vector: false,
  color: "#111111",
  fontSize: 48,
  fontFamily: "Inter",
  bold: false,
  italic: false,
  underline: true,
  strike: false,
  script: "sup",
  letterSpacing: 2,
  lineHeight: 1.2,
  align: "left",
  valign: "top",
  list: "ol",
  link: "#intro",
  autofit: "shrink",
  editing: true,
  range: true,
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
    expect(["text", "shape", "drawing", "element", "media"].map(familyOfKind)).toEqual([
      "text",
      "shape",
      "draw",
      null,
      null,
    ]);
  });

  it("shows the selection, else what the tool adds, else nothing", () => {
    expect(toolbarState(SELECTION, "rect", DEFAULT_EDIT_STYLES)).toMatchObject({
      style: SELECTION,
      text: true,
      valign: true,
      selected: true,
    });
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
      parseSelection({
        kind: "element",
        color: "red",
        fill: "#ABCDEF",
        fontSize: "big",
        align: "justify",
        valign: "baseline",
        strokeWidth: NaN,
        script: "super",
        list: "dl",
        link: 5,
        autofit: "squeeze",
        fontFamily: "",
        letterSpacing: "wide",
      }),
    ).toEqual({
      kind: "element",
      text: false,
      vector: false,
      color: null,
      fontSize: null,
      fontFamily: null,
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      script: null,
      letterSpacing: 0,
      lineHeight: null,
      align: "left",
      valign: null,
      list: null,
      link: null,
      autofit: null,
      editing: false,
      range: false,
      fill: "#abcdef",
      stroke: null,
      strokeWidth: 0,
    });
  });

  it("keeps a restyle's look as the next element's default, but not its script or fit", () => {
    expect(
      defaultsFrom({ bold: true, underline: true, script: "sup", autofit: "grow", fontFamily: "Georgia" }),
    ).toEqual({
      bold: true,
      underline: true,
      fontFamily: "Georgia",
    });
  });

  it("reads a typed font size", () => {
    expect(parseFontSize(" 72 ")).toBe(72);
    expect(parseFontSize("40.6")).toBe(41);
    expect(["", "0", "-4", "1000", "big"].map(parseFontSize)).toEqual([null, null, null, null, null]);
  });

  it("offers the deck's fonts first, then system fonts it does not have", () => {
    const deck = parseFonts([
      { name: "Georgia", stack: "Georgia, serif" },
      { name: " Inter ", stack: '"Inter", sans-serif' },
      { name: "", stack: "x" },
      { name: 1 },
      null,
    ]);
    expect(deck).toEqual([
      { name: "Georgia", stack: "Georgia, serif" },
      { name: "Inter", stack: '"Inter", sans-serif' },
    ]);
    expect(parseFonts("nope")).toEqual([]);
    const choices = fontChoices(deck);
    expect(choices.deck).toBe(deck);
    expect(choices.system.map((f) => f.name)).not.toContain("Georgia");
    expect(choices.system).toHaveLength(SYSTEM_FONTS.length - 1);
    expect(firstFamily(`"Playfair Display", Georgia, serif`)).toBe("Playfair Display");
    expect(firstFamily("'Inter'")).toBe("Inter");
    expect(firstFamily(null)).toBe("");
  });

  it("turns typed links into web, mail or slide links, refusing anything else", () => {
    expect(normalizeHref("#pricing")).toBe("#pricing");
    expect(normalizeHref(" https://example.com/a?b ")).toBe("https://example.com/a?b");
    expect(normalizeHref("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeHref("me@example.com")).toBe("mailto:me@example.com");
    expect(normalizeHref("mailto:me@example.com")).toBe("mailto:me@example.com");
    expect(["", "  ", "#", "javascript:alert(1)", "file:///etc/passwd", "two words"].map(normalizeHref)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(linkedSlide("#the%20end")).toBe("the end");
    expect(linkedSlide("https://example.com")).toBeNull();
    expect(linkedSlide(null)).toBeNull();
  });
});
