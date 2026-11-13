import { api, errorMessage, type FindMatch, type FindOptions, type ReplacedText } from "../lib/api";
import { queueEdit } from "./editQueue";
import { showErrorIn } from "./errors";
import { undoNewest } from "./history";
import type { AppState, Slice } from "./types";

/**
 * The search of the deck's slides, in View and in Edit (see components/FindReplace.tsx): View
 * has it in its ribbon, Edit as a bar over the stage, and what is searched for stays as the mode
 * changes between them.
 */
export interface SlideSearch {
  query: string;
  options: FindOptions;
  /** What the query finds, in deck order; null until it has searched, and when the search failed. */
  matches: FindMatch[] | null;
  /** The match stepped to, if it is still on the selected slide; see `activeMatch`. */
  active: number;
  /** Why the query could not be searched for; null when it could, or has not been yet. */
  failed: string | null;
  /** The search was asked for (⌘F): Edit shows its bar for it even with nothing typed yet. */
  open: boolean;
  /** The search field is to take the focus, once it is there to take it (see `findFocused`). */
  focusAsked: boolean;
}

/** Finding text in the deck's slides, and replacing it. */
export interface SearchSlice {
  search: SlideSearch;

  setSearch: (changes: Partial<Pick<SlideSearch, "query" | "options">>) => void;
  setSearchMatches: (matches: FindMatch[]) => void;
  /**
   * Searches the open deck for the query now, and keeps what it finds, or why it could not.
   * An answer that a newer search, another query or another deck has overtaken is dropped.
   */
  runSearch: () => Promise<void>;
  /**
   * Goes to the next (1) or previous (-1) match, around the deck. A match in a slide's notes
   * opens the sidebar's Notes tab, as the slide does not show it.
   */
  stepSearch: (delta: 1 | -1) => void;
  /** Ends the search: no query, nothing found, and Edit's bar away. */
  clearSearch: () => void;
  /** Brings the search up and asks its field to take the focus (⌘F). */
  openFind: () => void;
  /** The search field took the focus it was asked to take. */
  findFocused: () => void;
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
  /**
   * Replaces the match in focus (see `activeMatch`) with `replacement`, then goes to the match
   * after it. Null when there is none to replace (it is on a locked slide, say) or it failed.
   */
  replaceMatch: (replacement: string) => Promise<ReplacedText | null>;
  /** Undoes a replace, as long as it still is the deck's newest change. */
  undoReplace: (replaced: ReplacedText) => Promise<boolean>;
}

export const NO_SEARCH: SlideSearch = {
  query: "",
  options: { matchCase: false, wholeWord: false },
  matches: null,
  active: -1,
  failed: null,
  open: false,
  focusAsked: false,
};

/** Only the newest search counts; an earlier one can come back after it. */
let searchRun = 0;

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
      return { search: search.query.trim() ? search : { ...search, matches: null, failed: null } };
    }),

  setSearchMatches: (matches) => set((s) => ({ search: { ...s.search, matches, failed: null } })),

  runSearch: async () => {
    const { deck, search } = get();
    const { query, options } = search;
    const run = ++searchRun;
    if (!deck || !query.trim()) return;
    const current = () => {
      const now = get();
      return (
        run === searchRun && now.deck?.id === deck.id && now.search.query === query && now.search.options === options
      );
    };
    try {
      const found = await api.findInDeck(deck.id, query, options);
      if (!current()) return;
      if (Array.isArray(found)) get().setSearchMatches(found);
      else set((s) => ({ search: { ...s.search, matches: null, failed: "The search gave no result." } }));
    } catch (error) {
      if (current()) set((s) => ({ search: { ...s.search, matches: null, failed: errorMessage(error) } }));
    }
  },

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
    const match = matches[next];
    const slide = match?.slide ?? null;
    set({ search: { ...state.search, active: next } });
    if (slide !== state.selected) state.select(slide);
    // The slide does not show its notes: the sidebar does.
    if (match?.notes) state.setSidebarTab("notes");
  },

  clearSearch: () => set({ search: NO_SEARCH }),

  openFind: () => set((s) => ({ search: { ...s.search, open: true, focusAsked: true } })),

  findFocused: () => set((s) => (s.search.focusAsked ? { search: { ...s.search, focusAsked: false } } : {})),

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

  replaceMatch: async (replacement) => {
    const before = get();
    const { query, options, matches } = before.search;
    const at = activeMatch(before);
    const match = matches?.[at];
    if (!matches || !match || match.locked) return null;
    // The backend counts a slide's matches from its first one.
    const nth = at - matches.findIndex((m) => m.slide === match.slide);
    const replaced = await queueEdit(async () => {
      const { deck } = get();
      if (!deck) return null;
      try {
        const done = await api.replaceMatchInDeck(deck.id, query, replacement, options, match.slide, nth);
        if (get().deck?.id === deck.id) get().setDeck(done.deck);
        return done;
      } catch (error) {
        showErrorIn(app, error);
        return null;
      }
    });
    if (!replaced || replaced.count === 0) return replaced;
    await get().runSearch();
    const now = get().search.matches;
    if (!now?.length) return replaced;
    // The match is gone, so the one after it has its place; unless what replaced it matches too.
    const next = (now.length < matches.length ? at : at + 1) % now.length;
    set((s) => ({ search: { ...s.search, active: next } }));
    const slide = now[next]!.slide;
    if (slide !== get().selected) get().select(slide);
    if (now[next]!.notes) get().setSidebarTab("notes");
    return replaced;
  },

  undoReplace: async (replaced) => {
    if (get().deck?.id !== replaced.deck.id) return false;
    return undoNewest(app, REPLACE_LABEL, "replace");
  },
});
