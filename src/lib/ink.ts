/** Annotation tools (presenter ink, slide sketches): the pure parts, shared by the overlay and its tests. */

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

export const INK_COLORS = ["#ef4444", "#facc15", "#22c55e", "#3b82f6", "#ffffff"] as const;
export const DEFAULT_COLORS: Record<InkTool, string> = { pen: "#ef4444", highlighter: "#facc15" };

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

/** SVG path data through pixel positions. */
export function strokePath(points: readonly [number, number][]): string {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("");
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

/** Slide size in pixels; sketches are reported to the agent in these units. */
export const SLIDE_SIZE = { width: 1920, height: 1080 } as const;

/**
 * The area a set of strokes covers, in slide pixels, widened by the ink's own width and
 * clamped to the slide. Null when there are no points.
 */
export function inkBounds(
  strokes: readonly Stroke[],
): { left: number; top: number; right: number; bottom: number } | null {
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const stroke of strokes) {
    // Ink is drawn in screen pixels, so its width is only approximate in slide pixels.
    const pad = INK_STYLE[stroke.tool].width;
    for (const [x, y] of stroke.points) {
      left = Math.min(left, x * SLIDE_SIZE.width - pad);
      right = Math.max(right, x * SLIDE_SIZE.width + pad);
      top = Math.min(top, y * SLIDE_SIZE.height - pad);
      bottom = Math.max(bottom, y * SLIDE_SIZE.height + pad);
    }
  }
  if (left === Infinity) return null;
  const clamp = (n: number, max: number) => Math.round(Math.min(max, Math.max(0, n)));
  return {
    left: clamp(left, SLIDE_SIZE.width),
    top: clamp(top, SLIDE_SIZE.height),
    right: clamp(right, SLIDE_SIZE.width),
    bottom: clamp(bottom, SLIDE_SIZE.height),
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
 * Drops what has faded from laser trails. A point stays while the segment it starts is still
 * visible; trails with no visible segment left go. Returns `trails` itself if nothing changed.
 */
export function pruneTrails(trails: readonly TrailPoint[][], now: number): TrailPoint[][] {
  let changed = false;
  const kept: TrailPoint[][] = [];
  for (const trail of trails) {
    let start = 0;
    while (start < trail.length - 1 && now - trail[start + 1]!.t >= TRAIL_LIFE_MS) start++;
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

/**
 * The visible segments of a laser trail in pixels on a layer of the given size, each with how
 * much of it is left (its newer end's fade), oldest first.
 */
export function trailSegments(
  trail: readonly TrailPoint[],
  now: number,
  width: number,
  height: number,
): { x1: number; y1: number; x2: number; y2: number; fade: number }[] {
  const segments = [];
  for (let i = 1; i < trail.length; i++) {
    const [a, b] = [trail[i - 1]!, trail[i]!];
    const fade = trailFade(now - b.t);
    if (fade <= 0) continue;
    segments.push({ x1: px(a.x * width), y1: px(a.y * height), x2: px(b.x * width), y2: px(b.y * height), fade });
  }
  return segments;
}
