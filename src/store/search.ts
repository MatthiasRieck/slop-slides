import { api, type FindMatch, type FindOptions, type ReplacedText } from "../lib/api";
import { editsSaved, queueEdit } from "./editQueue";
import { showErrorIn } from "./errors";
import { refreshHistory } from "./history";
import type { AppState, Slice } from "./types";

/** The search in View mode's toolbar (see components/FindReplace.tsx). */
export interface SlideSearch {
  query: string;
  options: FindOptions;
  /** What the query finds, in deck order; null until it has searched. */
  matches: FindMatch[] | null;
  /** The match stepped to, if it is still on the selected slide; see `activeMatch`. */
  active: number;
}

/** Finding text in the deck's slides, and replacing it. */
export interface SearchSlice {
  search: SlideSearch;

  setSearch: (changes: Partial<Pick<SlideSearch, "query" | "options">>) => void;
  setSearchMatches: (matches: FindMatch[]) => void;
  /** Goes to the next (1) or previous (-1) match, around the deck. */
  stepSearch: (delta: 1 | -1) => void;
  clearSearch: () => void;
  /**
   * Replaces `query` in the text of the deck's slides (or only of `slides`), after any slide
   * edits still being saved. Null when it failed (the error is shown).
   */
  replaceInDeck: (
    query: string,
    replacement: string,
    options: FindOptions,
    slides: string[] | null,
  ) => Promise<ReplacedText | null>;
  /** Undoes a replace, as long as it still is the deck's newest change. */
  undoReplace: (replaced: ReplacedText) => Promise<boolean>;
}

export const NO_SEARCH: SlideSearch = {
  query: "",
  options: { matchCase: false, wholeWord: false },
  matches: null,
  active: -1,
};

/** How the deck's history labels a find and replace (see src-tauri/src/lib.rs). */
const REPLACE_LABEL = "Replace text";

/** The match in focus, as an index into the matches: on the selected slide, or -1 if it has none. */
export function activeMatch(state: Pick<AppState, "search" | "selected">): number {
  const { matches, active } = state.search;
  if (!matches) return -1;
  if (matches[active]?.slide === state.selected) return active;
  return matches.findIndex((m) => m.slide === state.selected);
}

/** What the slide on the stage highlights; `active` counts the matches on that slide. */
export function searchHighlight(state: Pick<AppState, "search" | "selected">) {
  const { query, options, matches } = state.search;
  const first = matches?.findIndex((m) => m.slide === state.selected) ?? -1;
  return {
    query: query.trim() ? query : "",
    matchCase: options.matchCase,
    wholeWord: options.wholeWord,
    active: first < 0 ? -1 : activeMatch(state) - first,
  };
}

export const createSearchSlice: Slice<SearchSlice> = (set, get, app) => ({
  search: NO_SEARCH,

  setSearch: (changes) =>
    set((s) => {
      const search = { ...s.search, ...changes, active: -1 };
      return { search: search.query.trim() ? search : { ...search, matches: null } };
    }),

  setSearchMatches: (matches) => set((s) => ({ search: { ...s.search, matches } })),

  stepSearch: (delta) => {
    const state = get();
    const matches = state.search.matches;
    if (!matches?.length) return;
    const count = matches.length;
    const from = activeMatch(state);
    let next = (from + delta + count) % count;
    // The selected slide has none: the nearest one that way, past either end to the other.
    if (from < 0) {
      const here = state.deck?.slides.findIndex((s) => s.id === state.selected) ?? -1;
      next =
        delta > 0
          ? Math.max(
              0,
              matches.findIndex((m) => m.index > here),
            )
          : (matches.findLastIndex((m) => m.index < here) + count) % count;
    }
    const slide = matches[next]?.slide ?? null;
    set({ search: { ...state.search, active: next } });
    if (slide !== state.selected) state.select(slide);
  },

  clearSearch: () => set({ search: NO_SEARCH }),

  replaceInDeck: (query, replacement, options, slides) =>
    queueEdit(async () => {
      const { deck } = get();
      if (!deck) return null;
      try {
        const replaced = await api.replaceInDeck(deck.id, query, replacement, options, slides);
        if (get().deck?.id === deck.id) get().setDeck(replaced.deck);
        return replaced;
      } catch (error) {
        showErrorIn(app, error);
        return null;
      }
    }),

  undoReplace: async (replaced) => {
    await editsSaved();
    await refreshHistory(app);
    const { deck, history } = get();
    if (!deck || deck.id !== replaced.deck.id) return false;
    if (history?.undo?.source !== "edit" || history.undo.label !== REPLACE_LABEL) {
      showErrorIn(app, "The replace cannot be undone: the deck changed since.");
      return false;
    }
    await get().undo();
    return true;
  },
});
