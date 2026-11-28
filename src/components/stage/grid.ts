/** The space between the slides the stage shows side by side, in CSS pixels. */
export const GRID_GAP = 24;

/** How `n` slides are laid out side by side: in how many columns and rows, each slide `width` CSS pixels wide. */
export interface GridLayout {
  cols: number;
  rows: number;
  width: number;
}

/** A slide beside the one on the pasteboard, as the pasteboard is told of it (`slop:neighbors`). */
export interface Neighbor {
  slide: string;
  /** Its top left in the pasteboard preview's own pixels, where it shows at the slide's own size. */
  x: number;
  y: number;
  locked: boolean;
}

/** A box's width and height. */
interface Box {
  width: number;
  height: number;
}

/**
 * Lays `n` slides of one shape (`aspect`, width to height) out in a box of `w` by `h`, `gap` apart:
 * in the number of columns that shows them largest, fewer columns when two do the same. One slide
 * is as large as fits the box.
 */
export function gridLayout(n: number, w: number, h: number, aspect: number, gap = GRID_GAP): GridLayout {
  let best: GridLayout = { cols: 1, rows: Math.max(1, n), width: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const width = Math.max(0, Math.min((w - gap * (cols - 1)) / cols, ((h - gap * (rows - 1)) / rows) * aspect));
    if (cols === 1 || width > best.width) best = { cols, rows, width };
  }
  return best;
}

/**
 * Where the `n` slides of `layout` are: the box they take together, and each one's top left in
 * it, in their order, row by row. A last row with fewer slides than columns is centered.
 */
export function gridCells(n: number, layout: GridLayout, aspect: number, gap = GRID_GAP) {
  const { cols, rows, width } = layout;
  const height = aspect ? width / aspect : 0;
  const last = n - (rows - 1) * cols;
  const cells = Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? last : cols;
    return { x: ((cols - inRow) * (width + gap)) / 2 + (i % cols) * (width + gap), y: row * (height + gap) };
  });
  return {
    width: cols * width + gap * (cols - 1),
    height: rows * height + gap * (rows - 1),
    cells,
    cell: { width, height },
  };
}

/**
 * The pasteboard of a slide whose middle is at `center` in an `area`: the smallest box around that
 * middle that covers the whole area. The preview centers the slide in its pasteboard, so this is
 * what has the slide rest where it is laid out and the pasteboard reach every other slide.
 */
export function arenaAround(center: { x: number; y: number }, area: Box): Box {
  return {
    width: 2 * Math.max(center.x, area.width - center.x),
    height: 2 * Math.max(center.y, area.height - center.y),
  };
}

/**
 * Where a slide laid out `offset` CSS pixels from the one on the pasteboard has its top left in
 * the pasteboard preview's own pixels: the preview is `arena` large, shows its slide (`size`, in
 * its own pixels) in its middle, and is scaled by `scale` to fit.
 */
export function inPreview(offset: { x: number; y: number }, arena: Box, size: Box, scale: number) {
  return {
    x: Math.round((arena.width / scale - size.width) / 2 + offset.x / scale),
    y: Math.round((arena.height / scale - size.height) / 2 + offset.y / scale),
  };
}
