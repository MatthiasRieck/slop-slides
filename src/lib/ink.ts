/** Annotation tools (presenter ink, slide sketches): the pure parts, shared by the overlay and its tests. */

import { rgbChannels, SWATCHES } from "./palette";

export type Tool = "pointer" | "laser" | "pen" | "highlighter" | "eraser";
export type InkTool = "pen" | "highlighter";

/** A freehand line, in fractions of the screen so it survives window resizes. */
export interface Stroke {
  tool: InkTool;
  color: string;
  points: [number, number][];
}

/** Single-key shortcuts while presenting. Pressing the active tool's key puts it away. */
export const TOOL_KEYS: Record<string, Tool> = { l: "laser", p: "pen", h: "highlighter", e: "eraser" };

export const INK_COLORS = [SWATCHES.red, SWATCHES.yellow, SWATCHES.green, SWATCHES.blue, SWATCHES.white];
export const DEFAULT_COLORS: Record<InkTool, string> = { pen: SWATCHES.red, highlighter: SWATCHES.yellow };

/** What an ink color is called, for its swatch: "Red". A color that is none of the swatches is named by its value. */
export function inkColorName(color: string): string {
  const name = Object.entries(SWATCHES).find(([, value]) => value === color)?.[0];
  return name ? name[0]!.toUpperCase() + name.slice(1) : color;
}

/**
 * The ink of one slide as it was and as it was again: the states before each change (`past`,
 * oldest first) and those undone (`future`, the next to redo last). `at` is the strokes they
 * belong to: ink that changed some other way (sketches sent off, say) has no history.
 */
export interface InkHistory {
  past: readonly Stroke[][];
  future: readonly Stroke[][];
  at: readonly Stroke[];
}

/** How many changes of a slide's ink can be undone. */
export const INK_HISTORY = 100;

const historyOf = (history: InkHistory | undefined, strokes: readonly Stroke[]): InkHistory =>
  history && history.at === strokes ? history : { past: [], future: [], at: strokes };

/** The history once `before` became `after` by drawing, erasing or clearing: that can be undone, and nothing redone. */
export function inkChanged(history: InkHistory | undefined, before: Stroke[], after: Stroke[]): InkHistory {
  const { past } = historyOf(history, before);
  return { past: [...past, before].slice(-INK_HISTORY), future: [], at: after };
}

/** Whether a slide's `strokes` have a change to undo: one in their history, or else a stroke to drop. */
export function canUndoInk(history: InkHistory | undefined, strokes: readonly Stroke[]): boolean {
  return historyOf(history, strokes).past.length > 0 || strokes.length > 0;
}

/** Whether a slide's `strokes` have an undone change to redo. */
export function canRedoInk(history: InkHistory | undefined, strokes: readonly Stroke[]): boolean {
  return historyOf(history, strokes).future.length > 0;
}

/**
 * The strokes as they were before the last change, with the history after going back; null with
 * nothing to undo. Ink without a history (drawn before it was kept) loses its last stroke.
 */
export function undoInk(
  history: InkHistory | undefined,
  strokes: Stroke[],
): { strokes: Stroke[]; history: InkHistory } | null {
  const { past, future } = historyOf(history, strokes);
  const before = past.at(-1) ?? (strokes.length > 0 ? strokes.slice(0, -1) : null);
  if (!before) return null;
  return { strokes: before, history: { past: past.slice(0, -1), future: [...future, strokes], at: before } };
}

/** The strokes with the change undone last made again, and the history after; null with nothing to redo. */
export function redoInk(
  history: InkHistory | undefined,
  strokes: Stroke[],
): { strokes: Stroke[]; history: InkHistory } | null {
  const { past, future } = historyOf(history, strokes);
  const again = future.at(-1);
  if (!again) return null;
  return { strokes: again, history: { past: [...past, strokes], future: future.slice(0, -1), at: again } };
}

/** Stroke width in screen pixels, and opacity, per tool. */
export const INK_STYLE: Record<InkTool, { width: number; opacity: number }> = {
  pen: { width: 4, opacity: 1 },
  highlighter: { width: 28, opacity: 0.4 },
};

/** Screen pixel positions of a stroke's points, on a layer of the given size. */
export function toPixels(points: readonly [number, number][], width: number, height: number): [number, number][] {
  return points.map(([x, y]) => [px(x * width), px(y * height)]);
}

/** A stroke that never moved (a tap); drawn as a dot, since a zero-length path renders unreliably. */
export function isDot(points: readonly [number, number][]): boolean {
  const [first] = points;
  return !!first && points.every(([x, y]) => x === first[0] && y === first[1]);
}

