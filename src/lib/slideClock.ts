/**
 * Where narration playing in this window is on the slide showing: `at` seconds since the slide
 * showed. The slide's page (src-tauri/assets/runtime.js) moves the animations that began with
 * the slide (those under `.slide.active`) there on a `slop:clock` message, so they keep with the
 * narration as a video export keeps them, even when the slide was on screen before it played. `paused`,
 * they stay at `at` rather than run on from it: the slide frozen at one moment, as the
 * timeline's playhead has it while it does not play.
 */
export interface SlideClock {
  slide: string;
  at: number;
  paused?: boolean;
}

let current: SlideClock | null = null;
const listeners = new Set<() => void>();

/** Sets the clock; null when no narration plays or is held at a moment, and the slide's animations run on their own. */
export function setSlideClock(clock: SlideClock | null) {
  if (clock === current) return;
  current = clock;
  for (const listener of listeners) listener();
}

export function getSlideClock(): SlideClock | null {
  return current;
}

/** Calls `listener` on every change of the clock; gives back how to stop. */
export function onSlideClock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Tells the slide page in `frame` where the clock is, when it is on that page's `slide`. With
 * `release`, a clock that is gone is told too, so that animations it froze run again.
 */
export function postSlideClock(frame: HTMLIFrameElement | null | undefined, slide: string | null, release = false) {
  const clock = current;
  if (!clock) {
    if (release) frame?.contentWindow?.postMessage({ type: "slop:clock", slide, at: null }, "*");
    return;
  }
  if (slide !== null && clock.slide !== slide) return;
  const paused = clock.paused ? { paused: true } : {};
  frame?.contentWindow?.postMessage({ type: "slop:clock", slide: clock.slide, at: clock.at, ...paused }, "*");
}
