import { create } from "zustand";

import { api, type Change, type DeckChanges, errorMessage, type RailEdit, type SlideChange } from "./lib/api";
import { DEFAULT_DIVIDER, type Divider } from "./lib/compare";
import { showError, showSuccess, useApp } from "./store";

/** What the comparison shows of a slide that changed: both versions split by the divider, or one of them. */
export type CompareView = "split" | "before" | "after";

/**
 * Git mode (see components/ChangesView.tsx): what changed in the open deck since the last commit,
 * the row picked in the list (which, unlike the app's selected slide, can be a removed slide),
 * and how the comparison shows a slide (its view and its divider), which stays put going from
 * slide to slide.
 */
interface ChangesState {
  /** The changes of `deck`; null until they have been read. */
  changes: DeckChanges | null;
  deck: string | null;
  /** The changes of `deck` are being read. */
  loading: boolean;
  /** Why the changes of `deck` could not be read, when the last reading failed. */
  error: string | null;
  /** The deck last found in a git repository, which is what offers Git mode. */
  repository: string | null;
  picked: string | null;
  /** Leaves the slides that did not change out of the list. */
  onlyChanges: boolean;
  divider: Divider;
  view: CompareView;
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
  /** Puts the whole deck back as it was committed, as one change the slide list's undo brings back. */
  restoreAll: (deck: string) => Promise<void>;
  stageAll: (deck: string) => Promise<void>;
  unstageAll: (deck: string) => Promise<void>;
  /** Commits what is staged and says which commit it made; false when that failed. */
  commit: (deck: string, message: string) => Promise<boolean>;
  /** Stages everything in the deck, then commits it; false when either failed. */
  commitAll: (deck: string, message: string) => Promise<boolean>;
  setView: (view: CompareView) => void;
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
      showError(error);
      return false;
    } finally {
      await get().refresh(deck);
    }
  };
  /** After a restore wrote the deck: reads the changes again, and selects a slide that is still there. */
  const restored = async (deck: string, edit: RailEdit | null) => {
    await get().refresh(deck);
    // Restoring an added slide takes away the slide that was selected.
    const { selected, select } = useApp.getState();
    const slides = edit?.deck.slides;
    if (slides && !slides.some((slide) => slide.id === selected)) select(slides[0]?.id ?? null);
  };
  return {
    changes: null,
    deck: null,
    loading: false,
    error: null,
    repository: null,
    picked: null,
    onlyChanges: false,
    divider: DEFAULT_DIVIDER,
    view: "split",

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
      // Another deck's changes are not this one's, not even while its own are read.
      if (get().deck !== deck) set({ deck, changes: null, picked: null, error: null });
      set({ loading: true });
      try {
        const changes = await api.deckChanges(deck);
        if (ticket !== lastRefresh) return;
        const picked = keepPicked(changes, get().picked, useApp.getState().selected);
        set({ changes, picked, loading: false, error: null });
      } catch (error) {
        // The view says so, with a way to try again; what was read before stays behind it.
        if (ticket === lastRefresh) set({ loading: false, error: errorMessage(error) });
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

    restore: async (deck, change) =>
      restored(deck, await useApp.getState().editRail((id) => api.restoreChange(id, change))),

    restoreAll: async (deck) => restored(deck, await useApp.getState().editRail((id) => api.restoreAllChanges(id))),

    stageAll: async (deck) => void (await run(deck, () => api.stageAll(deck))),
    unstageAll: async (deck) => void (await run(deck, () => api.unstageAll(deck))),

    commit: async (deck, message) => {
      const done = await run(deck, () => api.commitChanges(deck, message));
      // The changes were read again: their commit is the one just made.
      const hash = get().changes?.commit?.hash;
      if (done) showSuccess(hash ? `Committed ${hash}` : "Committed");
      return done;
    },

    commitAll: async (deck, message) => {
      try {
        await api.stageAll(deck);
      } catch (error) {
        showError(error);
        await get().refresh(deck);
        return false;
      }
      return get().commit(deck, message);
    },

    setView: (view) => set({ view }),

    setDivider: (changes) => set((s) => ({ divider: { ...s.divider, ...changes } })),
    resetDivider: () => set({ divider: DEFAULT_DIVIDER }),
  };
});
