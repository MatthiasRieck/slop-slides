// What the window's chrome (the sidebar's tabs, the mode tabs) shows of the selected slide. Its
// selectors run on every update of the store, a streamed word or a step of a scrub included, so
// they look the slide up only when the slides or the selection changed.
import type { Slide } from "../lib/api";
import { memoizeLast } from "../lib/memo";
import type { AppState } from "./types";

type Selection = Pick<AppState, "deck" | "selected">;

const slideOf = memoizeLast((slides: readonly Slide[] | undefined, id: string | null) =>
  slides?.find((slide) => slide.id === id),
);

/** Whether the selected slide is locked against changes. */
export const selectedSlideLocked = (state: Selection): boolean => !!slideOf(state.deck?.slides, state.selected)?.locked;

/** Whether the selected slide has narration. */
export const selectedSlideNarrated = (state: Selection): boolean =>
  !!slideOf(state.deck?.slides, state.selected)?.narration;
