import type { Deck } from "../../lib/api";

/**
 * The number the slide list gives the slide on screen: its place among all the deck's slides,
 * hidden ones too, so the number the bar, the presenter view and a typed number use is the one
 * the editor shows. `index` is its place among the slides shown, as the player reports it.
 */
export function slideNumber(deck: Deck, index: number): number {
  const shown = deck.slides.filter((s) => !s.hidden);
  const slide = shown[Math.min(shown.length - 1, Math.max(0, index))];
  return slide ? deck.slides.indexOf(slide) + 1 : 0;
}

/**
 * What a number typed in the show goes to, as the player takes it (src-tauri/assets/runtime.js,
 * `numbered`): the slide with that number in the slide list, a hidden one standing for the next
 * slide shown, a number past the end for the last slide. Said while it is typed.
 */
export function typedGoal(deck: Deck, typed: string): string {
  const total = deck.slides.length;
  const n = Math.min(total, Math.max(1, Number.parseInt(typed, 10) || 1));
  const shownAfter = deck.slides.slice(n - 1).find((s) => !s.hidden);
  const goal = shownAfter ?? deck.slides.findLast((s) => !s.hidden);
  const number = goal ? deck.slides.indexOf(goal) + 1 : n;
  if (Number.parseInt(typed, 10) > total) return `Go to the last slide, ${number}`;
  if (number !== n) return `Slide ${n} is hidden: go to ${number}`;
  return `Go to slide ${number}`;
}

/** The protocols a link on a slide may open outside the app with. */
const OPENED = new Set(["http:", "https:", "mailto:"]);

/**
 * The address a link pressed on a slide in the show opens in the system's browser or mail app:
 * a web or mail address only. Anything else (a file, the deck's own pages, a script) is null and
 * opens nothing.
 */
export function webLink(href: unknown): string | null {
  if (typeof href !== "string") return null;
  try {
    const url = new URL(href);
    return OPENED.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
