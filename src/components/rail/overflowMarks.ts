import { useEffect } from "react";
import { create } from "zustand";

import type { Slide } from "../../lib/api";
import { useApp } from "../../store";
import { useEditorState } from "../stage/editorState";

/** A slide the slide editor found something running past or cut off on, and the slide's hash then. */
export interface OverflowMark {
  /** How many of its elements run past the slide or are cut off. */
  count: number;
  hash: string;
}

/** The marks, by slide. */
export type OverflowMarks = Record<string, OverflowMark>;

/**
 * Which slides overflow, as far as the app knows: only the slide editor measures a slide (see
 * src-tauri/assets/overflow.js), so a slide is known of once it was on the stage in Edit, and for
 * as long as it stays the slide the editor saw. The slide list marks these slides, so one that
 * overflows is still told when another is on the stage.
 */
export const useOverflowMarks = create<{ slides: OverflowMarks }>(() => ({ slides: {} }));

/**
 * `marks` after the editor said that `count` elements of `slide` overflow, the slide having
 * `hash`. `cleared` says the editor found some before and finds none now: with none from the
 * start it may just not have looked yet, which says nothing about the slide.
 */
export function withOverflow(
  marks: OverflowMarks,
  slide: string,
  hash: string | undefined,
  count: number,
  cleared: boolean,
): OverflowMarks {
  const mark = marks[slide];
  if (count > 0 && hash !== undefined) {
    return mark?.count === count && mark.hash === hash ? marks : { ...marks, [slide]: { count, hash } };
  }
  if (!mark || !cleared) return marks;
  const { [slide]: _, ...rest } = marks;
  return rest;
}

/**
 * `marks` for the deck's `slides` as they are now. A slide the editor saved since (`editSaved`
 * has the hash its save gave it) is still the slide it measured; one that changed any other way
 * (the agent, an undo, the HTML tab) or is gone is not, and nothing is known of it any more.
 */
export function overflowOf(marks: OverflowMarks, slides: Slide[], editSaved: Record<string, string>): OverflowMarks {
  const hashes = new Map(slides.map((slide) => [slide.id, slide.hash]));
  let next = marks;
  for (const [slide, mark] of Object.entries(marks)) {
    const hash = hashes.get(slide);
    if (hash === mark.hash) continue;
    if (next === marks) next = { ...marks };
    if (hash !== undefined && editSaved[slide] === hash) next[slide] = { ...mark, hash };
    else delete next[slide];
  }
  return next;
}

/** Keeps `useOverflowMarks` in step with what the slide editor reports and with the deck, while mounted. */
export function useOverflowWatch() {
  useEffect(() => {
    const put = (slides: OverflowMarks) => {
      if (slides !== useOverflowMarks.getState().slides) useOverflowMarks.setState({ slides });
    };
    const stopEditor = useEditorState.subscribe((next, before) => {
      const slide = next.slide;
      if (slide === null || (next.report.overflow === before.report.overflow && slide === before.slide)) return;
      const hash = useApp.getState().deck?.slides.find((s) => s.id === slide)?.hash;
      const cleared = before.slide === slide && before.report.overflow.length > 0;
      put(withOverflow(useOverflowMarks.getState().slides, slide, hash, next.report.overflow.length, cleared));
    });
    const stopDeck = useApp.subscribe((next, before) => {
      if (next.deck?.slides === before.deck?.slides) return;
      put(overflowOf(useOverflowMarks.getState().slides, next.deck?.slides ?? [], next.editSaved));
    });
    return () => {
      stopEditor();
      stopDeck();
    };
  }, []);
}
