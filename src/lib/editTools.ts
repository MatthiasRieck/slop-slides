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

/** A style for new elements, or the changes to apply to the selection. Null colors mean none. */
export interface EditStyle {
  color?: string | null;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
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
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  /** Null when its text cannot align vertically (it is not a flex box). */
  valign: VerticalAlign | null;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
}

/** Single-key shortcuts in edit mode. */
export const EDIT_TOOL_KEYS: Record<string, EditTool> = { v: "select", t: "text", r: "rect", o: "ellipse", d: "draw" };

export const DEFAULT_EDIT_STYLES: Record<ToolFamily, EditStyle> = {
  text: { color: "#111111", fontSize: 48, bold: false, italic: false, align: "left", valign: "top", fill: null, stroke: null, strokeWidth: 0 },
  shape: { color: "#ffffff", fontSize: 40, bold: false, italic: false, align: "center", valign: "middle", fill: "#3b82f6", stroke: null, strokeWidth: 0 },
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
  return { style: styles[family], text: family !== "draw", vector: family === "draw", valign: family !== "draw", selected: false };
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
    bold: v.bold === true,
    italic: v.italic === true,
    align: v.align === "center" || v.align === "right" ? v.align : "left",
    valign: v.valign === "top" || v.valign === "middle" || v.valign === "bottom" ? v.valign : null,
    fill: color(v.fill),
    stroke: color(v.stroke),
    strokeWidth: num(v.strokeWidth) ?? 0,
  };
}
