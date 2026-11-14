// The grid of all slides (see ../components/SlideOverview.tsx): how large its thumbnails are, and
// where the arrow keys go in it.
import { loadJson, saveJson } from "./storage";

/** How wide a thumbnail of the grid is at least, in pixels: the range the size slider covers. */
export const GRID_SIZES = { min: 120, max: 420, step: 20, initial: 220 };

const GRID_SIZE_KEY = "slopslide.overviewSize";

/** `size` as a width the slider can stand on. */
export function gridSize(size: unknown): number {
  if (typeof size !== "number" || !Number.isFinite(size)) return GRID_SIZES.initial;
  const stepped = Math.round(size / GRID_SIZES.step) * GRID_SIZES.step;
  return Math.min(GRID_SIZES.max, Math.max(GRID_SIZES.min, stepped));
}

/** The thumbnail size the grid was left at. */
export const loadGridSize = () => loadJson(GRID_SIZE_KEY, GRID_SIZES.initial, gridSize);

/** Remembers the grid's thumbnail size. Losing it only brings the usual size back. */
export function saveGridSize(size: number) {
  try {
    saveJson(GRID_SIZE_KEY, size);
  } catch {
    // Only the remembered size is lost.
  }
}

/** A thumbnail of the grid and where its box is. */
export interface GridCell {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The cell one row up (-1) or down (1) from the cell `from`: of the nearest row that way, the one
 * closest to it across. Rows need not be full, as sections start new ones. Null when there is no
 * row that way, or no such cell.
 */
export function gridStep(cells: GridCell[], from: string, delta: -1 | 1): string | null {
  const here = cells.find((cell) => cell.id === from);
  if (!here) return null;
  // A cell is on another row when it starts more than half a cell higher or lower.
  const beyond = cells.filter((cell) => (cell.top - here.top) * delta > here.height / 2);
  if (beyond.length === 0) return null;
  const row = beyond.reduce(
    (nearest, cell) => (Math.abs(cell.top - here.top) < Math.abs(nearest - here.top) ? cell.top : nearest),
    beyond[0]!.top,
  );
  const middle = (cell: GridCell) => cell.left + cell.width / 2;
  const across = (cell: GridCell) => Math.abs(middle(cell) - middle(here));
  return beyond
    .filter((cell) => Math.abs(cell.top - row) <= here.height / 2)
    .reduce((nearest, cell) => (across(cell) < across(nearest) ? cell : nearest)).id;
}

/**
 * Where the rows being dragged would land when dropped on row `over`: before it or after it, as
 * `dropRows` (./sections.ts) places them. Null when they would stay where they are.
 */
export function dropSide(keys: string[], moved: string[], active: string, over: string): "before" | "after" | null {
  if (moved.includes(over) || !keys.includes(over)) return null;
  return keys.indexOf(active) < keys.indexOf(over) ? "after" : "before";
}
