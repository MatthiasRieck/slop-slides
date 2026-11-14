/**
 * Comments on slides: the pure parts, shared by the stage, the composer and their tests. The
 * preview's pasteboard (src-tauri/assets/pasteboard.js) picks elements and finds them again;
 * the deck file keeps the comments (src-tauri/src/comments.rs).
 */

/** The element a comment is about. */
export interface CommentTarget {
  /** Child indexes from the slide down to the element, when the comment was made. */
  path: number[];
  tag: string;
  /** The start of its text (or an image's description). */
  label: string;
  /** Where on the element the pin sits, in fractions of its size. */
  at: [number, number];
}

/** How an area of the slide is outlined. */
export type AreaShape = "rect" | "ellipse" | "lasso";

/** An area of the slide a comment is about, in fractions of the slide. */
export interface CommentArea {
  shape: AreaShape;
  /** Two opposite corners for a rectangle or the box an ellipse fills; a lasso's corners. */
  points: [number, number][];
}

/** A comment pinned at a point given in fractions of the slide. */
export interface SlideComment {
  id: string;
  text: string;
  x: number;
  y: number;
  /** Absent for a comment on the slide itself. */
  target?: CommentTarget | null;
  /** The area outlined, for a comment on an area rather than an element. */
  area?: CommentArea | null;
  /**
   * The moment the comment is about, in seconds since the slide showed: where the timeline's
   * playhead held the slide when it was made. Absent for a comment on the slide whenever.
   */
  time?: number | null;
  /**
   * It went to the agent with a chat message. It stays on its slide, marked as sent, until the
   * user resolves it; changing what it says makes it one to send again. Absent until it is sent.
   */
  sent?: boolean;
}

/** Which comments go out with a message: the selected slide's, or the whole deck's. */
export type CommentScope = "slide" | "deck";

/** A comment with the slide it is on. */
export interface PlacedComment extends SlideComment {
  slide: string;
  /** The slide's position in the deck, from 1. */
  slideNumber: number;
}

/** Where a comment's pin goes on the slide, as the preview found it. */
export interface CommentSpot {
  x: number;
  y: number;
  /** False when the element it was on is gone. */
  found: boolean;
}

/** The comments of `slides`, in deck order; those of slides not in the deck are left out. */
export function placeComments(comments: Record<string, SlideComment[]>, slides: { id: string }[]): PlacedComment[] {
  return slides.flatMap((slide, index) =>
    (comments[slide.id] ?? []).map((comment) => ({ ...comment, slide: slide.id, slideNumber: index + 1 })),
  );
}

/** The selector of a comment's element, as of when it was made. */
export function commentSelector(slide: string, target: CommentTarget): string {
  return [`#${slide}`, ...target.path.map((index) => `:nth-child(${index + 1})`)].join(" > ");
}

const SHAPE_NAMES: Record<AreaShape, string> = {
  rect: "a rectangle",
  ellipse: "an ellipse",
  lasso: "a freehand outline",
};

/** A comment as the agent reads it; the text is quoted, so it stays on one line. */
export function commentLine(comment: PlacedComment, size: { width: number; height: number }, slides: number): string {
  const { target, area } = comment;
  const where = `slide \`${comment.slide}\` (${comment.slideNumber} of ${slides})`;
  const px = ([x, y]: [number, number]) => [Math.round(x * size.width), Math.round(y * size.height)] as const;
  let on: string;
  if (area) {
    const box = areaBounds(area);
    const [left, top] = px([box.left, box.top]);
    const [right, bottom] = px([box.right, box.bottom]);
    on = `on the area inside ${SHAPE_NAMES[area.shape]} at x ${left}–${right}, y ${top}–${bottom}`;
  } else if (target) {
    on = `on <${target.tag}> at \`${commentSelector(comment.slide, target)}\`${target.label ? ` showing ${JSON.stringify(target.label)}` : ""}`;
  } else {
    const [x, y] = px([comment.x, comment.y]);
    on = `on the slide as a whole, at x ${x}, y ${y}`;
  }
  const when = comment.time == null ? "" : `, ${commentTime(comment.time)} after the slide shows`;
  return `- ${where}, ${on}${when}: ${JSON.stringify(comment.text)}`;
}

/** A comment's moment as people and the agent read it, to a tenth of a second: `3.2 s`. */
export function commentTime(seconds: number): string {
  return `${(Math.round(seconds * 10) / 10).toFixed(1)} s`;
}

/** A comment on the timeline: when in the deck it is about. */
export interface TimedComment {
  id: string;
  /** The slide's position among those the timeline shows, from 0. */
  index: number;
  /** Its place among its slide's comments, from 1, as its pin is numbered. */
  number: number;
  /** Seconds from the start of the timeline. */
  at: number;
  text: string;
}

/**
 * The comments made at a moment, placed on a timeline whose `slides` show from `start` to `end`:
 * each at its moment into its slide, kept within the slide's time, in the order they come.
 */
