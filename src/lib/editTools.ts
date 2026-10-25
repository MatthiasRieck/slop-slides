/**
 * The edit toolbar's tools and styles: the pure parts, shared by the stage and its tests. The
 * slide editor (src-tauri/assets/editor.js) applies them in the slide's preview.
 */

export type EditTool = "select" | "text" | "rect" | "rounded" | "ellipse" | "draw";

/** Tools whose new elements share style defaults. */
export type ToolFamily = "text" | "shape" | "draw";

export type TextAlign = "left" | "center" | "right";
export type VerticalAlign = "top" | "middle" | "bottom";
export type StackOrder = "front" | "forward" | "backward" | "back";
export type ListKind = "ul" | "ol";
export type Script = "sup" | "sub";
/** How a text box handles text that does not fit: shrink the text, or grow the box. */
export type Autofit = "shrink" | "grow";

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
}

/** What the slide editor reports about the selected element (see `describe` in editor.js). */
export interface EditSelection {
  /** `text`, `shape` or `drawing` for elements the user added; `media` or `element` otherwise. */
  kind: string;
  /** It holds text, so the text controls apply. */
  text: boolean;
  /** A drawing: fill and border are its line's fill and stroke. */
  vector: boolean;
  color: string | null;
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
}

/** Single-key shortcuts in edit mode. */
export const EDIT_TOOL_KEYS: Record<string, EditTool> = { v: "select", t: "text", r: "rect", o: "ellipse", d: "draw" };

export const DEFAULT_EDIT_STYLES: Record<ToolFamily, EditStyle> = {
  text: {
    color: "#111111",
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
    color: "#ffffff",
    fontSize: 40,
    bold: false,
    italic: false,
    align: "center",
    valign: "middle",
    fill: "#3b82f6",
    stroke: null,
    strokeWidth: 0,
  },
  draw: { fill: null, stroke: "#111111", strokeWidth: 6 },
};

export const EDIT_COLORS = [
  "#111111",
  "#6b7280",
  "#ffffff",
  "#ef4444",
  "#f97316",
  "#facc15",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
] as const;

export const BORDER_WIDTHS = [0, 1, 2, 4, 6, 8, 12, 16] as const;

const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 112, 128, 144, 160, 200, 240];

/** The next font size up (`step` 1) or down (-1) from `size`. */
export function stepFontSize(size: number, step: 1 | -1): number {
  if (step > 0) return FONT_SIZES.find((s) => s > size) ?? FONT_SIZES[FONT_SIZES.length - 1]!;
  return [...FONT_SIZES].reverse().find((s) => s < size) ?? FONT_SIZES[0]!;
}

export function familyOf(tool: EditTool): ToolFamily | null {
  if (tool === "text" || tool === "draw") return tool;
  return tool === "select" ? null : "shape";
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
      style: selection as EditStyle,
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

/** A selection report from the slide editor, or null when it is malformed (or nothing is selected). */
export function parseSelection(value: unknown): EditSelection | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const color = (c: unknown) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null);
  const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : null);
  if (typeof v.kind !== "string") return null;
  return {
    kind: v.kind,
    text: v.text === true,
    vector: v.vector === true,
    color: color(v.color),
    fontSize: num(v.fontSize),
    fontFamily: typeof v.fontFamily === "string" && v.fontFamily ? v.fontFamily : null,
    bold: v.bold === true,
    italic: v.italic === true,
    underline: v.underline === true,
    strike: v.strike === true,
    script: v.script === "sup" || v.script === "sub" ? v.script : null,
    letterSpacing: num(v.letterSpacing) ?? 0,
    lineHeight: num(v.lineHeight),
    align: v.align === "center" || v.align === "right" ? v.align : "left",
    valign: v.valign === "top" || v.valign === "middle" || v.valign === "bottom" ? v.valign : null,
    list: v.list === "ul" || v.list === "ol" ? v.list : null,
    link: typeof v.link === "string" ? v.link : null,
    autofit: v.autofit === "shrink" || v.autofit === "grow" ? v.autofit : null,
    editing: v.editing === true,
    range: v.range === true,
    fill: color(v.fill),
    stroke: color(v.stroke),
    strokeWidth: num(v.strokeWidth) ?? 0,
  };
}

/** What a restyle also makes the default for the next element of its kind: its look, not its links or fit. */
export function defaultsFrom(changes: EditStyle): EditStyle {
  const { script: _script, autofit: _autofit, ...look } = changes;
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

/** The deck fonts the slide editor reported (see `deckFonts` in editor.js). */
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
