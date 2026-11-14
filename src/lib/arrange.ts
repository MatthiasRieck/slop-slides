/**
 * Arranging the selection: the pure parts, shared by the arrange controls and their tests. The
 * slide editor (src-tauri/assets/editor/) moves the elements in the slide's preview.
 */

import type { EditStyle } from "./editTools";

export type AlignTo = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type DistributeAxis = "h" | "v";
/** What aligning lines the selection up with: the slide (each element on its own), or the selection's bounds. */
export type AlignTarget = "slide" | "selection";
/** The size matching gives the other selected elements from the primary one. */
export type MatchAxis = "w" | "h";

/** Where the selection is, in slide pixels (see `geometry` in assets/editor/). */
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

/** Degrees one press of a 3D rotate button turns the selection. */
export const TILT_STEP = 5;

/** One of the slide's layers, as the slide editor lists them, the top-most first (see `layers` in assets/editor/). */
export interface EditLayer {
  /** Where it is in the slide, to select it by. */
  path: number[];
  name: string;
  group: boolean;
  /** Locked itself. */
  locked: boolean;
  /** In something locked, so it cannot be picked either. */
  held: boolean;
  selected: boolean;
  /** How many groups in it is. */
  depth: number;
}

/** The layer list from the slide editor; malformed rows are dropped. */
export function parseLayers(value: unknown): EditLayer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const { path, name, group, locked, held, selected, depth } = row as Record<string, unknown>;
    const steps = Array.isArray(path) && path.every((n) => Number.isInteger(n) && (n as number) >= 0);
    if (!steps || typeof name !== "string") return [];
    return [
      {
        path: path as number[],
        name,
        group: group === true,
        locked: locked === true,
        held: held === true,
        selected: selected === true,
        depth: typeof depth === "number" && Number.isInteger(depth) && depth >= 0 ? depth : 0,
      },
    ];
  });
}

/** What the edit toolbar's controls ask the slide editor to do, beyond restyling the selection for good. */
export type ArrangeMessage =
  /** Shows a restyle while a slider is dragged, without saving it; `slop:edit-style-cancel` takes it back. */
  | { type: "slop:edit-style"; style: EditStyle; preview: true }
  | { type: "slop:edit-style-cancel" }
  /** Mirrors every selected element that can flip, each in its own place. */
  | { type: "slop:edit-flip"; axis: "x" | "y" }
  | { type: "slop:edit-duplicate" }
  | { type: "slop:edit-clear-formatting" }
  /** Dragging and resizing snap to the guides, or not. */
  | { type: "slop:edit-snap"; on: boolean }
  | { type: "slop:edit-align"; to: AlignTo; target: AlignTarget }
  | { type: "slop:edit-match"; axis: MatchAxis }
  | { type: "slop:edit-distribute"; axis: DistributeAxis }
  | ({ type: "slop:edit-geometry" } & Partial<Record<GeometryField, number>>)
  | { type: "slop:edit-tilt"; x: number; y: number }
  | { type: "slop:edit-tilt"; reset: true }
  | { type: "slop:edit-group" }
  | { type: "slop:edit-ungroup" }
  /** Locks the selection, or with a path, that layer. */
  | { type: "slop:edit-lock"; locked: boolean; path?: number[] }
  /** Selects a layer from the Layers panel. */
  | { type: "slop:edit-select"; path: number[] }
  /** Moves a layer past the next one up or down, whether or not they overlap. */
  | { type: "slop:edit-order"; to: "forward" | "backward"; path: number[]; any: true };

/** The rotation a quarter turn clockwise (`step` 1) or counterclockwise (-1) from `rotation` gives, within ±180°. */
export function quarterTurn(rotation: number, step: 1 | -1): number {
  const turned = (((Math.round(rotation) + step * 90) % 360) + 360) % 360;
  return turned > 180 ? turned - 360 : turned;
}

/**
 * The value an arrow key takes a typed number to: one up or down, ten with Shift, from the
 * whole number nearest to it.
 */
export function stepNumber(value: number, direction: 1 | -1, large: boolean): number {
  return Math.round(value) + direction * (large ? 10 : 1);
}

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
