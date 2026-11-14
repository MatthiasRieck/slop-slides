// Laying out the composer's message input by hand: a textarea neither grows with its text nor
// follows text put into it while it has no focus. Each function here measures as little as it can,
// as every measurement makes the browser lay the input out on the spot.
import { MIN_INPUT_HEIGHT } from "./InputResizeHandle";

/** How tall the input grows by itself as its text gets longer, in pixels. */
const AUTO_MAX_HEIGHT = 240;

/** Gives `input` the height `chosen` by the user, or without one the height of its `text`. */
export function fitInput(input: HTMLTextAreaElement, text: string, chosen: number | null) {
  if (chosen !== null) {
    input.style.height = `${chosen}px`;
    return;
  }
  // An empty input stays at its smallest; measuring the placeholder while the panel is still
  // opening (and narrow) would otherwise make it start out tall.
  if (!text) {
    input.style.height = `${MIN_INPUT_HEIGHT}px`;
    return;
  }
  input.style.height = "auto";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, MIN_INPUT_HEIGHT), AUTO_MAX_HEIGHT)}px`;
}

/**
 * Scrolls `input` so that the text up to `caret` ends in view. Where that is, is the height of
 * the text up to it: at the end of the text that is the height of all of it, which is there to
 * read; anywhere else the input has to hold the text up to the caret for a moment to be measured.
 */
export function showCaret(input: HTMLTextAreaElement, caret: number) {
  const value = input.value;
  let bottom: number;
  if (caret >= value.length) {
    bottom = input.scrollHeight;
  } else {
    input.value = value.slice(0, caret);
    bottom = input.scrollHeight;
    input.value = value;
  }
  if (bottom > input.scrollTop + input.clientHeight || bottom < input.scrollTop) {
    input.scrollTop = Math.max(0, bottom - input.clientHeight);
  }
}
