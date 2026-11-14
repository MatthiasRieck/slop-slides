// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  AUTOFIT_LABELS,
  CASE_LABELS,
  combineElements,
  DEFAULT_EDIT_STYLES,
  defaultsFrom,
  EDIT_TOOL_KEYS,
  type EditSelection,
  FIT_LABELS,
  FIT_POSITION_NAMES,
  FIT_POSITIONS,
  familyOf,
  familyOfKind,
  firstFamily,
  fontChoices,
  fontWeights,
  isMixed,
  LIST_STYLES,
  linkedSlide,
  normalizeHref,
  parseDeckColors,
  parseElement,
  parseFonts,
  parseHexColor,
  parseMenuTarget,
  parseNumber,
  parseSelection,
  SYSTEM_FONTS,
  toolbarState,
  WEIGHT_NAMES,
} from "./editTools";

const SELECTION: EditSelection = {
  kind: "text",
  text: true,
  vector: false,
  color: "#111111",
  colorOther: false,
  fillOther: false,
  strokeOther: false,
  fontSize: 48,
  fontFamily: "Inter",
  bold: false,
  weight: 500,
  italic: false,
  underline: true,
  strike: false,
  script: "sup",
  textCase: "upper",
  highlight: "#facc15",
  letterSpacing: 2,
  lineHeight: 1.2,
  spaceBefore: 8,
  spaceAfter: 16,
  listStyle: "lower-alpha",
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
  dash: "dashed",
  line: { start: "dot", end: "triangle", route: "elbow" },
  adjust: { value: 7, min: 3, max: 12, step: 1, label: "Points" },
  opacity: 0.5,
  shadow: 12,
  radius: 8,
  clipped: false,
  image: false,
  fit: null,
  fitPosition: null,
  alt: null,
  flippable: false,
  flipX: false,
  flipY: false,
  group: false,
  locked: true,
  mixed: ["fontSize", "align"],
};

