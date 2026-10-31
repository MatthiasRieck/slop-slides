/**
 * Arranging the selection: the pure parts, shared by the arrange controls and their tests. The
 * slide editor (src-tauri/assets/editor.js) moves the elements in the slide's preview.
 */

export type AlignTo = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type DistributeAxis = "h" | "v";

/** Where the selection is, in slide pixels (see `geometry` in editor.js). */
export interface EditGeometry {
  /** How many elements are selected. */
  count: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees; null for several elements, which have no rotation of their own. */
  rotation: number | null;
}

export type GeometryField = "x" | "y" | "w" | "h" | "rotation";

/** What the arrange controls ask the slide editor to do. */
export type ArrangeMessage =
  | { type: "slop:edit-align"; to: AlignTo }
  | { type: "slop:edit-distribute"; axis: DistributeAxis }
  | ({ type: "slop:edit-geometry" } & Partial<Record<GeometryField, number>>);

/** A geometry report from the slide editor, or null when it is malformed (or nothing is selected). */
export function parseGeometry(value: unknown): EditGeometry | null {
  if (!value || typeof value !== "object") return null;
  const { count, x, y, w, h, rotation } = value as Record<string, unknown>;
  const numbers = [count, x, y, w, h];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return {
    count: count as number,
    x: x as number,
    y: y as number,
    w: w as number,
    h: h as number,
    rotation: typeof rotation === "number" && Number.isFinite(rotation) ? rotation : null,
  };
}

/** The number typed into a geometry field, or null when it is not one for that field. */
export function parseGeometryValue(field: GeometryField, text: string): number | null {
  const trimmed = text.trim();
  const value = Number(trimmed);
  if (!trimmed || !Number.isFinite(value)) return null;
  if (field === "w" || field === "h") return value >= 1 ? value : null;
  return value;
}
