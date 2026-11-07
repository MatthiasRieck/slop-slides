import { useSyncExternalStore } from "react";

/**
 * Where narration playing in this window is on the slide showing: `at` seconds since the slide
 * showed. The slide's page (src-tauri/assets/runtime.js) moves the animations that began with
 * the slide (those under `.slide.active`) there on a `slop:clock` message, so they keep with the
 * narration as a video export keeps them, even when the slide was on screen before it played.
 */
export interface SlideClock {
  slide: string;
  at: number;
}

let current: SlideClock | null = null;
const listeners = new Set<() => void>();

/** Sets the clock; null when no narration plays (paused too) and the slide's animations run on their own. */
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

/** The clock, rendering again as it changes. */
export function useSlideClock(): SlideClock | null {
  return useSyncExternalStore(onSlideClock, getSlideClock);
}

/** Tells the slide page in `frame` where the clock is, when it is on that page's `slide`. */
export function postSlideClock(frame: HTMLIFrameElement | null | undefined, slide: string | null) {
  const clock = current;
  if (!clock || (slide !== null && clock.slide !== slide)) return;
  frame?.contentWindow?.postMessage({ type: "slop:clock", slide: clock.slide, at: clock.at }, "*");
}
