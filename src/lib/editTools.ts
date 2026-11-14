/**
 * The edit toolbar's tools and styles: the pure parts, shared by the stage and its tests. The
 * slide editor (src-tauri/assets/editor/) applies them in the slide's preview.
 */

import { SWATCHES } from "./palette";

export type EditTool =
  | "select"
  | "text"
  | "rect"
  | "rounded"
  | "ellipse"
  | "triangle"
  | "star"
  | "bubble"
  | "diamond"
  | "chevron"
  | "block-arrow"
  | "double-arrow"
  | "hexagon"
  | "octagon"
  | "pentagon"
  | "parallelogram"
  | "trapezoid"
  | "plus"
  | "cylinder"
  | "document"
  | "heart"
  | "bracket"
  | "brace"
  | "draw"
  | "line"
  | "arrow"
  | "elbow"
  | "curve"
  | "paint";

/** Tools whose new elements share style defaults. */
export type ToolFamily = "text" | "shape" | "draw";

export type TextAlign = "left" | "center" | "right" | "justify";
export type VerticalAlign = "top" | "middle" | "bottom";
export type StackOrder = "front" | "forward" | "backward" | "back";
export type ListKind = "ul" | "ol";
export type Script = "sup" | "sub";
/** How a text box handles text that does not fit: shrink the text, or grow the box. */
export type Autofit = "shrink" | "grow";
/** How an image fills its box. */
export type ImageFit = "contain" | "cover" | "fill";
/** How a line or border is drawn. */
export type Dash = "solid" | "dashed" | "dotted";
/** What a line ends in. */
export type HeadKind = "arrow" | "triangle" | "bar" | "dot";
/** How a line goes between its ends: straight or curved through its points, or as a connector. */
export type LineRoute = "straight" | "elbow" | "curved";

/** A figure's proportions, as the slide editor reports them (see `FIGURES` in assets/editor/). */
export interface ShapeAdjust {
  value: number;
  min: number;
  max: number;
  step: number;
  /** What it changes: "Points" for a star, "Tail" for a speech bubble… */
  label: string;
}

/** A line's ends and route, as the slide editor reports them. */
export interface LineLook {
  start: HeadKind | null;
  end: HeadKind | null;
  route: LineRoute;
}

export const DASHES: Dash[] = ["solid", "dashed", "dotted"];
export const HEAD_KINDS: HeadKind[] = ["arrow", "triangle", "bar", "dot"];
export const LINE_ROUTES: LineRoute[] = ["straight", "elbow", "curved"];

/** A style for new elements, or the changes to apply to the selection. Null colors mean none. */
export interface EditStyle {
  color?: string | null;
  fontSize?: number;
  /** A CSS font-family stack; null for the deck's own font. */
  fontFamily?: string | null;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  script?: Script | null;
  /** Pixels between letters (0 for normal). */
  letterSpacing?: number;
  /** A multiple of the font size; null for the deck's own. */
  lineHeight?: number | null;
  autofit?: Autofit | null;
  align?: TextAlign;
  valign?: VerticalAlign;
  fill?: string | null;
  /** Border color, or a drawing's stroke. */
  stroke?: string | null;
  strokeWidth?: number;
  dash?: Dash;
  /** A line's heads, at the end it starts from and the one it goes to; null for none. */
  headStart?: HeadKind | null;
  headEnd?: HeadKind | null;
  route?: LineRoute;
  /** A figure's proportions (see ShapeAdjust). */
  adjust?: number;
  /** 0.05 to 1. */
  opacity?: number;
  /** Blur of its shadow in pixels; 0 for none. */
  shadow?: number;
  /** Corner radius in pixels; null where it has none (drawings, cut-out shapes). */
  radius?: number | null;
  fit?: ImageFit | null;
  /** Which part of an image shows when it does not fill its box, like "50% 0%". */
  fitPosition?: string | null;
  alt?: string | null;
  flipX?: boolean;
  flipY?: boolean;
}