/**
 * SVG path data for a smooth curve through pixel positions: the curve runs from the first point
 * to halfway to the second, then on from halfway to halfway, bent by each point between as a
 * quadratic Bézier control point, to the last point. Fast strokes, whose samples lie far apart,
 * so come out round instead of as a polygon, at one curve per point.
 */
export function strokePath(points: readonly [number, number][]): string {
  if (points.length < 3) return points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("");
  const halfway = (i: number) =>
    `${px((points[i]![0] + points[i + 1]![0]) / 2)} ${px((points[i]![1] + points[i + 1]![1]) / 2)}`;
  const [[x0, y0], [xn, yn]] = [points[0]!, points[points.length - 1]!];
  let d = `M${x0} ${y0}L${halfway(0)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i]!;
    d += `Q${x} ${y} ${i === points.length - 2 ? `${xn} ${yn}` : halfway(i)}`;
  }
  return d;
}

/**
 * A stroke's path as it is drawn: the pixel positions so far, the start of the path data that no
 * later point changes, and the path data (`d`) for all of them, which is `strokePath` of `points`.
 */
export interface GrowingPath {
  points: [number, number][];
  settled: string;
  d: string;
}

/** The path of a stroke with no points yet. */
export function growingPath(): GrowingPath {
  return { points: [], settled: "", d: "" };
}

/**
 * Adds pixel positions to the stroke `path` is of, in place, and gives its path data. Only the
 * last curve of a stroke depends on its last point (see `strokePath`), so each point costs the
 * same however long the stroke has become, where drawing the whole path again costs its length.
 */
export function appendStrokePath(path: GrowingPath, added: readonly [number, number][]): string {
  const { points } = path;
  const halfway = (i: number) =>
    `${px((points[i]![0] + points[i + 1]![0]) / 2)} ${px((points[i]![1] + points[i + 1]![1]) / 2)}`;
  for (const point of added) {
    points.push(point);
    const count = points.length;
    // With a point after it, the curve around the point before last ends halfway between the two, for good.
    if (count === 3) path.settled = `M${points[0]![0]} ${points[0]![1]}L${halfway(0)}`;
    else if (count > 3) path.settled += `Q${points[count - 3]![0]} ${points[count - 3]![1]} ${halfway(count - 3)}`;
  }
  const count = points.length;
  if (count < 3) path.d = strokePath(points);
  else {
    const [[x, y], [xn, yn]] = [points[count - 2]!, points[count - 1]!];
    path.d = `${path.settled}Q${x} ${y} ${xn} ${yn}`;
  }
  return path.d;
}

/**
 * Puts an ink layer where a zoom (translate by `x`, `y` CSS px, then scale by `k` around the
 * top-left corner) has its container. It is laid out at the zoomed size rather than CSS-scaled,
 * since a scaled layer is painted at its own size and then stretched, blurring the ink.
 */
export function zoomBox(x: number, y: number, k: number): { left: string; top: string; width: string; height: string } {
  return { left: `${x}px`, top: `${y}px`, width: `${k * 100}%`, height: `${k * 100}%` };
}

/** Position of a pointer event inside `rect`, as fractions of its size. */
export function toFraction(clientX: number, clientY: number, rect: DOMRect): [number, number] {
  const x = (clientX - rect.left) / (rect.width || 1);
  const y = (clientY - rect.top) / (rect.height || 1);
  return [round(x), round(y)];
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;
const px = (n: number) => Math.round(n * 10) / 10;

/** The default slide size in pixels; sketches are reported to the agent in slide pixels. */
export const SLIDE_SIZE = { width: 1920, height: 1080 } as const;

/**
 * The area a set of strokes covers, in slide pixels (of a `size` canvas), widened by the ink's
 * own width and clamped to the slide. Null when there are no points.
 */
export function inkBounds(
  strokes: readonly Stroke[],
  size: { width: number; height: number } = SLIDE_SIZE,
): { left: number; top: number; right: number; bottom: number } | null {
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const stroke of strokes) {
    // Ink is drawn in screen pixels, so its width is only approximate in slide pixels.
    const pad = INK_STYLE[stroke.tool].width;
    for (const [x, y] of stroke.points) {
      left = Math.min(left, x * size.width - pad);
      right = Math.max(right, x * size.width + pad);
      top = Math.min(top, y * size.height - pad);
      bottom = Math.max(bottom, y * size.height + pad);
    }
  }
  if (left === Infinity) return null;
  const clamp = (n: number, max: number) => Math.round(Math.min(max, Math.max(0, n)));
  return {
    left: clamp(left, size.width),
    top: clamp(top, size.height),
    right: clamp(right, size.width),
    bottom: clamp(bottom, size.height),
  };
}

/** A point of a laser trail, in fractions of the layer, with when it was drawn (ms). */
export interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

/** How long a laser trail stays fully visible, then how long it takes to fade away (ms). */
export const TRAIL_HOLD_MS = 1000;
export const TRAIL_FADE_MS = 700;
const TRAIL_LIFE_MS = TRAIL_HOLD_MS + TRAIL_FADE_MS;

/** How much of a trail drawn `age` ms ago is left: 1 while held, falling to 0 as it fades. */
export function trailFade(age: number): number {
  if (age <= TRAIL_HOLD_MS) return 1;
  return Math.max(0, 1 - (age - TRAIL_HOLD_MS) / TRAIL_FADE_MS);
}

/**
 * Drops what has faded from laser trails. A point stays while a piece of the curve it shapes
 * (see `trailSegments`) is still visible, so dropping it never changes how the rest is drawn;
 * trails with no visible piece left go. Returns `trails` itself if nothing changed.
 */
export function pruneTrails(trails: readonly TrailPoint[][], now: number): TrailPoint[][] {
  let changed = false;
  const kept: TrailPoint[][] = [];
  for (const trail of trails) {
    let start = 0;
    while (start < trail.length - 2 && now - trail[start + 2]!.t >= TRAIL_LIFE_MS) start++;
    const alive = trail.length > 0 && now - trail[trail.length - 1]!.t < TRAIL_LIFE_MS;
    if (!alive) {
      changed = true;
    } else if (start > 0) {
      changed = true;
      kept.push(trail.slice(start));
    } else {
      kept.push(trail);
    }
  }
  return changed ? kept : (trails as TrailPoint[][]);
}

/** A piece of a laser trail: a quadratic Bézier from (x1, y1) bent by (cx, cy) to (x2, y2). */
export interface TrailSegment {
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  x2: number;
  y2: number;
  fade: number;
}

/**
 * The visible pieces of a laser trail in pixels on a layer of the given size, oldest first:
 * the same smooth curve `strokePath` draws, cut where its curves meet so each piece can thin
 * on its own, by how much is left of the newer point after it.
 */
export function trailSegments(
  trail: readonly TrailPoint[],
  now: number,
  width: number,
  height: number,
): TrailSegment[] {
  const at = (i: number) => [trail[i]!.x * width, trail[i]!.y * height] as const;
  const mid = (i: number) => {
    const [[ax, ay], [bx, by]] = [at(i - 1), at(i)];
    return [(ax + bx) / 2, (ay + by) / 2] as const;
  };
  const segments: TrailSegment[] = [];
  const last = trail.length - 1;
  for (let i = 0; i < last; i++) {
    // Piece i runs around point i: from the trail's start or halfway from the point before,
    // to halfway to the next point or the trail's end.
    const fade = trailFade(now - trail[Math.min(i + 1, last)]!.t);
    if (fade <= 0) continue;
    const [x1, y1] = i === 0 ? at(0) : mid(i);
    const [cx, cy] = at(i);
    const [x2, y2] = i + 1 === last ? at(last) : mid(i + 1);
    segments.push({ x1: px(x1), y1: px(y1), cx: px(cx), cy: px(cy), x2: px(x2), y2: px(y2), fade });
  }
  return segments;
}

/** Size of the laser dot, and so the width of a fresh laser trail, in screen pixels. */
export const LASER_SIZE = 16;
export const LASER_RGB = rgbChannels(SWATCHES.red);
/** The laser's red glow, as an inner and an outer halo: blur, spread and opacity. */
export const LASER_GLOW = [
  { blur: 8, spread: 4, opacity: 0.7 },
  { blur: 24, spread: 10, opacity: 0.35 },
] as const;

/**
 * The part of a layer at `rect` (on screen, in CSS px) that lies inside a viewport of the given
 * size, in the layer's own pixels and widened to whole ones. A zoomed layer can be many times
 * the screen's size; a canvas over only this part keeps painting it as cheap as unzoomed.
 */
export function visibleArea(
  rect: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.floor(-rect.left));
  const y = Math.max(0, Math.floor(-rect.top));
  const right = Math.min(rect.width, Math.ceil(viewport.width - rect.left));
  const bottom = Math.min(rect.height, Math.ceil(viewport.height - rect.top));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** How far a laser trail's glow reaches past the middle of its line, in CSS px. */
export const TRAIL_GLOW = LASER_SIZE / 2 + Math.max(...LASER_GLOW.map((g) => g.blur + g.spread));

/** The steps a trail's canvas grows in (CSS px), so that it is not made anew with every move of the laser. */
const TRAIL_STEP = 64;

/**
 * The part of a layer `width` by `height` CSS px that laser trails and their glow reach, in the
 * layer's pixels, widened to whole steps and kept inside the layer; null with no trail. A canvas
 * this size is all that painting them takes, where one the size of the layer has every pixel
 * of it blurred for each halo, each frame.
 */
export function trailBounds(
  trails: readonly TrailPoint[][],
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const trail of trails) {
    for (const point of trail) {
      left = Math.min(left, point.x * width);
      right = Math.max(right, point.x * width);
      top = Math.min(top, point.y * height);
      bottom = Math.max(bottom, point.y * height);
    }
  }
  if (left === Infinity) return null;
  const down = (n: number) => Math.max(0, Math.floor((n - TRAIL_GLOW) / TRAIL_STEP) * TRAIL_STEP);
  const up = (n: number, max: number) =>
    Math.min(Math.ceil(max), Math.ceil((n + TRAIL_GLOW) / TRAIL_STEP) * TRAIL_STEP);
  const [x, y] = [down(left), down(top)];
  return { x, y, width: Math.max(0, up(right, width) - x), height: Math.max(0, up(bottom, height) - y) };
}

/** The part of `area` that lies inside `within`, both in the same pixels; empty when they do not meet. */
export function clipArea(
  area: { x: number; y: number; width: number; height: number },
  within: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(area.x, within.x);
  const y = Math.max(area.y, within.y);
  const right = Math.min(area.x + area.width, within.x + within.width);
  const bottom = Math.min(area.y + area.height, within.y + within.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** Whether any piece of laser trails is thinning away at `now`: while none is, they look the same each frame. */
export function trailsFading(trails: readonly TrailPoint[][], now: number): boolean {
  // A trail's oldest piece goes by its second point (see `trailSegments`).
  return trails.some((trail) => trail.length > 0 && now - trail[Math.min(1, trail.length - 1)]!.t > TRAIL_HOLD_MS);
}

/** The 2D canvas calls the trail painter makes, so tests can stand in for a canvas. */
type Canvas2D = Pick<
  CanvasRenderingContext2D,
  | "setTransform"
  | "clearRect"
  | "beginPath"
  | "moveTo"
  | "quadraticCurveTo"
  | "stroke"
  | "drawImage"
  | "lineWidth"
  | "lineCap"
  | "strokeStyle"
  | "shadowBlur"
  | "shadowColor"
> & { canvas: { width: number; height: number } };

/**
 * Paints laser trails, on a layer `width` by `height` CSS px, onto `target`, a canvas `scale`
 * device pixels per CSS pixel that covers the layer from `origin` on. The trails
 * are first drawn solid onto `core`, a scratch canvas of the same size, which is then copied
 * over once per halo with a shadow, so the glow is even along a trail instead of piling up
 * where its segments overlap.
 */
export function paintTrails(
  target: Canvas2D,
  core: Canvas2D,
  trails: readonly TrailPoint[][],
  now: number,
  width: number,
  height: number,
  scale: number,
  origin: { x: number; y: number } = { x: 0, y: 0 },
) {
  for (const ctx of [target, core]) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
  core.setTransform(scale, 0, 0, scale, -origin.x * scale, -origin.y * scale);
  core.strokeStyle = `rgb(${LASER_RGB})`;
  core.lineCap = "round";
  for (const trail of trails) {
    for (const { x1, y1, cx, cy, x2, y2, fade } of trailSegments(trail, now, width, height)) {
      core.lineWidth = LASER_SIZE * fade;
      core.beginPath();
      core.moveTo(x1, y1);
      core.quadraticCurveTo(cx, cy, x2, y2);
      core.stroke();
    }
  }
  // Canvas shadows have no spread, so the halos blur further instead.
  for (const { blur, spread, opacity } of [...LASER_GLOW].reverse()) {
    target.shadowColor = `rgb(${LASER_RGB} / ${opacity})`;
    target.shadowBlur = (blur + spread) * scale;
    target.drawImage(core.canvas as CanvasImageSource, 0, 0);
  }
  target.shadowBlur = 0;
  target.shadowColor = "transparent";
  target.drawImage(core.canvas as CanvasImageSource, 0, 0);
}
