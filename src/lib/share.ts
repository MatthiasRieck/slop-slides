import type { Deck } from "./api";

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `next`, with every part of it that equals the same part of `before` replaced by that part: the
 * whole of `before` when nothing differs, and `next` itself when nothing is the same. For plain
 * data (what the backend sends), so that what did not change keeps its identity and whatever
 * reads it has nothing to do.
 */
export function keepEqual<T>(before: unknown, next: T): T {
  if (Object.is(before, next)) return next;
  if (Array.isArray(before) && Array.isArray(next)) {
    const kept = next.map((item, i) => keepEqual(before[i], item));
    if (before.length === next.length && kept.every((item, i) => item === before[i])) return before as T;
    return (kept.every((item, i) => item === next[i]) ? next : kept) as T;
  }
  if (isPlain(before) && isPlain(next)) {
    const keys = Object.keys(next);
    const kept: Record<string, unknown> = {};
    for (const key of keys) kept[key] = keepEqual(before[key], next[key]);
    const same = (other: Record<string, unknown>) => keys.every((key) => key in other && kept[key] === other[key]);
    if (Object.keys(before).length === keys.length && same(before)) return before as T;
    return (same(next) ? next : kept) as T;
  }
  return next;
}

/**
 * The deck `next` as the app keeps it after `before`: a slide that is as it was is the same
 * object as before wherever it now stands, and so are the list of slides, the sections and the
 * deck itself when nothing in them changed. A deck arrives from the backend as all new objects
 * after every save; this is what lets only the changed slide's views render.
 */
export function shareDeck(before: Deck | null, next: Deck): Deck {
  if (!before || before.id !== next.id) return next;
  const known = new Map(before.slides.map((slide) => [slide.id, slide]));
  const slides = next.slides.map((slide) => keepEqual(known.get(slide.id), slide));
  return keepEqual(before, { ...next, slides });
}