/** What the slide editor reports about the selected element (see `describe` in assets/editor/). */
export interface EditSelection {
  /** `text`, `shape` or `drawing` for elements the user added; `media` or `element` otherwise. */
  kind: string;
  /** It holds text, so the text controls apply. */
  text: boolean;
  /** A drawing: fill and border are its line's fill and stroke. */
  vector: boolean;
  color: string | null;
  /**
   * The text color, fill or line is not one plain color (a gradient, an image, `currentColor`),
   * or differs among the selected elements: the color itself is then null, as it is for none.
   */
  colorOther: boolean;
  fillOther: boolean;
  strokeOther: boolean;
  fontSize: number | null;
  /** The first family of its font. */
  fontFamily: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  script: Script | null;
  letterSpacing: number;
  lineHeight: number | null;
  align: TextAlign;
  /** Null when its text cannot align vertically (it is not a flex box). */
  valign: VerticalAlign | null;
  /** The list its text (or the caret) is in. */
  list: ListKind | null;
  /** Where its link (or the link at the caret) goes. */
  link: string | null;
  autofit: Autofit | null;
  /** Its text is being edited: text styles go to the selected text. */
  editing: boolean;
  /** While editing, some text is selected (not just a caret). */
  range: boolean;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  dash: Dash;
  /** Its heads and route, when it is a line. */
  line: LineLook | null;
  /** A figure's proportions, when it has any to change. */
  adjust: ShapeAdjust | null;
  opacity: number;
  shadow: number;
  radius: number | null;
  /** A box cut out with a `clip-path` the editor cannot redraw: no border, shadow or corner radius. */
  clipped: boolean;
  /** An <img>, so the image controls apply. */
  image: boolean;
  fit: ImageFit | null;
  fitPosition: string | null;
  alt: string | null;
  /** Flipping mirrors what it shows without mirroring text: images, shapes like a triangle, drawings, and lines (through their points). */
  flippable: boolean;
  flipX: boolean;
  flipY: boolean;
  /** A group the user made: its restyles go to everything in it. */
  group: boolean;
  /** Locked, or in something locked: it cannot be moved or deleted. */
  locked: boolean;
}

/** The element a right-click selected, as the slide editor reports it (see `slop:edit-menu` in assets/editor/). */
export interface EditElement {
  /** A CSS selector for it, starting at its slide. */
  path: string;
  /** Its markup without the editor's marks. */
  markup: string;
  /** Its tag and the start of its text. */
  name: string;
  /** The user added it by hand (`data-added` / `data-dropped`), so it has no place in the layout yet. */
  added: boolean;
}

/** What a right-click in the slide editor reports for the app's menu (see `slop:edit-menu` in assets/editor/). */
export interface EditMenuTarget {
  /** The primary selected element; null on an empty spot. */
  element: EditElement | null;
  /** Every selected element, in the slide's order. */
  elements: EditElement[];
  /** The one selected element holds text that can be edited. */
  editable: boolean;
  /** Something on the slide is locked. */
  unlockable: boolean;
}

/** A context menu report from the slide editor; what is malformed in it is left out. */
export function parseMenuTarget(data: unknown): EditMenuTarget {
  const v = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const element = parseElement(v.element);
  const listed = Array.isArray(v.elements) ? v.elements.flatMap((e) => parseElement(e) ?? []) : [];
  return {
    element,
    elements: listed.length > 0 ? listed : element ? [element] : [],
    editable: v.editable === true,
    unlockable: v.locked === true,
  };
}

/**
 * Several selected elements as the one thing a question to the agent is about: their selectors
 * and markup together, named by how many they are. One element is itself; none is null.
 */
export function combineElements(elements: EditElement[]): EditElement | null {
  if (elements.length <= 1) return elements[0] ?? null;
  return {
    path: elements.map((e) => e.path).join(", "),
    markup: elements.map((e) => e.markup).join("\n"),
    name: `${elements.length} elements`,
    added: elements.every((e) => e.added),
  };
}

/** What the agent adds to a slide for the user, started from the toolbar's Insert section. */
export type AgentInsert = "table" | "chart" | "icon";

/** Single-key shortcuts in edit mode. */
export const EDIT_TOOL_KEYS: Record<string, EditTool> = {
  v: "select",
  t: "text",
  r: "rect",
  o: "ellipse",
  d: "draw",
  l: "line",
  a: "arrow",
};

