import { type RefObject, useEffect, useState } from "react";

import { scrollerOf, watchIntersection } from "../lib/viewObserver";

/**
 * Where an element is, seen from what its scroller shows:
 * - `visible`: in view;
 * - `near`: within a screenful of it, so it should be ready before it scrolls in;
 * - `held`: further off, or taking no space at all (a folded section, a closed panel): not worth
 *   loading anything for, but what it has it keeps, so that coming back to it shows it at once;
 * - `away`: so far off that what it holds is better let go.
 */
export type InView = "visible" | "near" | "held" | "away";

/** How far around the scroller's view an element counts as near it, and how far as not away. */
const NEAR_MARGIN = "100%";
const KEEP_MARGIN = "400%";

/**
 * Whether the element lies outside the scroller's view grown by the observer's margin. Told by
 * where its box is: one with no box (`display: none`) is nowhere, and one clipped to nothing where
 * it stands (a row folded while a section is dragged) is not far off, only out of sight.
 */
function outside(entry: IntersectionObserverEntry): boolean {
  const box = entry.boundingClientRect;
  const view = entry.rootBounds;
  if (!view || box.width <= 0 || box.height <= 0) return false;
  return box.bottom <= view.top || box.top >= view.bottom || box.right <= view.left || box.left >= view.right;
}

/** Showing at least in part; an element that only touches the edge, or is clipped to nothing, is not. */
const showing = (entry: IntersectionObserverEntry) => entry.isIntersecting && entry.intersectionRatio > 0;

/**
 * Follows where the element in `ref` is in its scroller (see {@link InView}). Without `watching`
 * it is taken to be in view and nothing is observed. Until the browser has said where it is, it
 * is `held`: nothing loads for an element that may turn out to be far away.
 */
export function useInView(ref: RefObject<Element | null>, watching: boolean): InView {
  const [place, setPlace] = useState<InView>("held");
  useEffect(() => {
    const element = ref.current;
    if (!watching || !element) return;
    const root = scrollerOf(element);
    let visible = false;
    let near = false;
    let away = false;
    const tell = () => setPlace(visible ? "visible" : near ? "near" : away ? "away" : "held");
    const stops = [
      watchIntersection(element, root, "0px", (entry) => {
        visible = showing(entry);
        tell();
      }),
      watchIntersection(element, root, NEAR_MARGIN, (entry) => {
        near = showing(entry);
        tell();
      }),
      watchIntersection(element, root, KEEP_MARGIN, (entry) => {
        away = outside(entry);
        tell();
      }),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [ref, watching]);
  return watching ? place : "visible";
}
