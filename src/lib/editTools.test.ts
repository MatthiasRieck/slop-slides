import { describe, expect, it } from "vitest";

import {
  DEFAULT_EDIT_STYLES,
  defaultsFrom,
  EDIT_TOOL_KEYS,
  type EditSelection,
  familyOf,
  familyOfKind,
  firstFamily,
  fontChoices,
  linkedSlide,
  normalizeHref,
  parseDeckColors,
  parseElement,
  parseFontSize,
  parseFonts,
  parseHexColor,
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
  opacity: 0.5,
  shadow: 12,
  radius: 8,
  clipped: false,
  image: false,
  fit: null,
  fitPosition: null,
  alt: null,
  flipX: false,
  flipY: false,
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
      opacity: 1,
      shadow: 0,
      radius: null,
      clipped: false,
      image: false,
      fit: null,
      fitPosition: null,
      alt: null,
      flipX: false,
      flipY: false,
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

  it("sorts the new tools into families: lines draw, cut-out shapes are shapes, the painter adds nothing", () => {
    expect(familyOf("line")).toBe("draw");
    expect(familyOf("arrow")).toBe("draw");
    expect(familyOf("triangle")).toBe("shape");
    expect(familyOf("star")).toBe("shape");
    expect(familyOf("bubble")).toBe("shape");
    expect(familyOf("paint")).toBeNull();
    expect(toolbarState(null, "paint", DEFAULT_EDIT_STYLES)).toBeNull();
    expect(toolbarState(null, "arrow", DEFAULT_EDIT_STYLES)?.vector).toBe(true);
  });

  it("keeps an element's own look out of the defaults for new elements", () => {
    expect(
      defaultsFrom({ fill: "#ff0000", opacity: 0.5, shadow: 8, radius: 4, fit: "cover", alt: "x", flipX: true }),
    ).toEqual({ fill: "#ff0000" });
  });

  it("parses the look and image fields of a selection report", () => {
    const parsed = parseSelection({
      kind: "media",
      opacity: 0.4,
      shadow: 6,
      radius: 12,
      clipped: true,
      image: true,
      fit: "cover",
      fitPosition: "50% 0%",
      alt: "A cat",
      flipX: true,
      flipY: false,
    });
    expect(parsed).toMatchObject({
      opacity: 0.4,
      shadow: 6,
      radius: 12,
      clipped: true,
      image: true,
      fit: "cover",
      fitPosition: "50% 0%",
      alt: "A cat",
      flipX: true,
      flipY: false,
    });
    expect(parseSelection({ kind: "element", fit: "tile", radius: "2px" })).toMatchObject({
      opacity: 1,
      shadow: 0,
      radius: null,
      fit: null,
      alt: null,
      image: false,
    });
  });

  it("takes only well-formed deck colors", () => {
    expect(
      parseDeckColors([{ name: "brand", value: "#AABBCC" }, { name: "bad", value: "red" }, { value: "#000000" }, null]),
    ).toEqual([{ name: "brand", value: "#aabbcc" }]);
    expect(parseDeckColors("nope")).toEqual([]);
    expect(parseHexColor("#123456")).toBe("#123456");
    expect(parseHexColor(null)).toBeNull();
  });

  it("offers line and arrow shortcuts", () => {
    expect(EDIT_TOOL_KEYS.l).toBe("line");
    expect(EDIT_TOOL_KEYS.a).toBe("arrow");
  });
});

describe("parseElement", () => {
  it("reads what the editor reports about an element", () => {
    const element = { path: "#a > p:nth-child(1)", markup: "<p>Hi</p>", name: '<p> "Hi"', added: true };
    expect(parseElement(element)).toEqual(element);
    expect(parseElement({ ...element, added: "yes" })?.added).toBe(false);
  });

  it("takes nothing else for one", () => {
    expect(parseElement(null)).toBeNull();
    expect(parseElement("p")).toBeNull();
    expect(parseElement({ path: "#a", markup: 1, name: "p" })).toBeNull();
  });
});