export const DEFAULT_EDIT_STYLES: Record<ToolFamily, EditStyle> = {
  text: {
    color: SWATCHES.ink,
    fontSize: 48,
    bold: false,
    italic: false,
    align: "left",
    valign: "top",
    fill: null,
    stroke: null,
    strokeWidth: 0,
  },
  shape: {
    color: SWATCHES.white,
    fontSize: 40,
    bold: false,
    italic: false,
    align: "center",
    valign: "middle",
    fill: SWATCHES.blue,
    stroke: null,
    strokeWidth: 0,
  },
  draw: { fill: null, stroke: SWATCHES.ink, strokeWidth: 6 },
};

export const EDIT_COLORS = Object.values(SWATCHES);

export const BORDER_WIDTHS = [0, 1, 2, 4, 6, 8, 12, 16] as const;

/**
 * The widths the border (or line) width list offers: the usual ones and the current one. A line
 * has no "none": at zero it would be gone, with nothing left to select.
 */
export function strokeWidths(current: number, vector: boolean): number[] {
  const widths = [...new Set<number>([...BORDER_WIDTHS, current])].sort((a, b) => a - b);
  return vector ? widths.filter((w) => w > 0) : widths;
}

/** How the toolbar names each way of handling text that does not fit; "" is no autofit. */
export const AUTOFIT_LABELS: { value: Autofit | ""; label: string }[] = [
  { value: "", label: "Don't autofit" },
  { value: "shrink", label: "Shrink text to fit" },
  { value: "grow", label: "Grow box to fit" },
];

/** How the toolbar names each way an image fills its box. */
export const FIT_LABELS: { value: ImageFit; label: string }[] = [
  { value: "contain", label: "Fit inside" },
  { value: "cover", label: "Fill and crop" },
  { value: "fill", label: "Stretch" },
];

const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 112, 128, 144, 160, 200, 240];

/** The next font size up (`step` 1) or down (-1) from `size`. */
export function stepFontSize(size: number, step: 1 | -1): number {
  if (step > 0) return FONT_SIZES.find((s) => s > size) ?? FONT_SIZES[FONT_SIZES.length - 1]!;
  return [...FONT_SIZES].reverse().find((s) => s < size) ?? FONT_SIZES[0]!;
}

export function familyOf(tool: EditTool): ToolFamily | null {
  if (tool === "text" || tool === "draw") return tool;
  if (tool === "line" || tool === "arrow" || tool === "elbow" || tool === "curve") return "draw";
  if (tool === "bracket" || tool === "brace") return "draw";
  return tool === "select" || tool === "paint" ? null : "shape";
}

/** The family whose defaults a selected element of `kind` updates; null for the deck's own elements. */
export function familyOfKind(kind: string): ToolFamily | null {
  return kind === "text" ? "text" : kind === "shape" ? "shape" : kind === "drawing" ? "draw" : null;
}

/**
 * What the toolbar shows and which controls it enables: the selection's style, or with nothing
 * selected, the defaults for what the current tool adds. Null when there is neither.
 */
export function toolbarState(selection: EditSelection | null, tool: EditTool, styles: Record<ToolFamily, EditStyle>) {
  if (selection) {
    return {
      style: { ...selection, adjust: selection.adjust?.value } as EditStyle,
      text: selection.text,
      vector: selection.vector,
      valign: selection.valign !== null,
      selected: true,
    };
  }
  const family = familyOf(tool);
  if (!family) return null;
  return {
    style: styles[family],
    text: family !== "draw",
    vector: family === "draw",
    valign: family !== "draw",
    selected: false,
  };
}