export function timedComments(
  comments: Record<string, SlideComment[]>,
  slides: { id: string; start: number; end: number }[],
): TimedComment[] {
  return slides
    .flatMap((slide, index) =>
      (comments[slide.id] ?? []).flatMap((comment, i) =>
        comment.time == null
          ? []
          : [
              {
                id: comment.id,
                index,
                number: i + 1,
                at: Math.min(slide.end, slide.start + Math.max(0, comment.time)),
                text: comment.text,
              },
            ],
      ),
    )
    .sort((a, b) => a.at - b.at);
}

/** The box around `area`, in fractions of the slide. */
export function areaBounds(area: CommentArea): { left: number; top: number; right: number; bottom: number } {
  const xs = area.points.map(([x]) => x);
  const ys = area.points.map(([, y]) => y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/** How many corners stand in for an ellipse's curve. */
const ELLIPSE_STEPS = 48;

/** The corners of the polygon `area` encloses, in fractions of the slide. */
export function areaOutline(area: CommentArea): [number, number][] {
  if (area.shape === "lasso") return area.points;
  const { left, top, right, bottom } = areaBounds(area);
  if (area.shape === "rect") {
    return [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ];
  }
  const [cx, cy, rx, ry] = [(left + right) / 2, (top + bottom) / 2, (right - left) / 2, (bottom - top) / 2];
  return Array.from({ length: ELLIPSE_STEPS }, (_, i) => {
    const angle = (i / ELLIPSE_STEPS) * 2 * Math.PI;
    return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
  });
}

/** Smallest area worth a comment, as a fraction of the slide's width or height. */
const MIN_AREA_SIDE = 0.01;
/** Lasso points closer together than this (in fractions of the slide) are dropped. */
const LASSO_STEP = 0.004;

const round = (n: number) => Math.round(n * 10_000) / 10_000;
const clampFraction = (n: number) => round(Math.min(1, Math.max(0, n)));

/**
 * The area dragged out with `shape` through `points` (fractions of the slide, kept on it), or
 * null when it is too small to mean anything: a click, or a lasso drawn along a line.
 */
export function areaFromDrag(shape: AreaShape, points: [number, number][]): CommentArea | null {
  const kept = points.map(([x, y]) => [clampFraction(x), clampFraction(y)] as [number, number]);
  const first = kept[0];
  const last = kept.at(-1);
  if (!first || !last) return null;
  let area: CommentArea;
  if (shape === "lasso") {
    const thinned: [number, number][] = [];
    for (const p of kept) {
      const before = thinned.at(-1);
      if (!before || Math.hypot(p[0] - before[0], p[1] - before[1]) >= LASSO_STEP) thinned.push(p);
    }
    if (thinned.length < 3) return null;
    area = { shape, points: thinned };
  } else {
    area = { shape, points: [first, last] };
  }
  const box = areaBounds(area);
  return box.right - box.left >= MIN_AREA_SIDE && box.bottom - box.top >= MIN_AREA_SIDE ? area : null;
}

/** An SVG path of `area`'s outline, in a 1×1 view box. */
export function areaPath(area: CommentArea): string {
  const [first, ...rest] = areaOutline(area);
  if (!first) return "";
  return `M${first.join(" ")}${rest.map((p) => `L${p.join(" ")}`).join("")}Z`;
}

const isFraction = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A target the preview reported, if it has the right shape. */
export function parseTarget(value: unknown): CommentTarget | null {
  const target = value as Partial<CommentTarget> | null | undefined;
  const { path, tag, label, at } = target ?? {};
  const validPath = Array.isArray(path) && path.every((n) => Number.isInteger(n) && n >= 0);
  const validAt = Array.isArray(at) && at.length === 2 && at.every(isFraction);
  if (!validPath || typeof tag !== "string" || !validAt) return null;
  return { path, tag, label: typeof label === "string" ? label : "", at };
}

/** The spots the preview reported, by comment id, without any that make no sense. */
export function parseSpots(value: unknown): Record<string, CommentSpot> {
  if (!Array.isArray(value)) return {};
  const entries = value.flatMap((spot: Partial<CommentSpot & { id: string }> | null) =>
    spot && typeof spot.id === "string" && isFraction(spot.x) && isFraction(spot.y)
      ? [[spot.id, { x: spot.x, y: spot.y, found: spot.found !== false }] as const]
      : [],
  );
  return Object.fromEntries(entries);
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * What to screenshot for `area` on a slide shown at `slide` (screen pixels) of which `visible`
 * shows: the part of the window around the area, and its outline in fractions of that part.
 * Null when none of the area is in view.
 */
export function areaCapture(
  area: CommentArea,
  slide: Box,
  visible: Box,
): { rect: { x: number; y: number; width: number; height: number }; outline: [number, number][] } | null {
  const box = areaBounds(area);
  const x0 = Math.max(slide.left + box.left * slide.width, visible.left);
  const y0 = Math.max(slide.top + box.top * slide.height, visible.top);
  const x1 = Math.min(slide.left + box.right * slide.width, visible.left + visible.width);
  const y1 = Math.min(slide.top + box.bottom * slide.height, visible.top + visible.height);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const [width, height] = [x1 - x0, y1 - y0];
  const outline = areaOutline(area).map(
    ([x, y]) =>
      [round((slide.left + x * slide.width - x0) / width), round((slide.top + y * slide.height - y0) / height)] as [
        number,
        number,
      ],
  );
  return { rect: { x: x0, y: y0, width, height }, outline };
}