describe("edit tools", () => {
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
      style: { ...SELECTION, adjust: 7 },
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
        align: "start",
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
      colorOther: false,
      fillOther: false,
      strokeOther: false,
      fontSize: null,
      fontFamily: null,
      bold: false,
      weight: 400,
      italic: false,
      underline: false,
      strike: false,
      script: null,
      textCase: null,
      highlight: null,
      letterSpacing: 0,
      lineHeight: null,
      spaceBefore: 0,
      spaceAfter: 0,
      listStyle: null,
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
      dash: "solid",
      line: null,
      adjust: null,
      opacity: 1,
      shadow: 0,
      radius: null,
      clipped: false,
      image: false,
      fit: null,
      fitPosition: null,
      alt: null,
      flippable: false,
      flipX: false,
      flipY: false,
      group: false,
      locked: false,
      mixed: [],
    });
    expect(parseSelection({ kind: "shape", flippable: true })?.flippable).toBe(true);
    expect(
      parseSelection({ kind: "drawing", dash: "wavy", line: { start: "star", end: "arrow", route: "zigzag" } }),
    ).toMatchObject({
      dash: "solid",
      line: { start: null, end: "arrow", route: "straight" },
    });
  });

  it("puts lines and connectors with the drawings, and leaves a line's heads and route to its tool", () => {
    expect(["line", "arrow", "elbow", "curve"].map((t) => familyOf(t as never))).toEqual([
      "draw",
      "draw",
      "draw",
      "draw",
    ]);
    expect(defaultsFrom({ dash: "dotted", headStart: "dot", headEnd: "arrow", route: "elbow", adjust: 8 })).toEqual({
      dash: "dotted",
    });
    expect(
      parseSelection({ kind: "shape", adjust: { value: 5, min: 3, max: "12", step: 1, label: "Points" } })?.adjust,
    ).toBeNull();
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
    expect(["diamond", "chevron", "block-arrow", "double-arrow"].map((t) => familyOf(t as never))).toEqual([
      "shape",
      "shape",
      "shape",
      "shape",
    ]);
    // Brackets and braces are open outlines, drawn like a line.
    expect(familyOf("bracket")).toBe("draw");
    expect(familyOf("brace")).toBe("draw");
    expect(toolbarState(null, "brace", DEFAULT_EDIT_STYLES)?.vector).toBe(true);
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

describe("what the toolbar and the context menu are told", () => {
  const A = { path: "#intro > h1:nth-child(1)", markup: "<h1>A</h1>", name: '<h1> "A"', added: true };
  const B = { path: "#intro > p:nth-child(2)", markup: "<p>B</p>", name: '<p> "B"', added: false };

  it("reports justified text as justified", () => {
    expect(parseSelection({ kind: "text", align: "justify" })?.align).toBe("justify");
  });

  it("tells a color that is not one plain color from none", () => {
    const mixed = parseSelection({ kind: "shape", fill: null, fillOther: true, strokeOther: "yes" });
    expect(mixed).toMatchObject({ fill: null, fillOther: true, strokeOther: false, colorOther: false });
  });

  it("reads a context menu report, leaving out what is malformed", () => {
    expect(parseMenuTarget({ element: A, elements: [A, { path: 3 }, B], editable: true, locked: true })).toEqual({
      element: A,
      elements: [A, B],
      editable: true,
      unlockable: true,
      under: [],
      parent: null,
    });
    // A report without the list (an older editor) is about its one element.
    expect(parseMenuTarget({ element: A })).toMatchObject({
      element: A,
      elements: [A],
      editable: false,
      unlockable: false,
    });
    expect(parseMenuTarget({ element: null, locked: "yes" })).toEqual({
      element: null,
      elements: [],
      editable: false,
      unlockable: false,
      under: [],
      parent: null,
    });
    expect(parseMenuTarget(null).element).toBeNull();
  });

  it("takes what lies under the pointer and what holds the selection, leaving out what is no place", () => {
    const target = parseMenuTarget({
      element: A,
      under: [
        { path: [0, 2], name: "Text: Two", selected: true },
        { path: [], name: "Nothing" },
        { path: [0, -1], name: "Bad" },
        { path: [1], name: 4 },
        { path: [0], name: "Box" },
      ],
      parent: { path: [0], name: "Box" },
    });
    expect(target.under).toEqual([
      { path: [0, 2], name: "Text: Two", selected: true },
      { path: [0], name: "Box", selected: false },
    ]);
    expect(target.parent).toEqual({ path: [0], name: "Box", selected: false });
    expect(parseMenuTarget({ element: A, under: "all", parent: { path: "0" } })).toMatchObject({
      under: [],
      parent: null,
    });
  });

  it("makes several elements the one thing a question is about", () => {
    expect(combineElements([])).toBeNull();
    expect(combineElements([A])).toBe(A);
    expect(combineElements([A, B])).toEqual({
      path: "#intro > h1:nth-child(1), #intro > p:nth-child(2)",
      markup: "<h1>A</h1>\n<p>B</p>",
      name: "2 elements",
      added: false,
    });
    expect(combineElements([A, A])?.added).toBe(true);
  });

  it("reads the text's weight, case, highlight, paragraph spacing and bullets, and what several elements do not share", () => {
    expect(
      parseSelection({
        kind: "text",
        weight: 300,
        textCase: "capitalize",
        highlight: "#FFFF00",
        spaceBefore: 12,
        spaceAfter: 4,
        listStyle: "square",
        mixed: ["fontFamily", 3, "opacity"],
      }),
    ).toMatchObject({
      weight: 300,
      textCase: "capitalize",
      highlight: "#ffff00",
      spaceBefore: 12,
      spaceAfter: 4,
      listStyle: "square",
      mixed: ["fontFamily", "opacity"],
    });
    // What an older or malformed report leaves out has its plain value.
    expect(parseSelection({ kind: "text", bold: true, textCase: "SHOUT", highlight: "yellow" })).toMatchObject({
      weight: 700,
      textCase: null,
      highlight: null,
      spaceBefore: 0,
      spaceAfter: 0,
      listStyle: null,
      mixed: [],
    });
    const mixed = parseSelection({ kind: "text", mixed: ["fontSize"] });
    expect(isMixed(mixed, "fontSize")).toBe(true);
    expect(isMixed(mixed, "align")).toBe(false);
    expect(isMixed(null, "fontSize")).toBe(false);
  });

  it("offers the weights the deck has files for, or the usual ones, always with the current one", () => {
    const fonts = parseFonts([
      { name: "Inter", stack: "Inter, sans-serif", weights: [300, 400, 600, 700, 1200] },
      { name: "Lora", stack: "Lora, serif", weights: [400] },
    ]);
    expect(fonts[0]!.weights).toEqual([300, 400, 600, 700]);
    expect(fontWeights(fonts, '"Inter", sans-serif', 400)).toEqual([300, 400, 600, 700]);
    expect(fontWeights(fonts, "Inter", 500)).toEqual([300, 400, 500, 600, 700]);
    // One weight is no choice: the usual ones show.
    expect(fontWeights(fonts, "Lora", 400)).toEqual([300, 400, 500, 600, 700]);
    expect(fontWeights([], null, 900)).toEqual([300, 400, 500, 600, 700, 900]);
    expect(WEIGHT_NAMES[600]).toBe("Semibold");
  });

  it("reads a typed number within its range, to the places it takes", () => {
    expect(parseNumber(" 1.25 ", 0.5, 5, 2)).toBe(1.25);
    expect(parseNumber("1,5", 0.5, 5, 1)).toBe(1.5);
    expect(parseNumber("3.7", 0, 10)).toBe(4);
    expect(["", "x", "11", "-1"].map((t) => parseNumber(t, 0, 10))).toEqual([null, null, null, null]);
  });

  it("keeps the highlight, paragraph spacing and bullets out of the defaults for new elements", () => {
    expect(
      defaultsFrom({ highlight: "#ffff00", spaceBefore: 8, spaceAfter: 8, listStyle: "square", weight: 300 }),
    ).toEqual({
      weight: 300,
    });
  });

  it("names the choices in plain words", () => {
    expect(CASE_LABELS.map((c) => c.label)).toEqual(["As typed", "UPPERCASE", "lowercase", "Capitalize Each Word"]);
    expect(LIST_STYLES.ul.map((c) => c.value)).toContain("disc");
    expect(LIST_STYLES.ol.map((c) => c.value)).toContain("decimal");
    expect(AUTOFIT_LABELS.map((c) => c.label)).toEqual(["Don't autofit", "Shrink text to fit", "Grow box to fit"]);
    expect(FIT_LABELS.map((c) => c.label)).toEqual(["Fit inside", "Fill and crop", "Stretch"]);
    expect(FIT_POSITION_NAMES).toHaveLength(FIT_POSITIONS.length);
    expect(FIT_POSITION_NAMES[FIT_POSITIONS.indexOf("50% 50%")]).toBe("Center");
  });
});
