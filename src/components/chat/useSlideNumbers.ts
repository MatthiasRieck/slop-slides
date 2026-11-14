import { useMemo } from "react";

import { memoizeLast } from "../../lib/memo";
import { slideNumbers } from "../../lib/slideNumbers";
import { useApp } from "../../store";
import type { AppState } from "../../store/types";

/** The number (from 1) of each slide of the open deck by its id; null without a deck. */
export type SlideNumbers = ReadonlyMap<string, number> | null;

/** The open deck's slide numbers: the same map for as long as its list of slides is the same. */
const numbersIn = (state: AppState): SlideNumbers => (state.deck ? slideNumbers(state.deck.slides) : null);

/**
 * What `derive` makes of the open deck's slide numbers, worked out again only when those
 * numbers are others (a slide added, removed or moved), not on every update of the store.
 *
 * The chat holds hundreds of rows that name slides by their numbers, and each asks the store on
 * every update, many a second while a reply comes in: asked about the same numbers, a row gives
 * its last answer at once. `derive` is the row's own, the same function for as long as what it
 * derives from is the same (see `useCallback`).
 */
export function useSlideNumbers<T>(derive: (numbers: SlideNumbers) => T): T {
  const select = useMemo(() => {
    const of = memoizeLast(derive);
    return (state: AppState) => of(numbersIn(state));
  }, [derive]);
  return useApp(select);
}