/** A color the slide editor reported, or null when it is none. */
export function parseHexColor(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

/** A selection report from the slide editor, or null when it is malformed (or nothing is selected). */
export function parseElement(value: unknown): EditElement | null {
  if (!value || typeof value !== "object") return null;
  const { path, markup, name, added } = value as Record<string, unknown>;
  if (typeof path !== "string" || typeof markup !== "string" || typeof name !== "string") return null;
  return { path, markup, name, added: added === true };
}

export function parseSelection(value: unknown): EditSelection | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const color = parseHexColor;
  const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : null);
  if (typeof v.kind !== "string") return null;
  return {
    kind: v.kind,
    text: v.text === true,
    vector: v.vector === true,
    color: color(v.color),
    colorOther: v.colorOther === true,
    fillOther: v.fillOther === true,
    strokeOther: v.strokeOther === true,
    fontSize: num(v.fontSize),
    fontFamily: typeof v.fontFamily === "string" && v.fontFamily ? v.fontFamily : null,
    bold: v.bold === true,
    italic: v.italic === true,
    underline: v.underline === true,
    strike: v.strike === true,
    script: v.script === "sup" || v.script === "sub" ? v.script : null,
    letterSpacing: num(v.letterSpacing) ?? 0,
    lineHeight: num(v.lineHeight),
    align: v.align === "center" || v.align === "right" || v.align === "justify" ? v.align : "left",
    valign: v.valign === "top" || v.valign === "middle" || v.valign === "bottom" ? v.valign : null,
    list: v.list === "ul" || v.list === "ol" ? v.list : null,
    link: typeof v.link === "string" ? v.link : null,
    autofit: v.autofit === "shrink" || v.autofit === "grow" ? v.autofit : null,
    editing: v.editing === true,
    range: v.range === true,
    fill: color(v.fill),
    stroke: color(v.stroke),
    strokeWidth: num(v.strokeWidth) ?? 0,
    dash: v.dash === "dashed" || v.dash === "dotted" ? v.dash : "solid",
    line: parseLine(v.line),
    adjust: parseAdjust(v.adjust),
    opacity: num(v.opacity) ?? 1,
    shadow: num(v.shadow) ?? 0,
    radius: num(v.radius),
    clipped: v.clipped === true,
    image: v.image === true,
    fit: v.fit === "contain" || v.fit === "cover" || v.fit === "fill" ? v.fit : null,
    fitPosition: typeof v.fitPosition === "string" ? v.fitPosition : null,
    alt: typeof v.alt === "string" ? v.alt : null,
    flippable: v.flippable === true,
    flipX: v.flipX === true,
    flipY: v.flipY === true,
    group: v.group === true,
    locked: v.locked === true,
  };
}

/** A figure's proportions from the slide editor, or null when it has none. */
function parseAdjust(value: unknown): ShapeAdjust | null {
  if (!value || typeof value !== "object") return null;
  const { value: at, min, max, step, label } = value as Record<string, unknown>;
  const numbers = [at, min, max, step];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n)) || typeof label !== "string") return null;
  return { value: at as number, min: min as number, max: max as number, step: step as number, label };
}

/** A line's heads and route from the slide editor, or null when it is not a line. */
function parseLine(value: unknown): LineLook | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const head = (h: unknown) => (HEAD_KINDS.includes(h as HeadKind) ? (h as HeadKind) : null);
  return {
    start: head(v.start),
    end: head(v.end),
    route: LINE_ROUTES.includes(v.route as LineRoute) ? (v.route as LineRoute) : "straight",
  };
}

/**
 * What a restyle also makes the default for the next element of its kind: its look, not its
 * links, fit, or a line's heads and route (which its tool picks).
 */
export function defaultsFrom(changes: EditStyle): EditStyle {
  const {
    headStart: _headStart,
    headEnd: _headEnd,
    route: _route,
    adjust: _adjust,
    script: _script,
    autofit: _autofit,
    opacity: _opacity,
    shadow: _shadow,
    radius: _radius,
    fit: _fit,
    fitPosition: _fitPosition,
    alt: _alt,
    flipX: _flipX,
    flipY: _flipY,
    ...look
  } = changes;
  return look;
}

/** The font size typed into the toolbar, or null when it is not one. */
export function parseFontSize(text: string): number | null {
  const size = Math.round(Number(text.trim()));
  return Number.isFinite(size) && size >= 1 && size <= 999 ? size : null;
}

/** A font the toolbar offers: its name, and the CSS stack that uses it. */
export interface FontChoice {
  name: string;
  stack: string;
}

