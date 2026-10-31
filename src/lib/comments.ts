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

/** A comment pinned at a point given in fractions of the slide. */
export interface SlideComment {
  id: string;
  text: string;
  x: number;
  y: number;
  /** Absent for a comment on the slide itself. */
  target?: CommentTarget | null;
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

/** A comment as the agent reads it; the text is quoted, so it stays on one line. */
export function commentLine(comment: PlacedComment, size: { width: number; height: number }, slides: number): string {
  const { target } = comment;
  const where = `slide \`${comment.slide}\` (${comment.slideNumber} of ${slides})`;
  const element = target
    ? `on <${target.tag}> at \`${commentSelector(comment.slide, target)}\`${target.label ? ` showing ${JSON.stringify(target.label)}` : ""}`
    : `on the slide as a whole, at x ${Math.round(comment.x * size.width)}, y ${Math.round(comment.y * size.height)}`;
  return `- ${where}, ${element}: ${JSON.stringify(comment.text)}`;
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
