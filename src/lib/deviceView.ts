/** The device view (components/DeviceDeck.tsx): the pure parts, shared by the view and its tests. */

import type { Deck } from "./api";

export interface Size {
  width: number;
  height: number;
}

/** Horizontal drag (CSS px) that moves to the next or previous slide. */
export const SWIPE_DISTANCE = 50;

/** The largest 16:9 slide that fits `area`. */
export function fitSlide(area: Size): Size {
  const width = Math.max(0, Math.min(area.width, (area.height * 16) / 9));
  return { width, height: (width * 9) / 16 };
}

/** -1 / 1 for a drag far and flat enough to change slides, else 0. */
export function swipeDirection(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < 2 * Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

/**
 * Version key of the device's deck page: changes with any slide's markup, the shared styles and
 * the assets. A short hash, as it goes into the page's URL.
 */
export function deckPageVersion(deck: Pick<Deck, "shellHash" | "slides">, assetsRev: number): string {
  const key = [deck.shellHash, assetsRev, ...deck.slides.map((s) => `${s.id}:${s.hash}`)].join("|");
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = (Math.imul(hash, 33) ^ key.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}