/** Fonts every Mac or PC has, for when the deck's own fonts are not enough. */
export const SYSTEM_FONTS: FontChoice[] = [
  { name: "System UI", stack: "system-ui, -apple-system, sans-serif" },
  { name: "Helvetica Neue", stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { name: "Arial", stack: "Arial, Helvetica, sans-serif" },
  { name: "Avenir Next", stack: '"Avenir Next", Avenir, "Segoe UI", sans-serif' },
  { name: "Futura", stack: 'Futura, "Century Gothic", sans-serif' },
  { name: "Gill Sans", stack: '"Gill Sans", "Gill Sans MT", Calibri, sans-serif' },
  { name: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  { name: "Trebuchet MS", stack: '"Trebuchet MS", sans-serif' },
  { name: "Georgia", stack: "Georgia, serif" },
  { name: "Times New Roman", stack: '"Times New Roman", Times, serif' },
  { name: "Palatino", stack: 'Palatino, "Palatino Linotype", serif' },
  { name: "Baskerville", stack: 'Baskerville, "Baskerville Old Face", serif' },
  { name: "Didot", stack: 'Didot, "Bodoni MT", serif' },
  { name: "Menlo", stack: 'Menlo, Consolas, "Courier New", monospace' },
  { name: "Courier New", stack: '"Courier New", Courier, monospace' },
];

/** The deck fonts the slide editor reported (see `deckFonts` in assets/editor/). */
export function parseFonts(value: unknown): FontChoice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((f) =>
    f && typeof f.name === "string" && typeof f.stack === "string" && f.name.trim() && f.stack.trim()
      ? [{ name: f.name.trim(), stack: f.stack.trim() }]
      : [],
  );
}

/** The toolbar's font list: the deck's fonts, then system fonts it does not already have. */
export function fontChoices(deck: FontChoice[]): { deck: FontChoice[]; system: FontChoice[] } {
  const names = new Set(deck.map((f) => f.name.toLowerCase()));
  return { deck, system: SYSTEM_FONTS.filter((f) => !names.has(f.name.toLowerCase())) };
}

/** A color from the deck's CSS variables. */
export interface DeckColor {
  name: string;
  value: string;
}

/** The deck colors the slide editor reported (see `deckColors` in assets/editor/). */
export function parseDeckColors(value: unknown): DeckColor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((c) => {
    const color = parseHexColor(c?.value);
    return color && typeof c.name === "string" ? [{ name: c.name, value: color }] : [];
  });
}

/** Where an image can sit in its box, row by row, as `object-position` values. */
export const FIT_POSITIONS = [
  "0% 0%",
  "50% 0%",
  "100% 0%",
  "0% 50%",
  "50% 50%",
  "100% 50%",
  "0% 100%",
  "50% 100%",
  "100% 100%",
] as const;

/** What each of `FIT_POSITIONS` is called, in the same order. */
export const FIT_POSITION_NAMES = [
  "Top left",
  "Top",
  "Top right",
  "Left",
  "Center",
  "Right",
  "Bottom left",
  "Bottom",
  "Bottom right",
] as const;

/** The file types the toolbar's image picker offers (see `IMAGE_EXTENSIONS` in drop.ts). */
export const IMAGE_FILE_TYPES = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"];

export const LINE_HEIGHTS = [0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2] as const;
export const LETTER_SPACINGS = [-2, -1, 0, 1, 2, 4, 8, 12] as const;

/**
 * What a link the user typed points at: a slide (`#id`), a web or mail address. A bare
 * domain gets `https://`, a bare email address `mailto:`. Null when it is empty or not a link
 * a slide may hold (like `javascript:`).
 */
export function normalizeHref(input: string): string | null {
  const href = input.trim();
  if (!href || href === "#") return null;
  if (href.startsWith("#")) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return /^(https?|mailto):/i.test(href) ? href : null;
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(href)) return `mailto:${href}`;
  if (/\s/.test(href)) return null;
  return `https://${href.replace(/^\/+/, "")}`;
}

/** The slide a link goes to, if it is a slide link. */
export function linkedSlide(href: string | null): string | null {
  return href?.startsWith("#") && href.length > 1 ? decodeURIComponent(href.slice(1)) : null;
}

/** The first family of a CSS font-family stack, unquoted: what the font list calls it. */
export function firstFamily(stack: string | null | undefined): string {
  return (stack ?? "")
    .split(",")[0]!
    .trim()
    .replace(/^["']|["']$/g, "");
}
