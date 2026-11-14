import { useMemo, useState } from "react";

import type { Deck } from "../../lib/api";
import { railItems, sectionBlocks, sectionSizes, sectionStarts } from "../../lib/sections";

// What the slide list and the grid of all slides both work out from the deck.

/**
 * `keys` as the same list for as long as it names the same rows in the same order. dnd-kit tells
 * every row when its list of rows is another one, which a slide saved anew would otherwise be.
 */
export function useSameKeys(keys: string[]): string[] {
  const [kept, setKept] = useState(keys);
  const same = kept.length === keys.length && kept.every((key, i) => key === keys[i]);
  if (!same) setKept(keys);
  return same ? kept : keys;
}

/**
 * The rail's rows and what is looked up in them, worked out once for each change to the slides
 * or the sections. The deck keeps both as they are while they do not change (see `shareDeck`),
 * so a slide's comments or the review marks leave all of this alone.
 */
export function useRailRows(deck: Deck | null) {
  const slides = deck?.slides;
  const sections = deck?.sections;
  return useMemo(() => {
    const items = slides && sections ? railItems({ slides, sections }) : [];
    const blocks = sectionBlocks(items);
    return {
      items,
      blocks,
      itemKeys: items.map((item) => item.key),
      blockKeys: blocks.map((block) => block.key),
      starts: sectionStarts(blocks),
      sizes: sectionSizes(blocks),
      looseSlides: items.findIndex((item) => item.kind === "section"),
    };
  }, [slides, sections]);
}

/**
 * How many matches of the search each slide has, by slide; null while no search is on. Worked out
 * once for each set of matches.
 */
export function useSearchCounts(matches: { slide: string }[] | null | undefined): Map<string, number> | null {
  return useMemo(() => {
    if (!matches) return null;
    const counts = new Map<string, number>();
    for (const match of matches) counts.set(match.slide, (counts.get(match.slide) ?? 0) + 1);
    return counts;
  }, [matches]);
}

/** What the rail is headed with: how many slides, and how many of them are hidden. */
export function railTitle(slides: number, hidden: number): string {
  return hidden > 0 ? `Slides · ${slides} (${hidden} hidden)` : `Slides · ${slides}`;
}
