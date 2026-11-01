import { create } from "zustand";

import { api, type Change, type DeckChanges, errorMessage, type SlideChange } from "./lib/api";
import { DEFAULT_DIVIDER, type Divider } from "./lib/compare";
import { useApp } from "./store";

/**
 * Git mode (see components/ChangesView.tsx): what changed in the open deck since the last commit,
 * the row picked in the list (which, unlike the app's selected slide, can be a removed slide),
 * and the divider of the comparison, which stays put going from slide to slide.
 */
interface ChangesState {
  /** The changes of `deck`; null until they have been read. */
  changes: DeckChanges | null;
  deck: string | null;
  /** The deck last found in a git repository, which is what offers Git mode. */
  repository: string | null;
  picked: string | null;
  /** Leaves the slides that did not change out of the list. */
  onlyChanges: boolean;
  divider: Divider;
  /** Finds out whether `deck` is in a git repository. */
  checkRepository: (deck: string) => Promise<void>;
  /** Reads the changes of `deck` again. */
  refresh: (deck: string) => Promise<void>;
  /** Picks a row of the list; a slide still in the deck becomes the app's selected slide too. */
  pick: (key: string) => void;
  /** Picks the next (1) or previous (-1) row of the list. */
  step: (by: 1 | -1) => void;
  setOnlyChanges: (onlyChanges: boolean) => void;
  /** Stages a change, leaving the deck on disk as it is. */
  stage: (deck: string, change: Change) => Promise<void>;
  unstage: (deck: string, change: Change) => Promise<void>;
  /** Puts a change back as it was committed; the slide list's undo brings it back. */
  restore: (deck: string, change: Change) => Promise<void>;
  stageAll: (deck: string) => Promise<void>;
  unstageAll: (deck: string) => Promise<void>;
  /** Commits what is staged; false when that failed. */
  commit: (deck: string, message: string) => Promise<boolean>;
  setDivider: (changes: Partial<Divider>) => void;
  resetDivider: () => void;
}

/** The rows the list shows. */
export function visibleRows({ changes, onlyChanges }: Pick<ChangesState, "changes" | "onlyChanges">): SlideChange[] {
  const rows = changes?.slides ?? [];
  return onlyChanges ? rows.filter(isChange) : rows;
}

const isChange = (row: SlideChange) => row.status !== "unchanged";

/** Only the last refresh counts: an earlier one can come back after it. */
let lastRefresh = 0;

/** Stays on the picked row, or else starts at the selected slide, if it changed, or the first change. */
function keepPicked(changes: DeckChanges, picked: string | null, selected: string | null) {
  const { slides } = changes;
  if (slides.some((row) => row.key === picked)) return picked;
  const start =
    slides.find((row) => row.id === selected && isChange(row)) ??
    slides.find(isChange) ??
    slides.find((row) => row.id === selected);
  return start?.key ?? slides[0]?.key ?? null;
}

export const useChanges = create<ChangesState>((set, get) => {
  /** Does something to the repository, then reads the changes again; false when it failed. */
  const run = async (deck: string, action: () => Promise<unknown>) => {
    try {
      await action();
      return true;
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
      return false;
    } finally {
      await get().refresh(deck);
    }
  };
  return {
    changes: null,
    deck: null,
    repository: null,
    picked: null,
    onlyChanges: false,
    divider: DEFAULT_DIVIDER,

    checkRepository: async (deck) => {
      let found = false;
      try {
        found = await api.deckInRepository(deck);
      } catch {
        // A deck that cannot be checked just has no Git mode.
      }
      if (useApp.getState().deck?.id === deck) set({ repository: found ? deck : null });
    },

    refresh: async (deck) => {
      const ticket = ++lastRefresh;
      try {
        const changes = await api.deckChanges(deck);
        if (ticket !== lastRefresh) return;
        const previous = get().deck === deck ? get().picked : null;
        const picked = keepPicked(changes, previous, useApp.getState().selected);
        set({ changes, deck, picked });
      } catch (error) {
        if (ticket === lastRefresh) useApp.getState().setError(errorMessage(error));
      }
    },

    pick: (key) => {
      set({ picked: key });
      const id = get().changes?.slides.find((row) => row.key === key)?.id;
      if (id) useApp.getState().select(id);
    },

    step: (by) => {
      const rows = visibleRows(get());
      const at = rows.findIndex((row) => row.key === get().picked);
      const next = rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + by))];
      if (next) get().pick(next.key);
    },

    setOnlyChanges: (onlyChanges) => {
      set({ onlyChanges });
      const rows = visibleRows(get());
      const first = rows[0];
      if (first && !rows.some((row) => row.key === get().picked)) get().pick(first.key);
    },

    stage: async (deck, change) => void (await run(deck, () => api.stageChange(deck, change))),
    unstage: async (deck, change) => void (await run(deck, () => api.unstageChange(deck, change))),

    restore: async (deck, change) => {
      const edit = await useApp.getState().editRail((id) => api.restoreChange(id, change));
      await get().refresh(deck);
      // Restoring an added slide takes away the slide that was selected.
      const { selected, select } = useApp.getState();
      const slides = edit?.deck.slides;
      if (slides && !slides.some((slide) => slide.id === selected)) select(slides[0]?.id ?? null);
    },

    stageAll: async (deck) => void (await run(deck, () => api.stageAll(deck))),
    unstageAll: async (deck) => void (await run(deck, () => api.unstageAll(deck))),
    commit: (deck, message) => run(deck, () => api.commitChanges(deck, message)),

    setDivider: (changes) => set((s) => ({ divider: { ...s.divider, ...changes } })),
    resetDivider: () => set({ divider: DEFAULT_DIVIDER }),
  };
});
