import { create } from "zustand";

import { api, type Change, type DeckChanges, type Discarded, errorMessage, type SlideChange } from "./lib/api";
import { DEFAULT_DIVIDER, type Divider } from "./lib/compare";
import { plural } from "./lib/utils";
import { showError, showSuccess, useApp } from "./store";
import { refreshHistory, undoNewest } from "./store/history";

/** What the comparison shows of a slide that changed: both versions split by the divider, or one of them. */
export type CompareView = "split" | "before" | "after";

/**
 * What shows while the other version is flipped to (see `flipped`): the other one of the two, and
 * from the split view the slide as it was, whole.
 */
export function shownView(view: CompareView, flipped: boolean): CompareView {
  if (!flipped) return view;
  return view === "before" ? "after" : "before";
}

/**
 * How the deck's history labels what discarding changes does (see src-tauri/src/commands/git.rs):
 * the Undo offered after one takes back the change with that label.
 */
const DISCARD_LABEL = "Discard changes";
const DISCARD_ALL_LABEL = "Discard all changes";

/**
 * Changes mode (see components/ChangesView.tsx): what changed in the open deck since its last
 * saved version (a git commit), the row picked in the list (which, unlike the app's selected
 * slide, can be a removed slide), and how the comparison shows a slide (its view and its
 * divider), which stays put going from slide to slide.
 */
interface ChangesState {
  /** The changes of `deck`; null until they have been read. */
  changes: DeckChanges | null;
  deck: string | null;
  /** The changes of `deck` are being read. */
  loading: boolean;
  /** Why the changes of `deck` could not be read, when the last reading failed. */
  error: string | null;
  /** The deck last found in a git repository, which is what offers Changes mode. */
  repository: string | null;
  picked: string | null;
  /** Leaves the slides that did not change out of the list. */
  onlyChanges: boolean;
  divider: Divider;
  view: CompareView;
  /** Held down to look at the other version in place (see `shownView`). */
  flipped: boolean;
  /** The list of the words that changed, under the slide, is unfolded. */
  textOpen: boolean;
  /** Finds out whether `deck` is in a git repository. */
  checkRepository: (deck: string) => Promise<void>;
  /** Reads the changes of `deck` again. */
  refresh: (deck: string) => Promise<void>;
  /** Picks a row of the list; a slide still in the deck becomes the app's selected slide too. */
  pick: (key: string) => void;
  /** Picks the next (1) or previous (-1) row of the list. */
  step: (by: 1 | -1) => void;
  setOnlyChanges: (onlyChanges: boolean) => void;
  /** Includes a change in the next version (stages it), leaving the deck on disk as it is. */
  stage: (deck: string, change: Change) => Promise<void>;
  unstage: (deck: string, change: Change) => Promise<void>;
  /**
   * Puts a change back as it was in the last version, and says so (`done`) in a message that
   * offers to undo it, as long as the deck's history can.
   */
  restore: (deck: string, change: Change, done: string) => Promise<void>;
  /** Puts the whole deck back as it was in the last version, as one change, with the same message. */
  restoreAll: (deck: string) => Promise<void>;
  stageAll: (deck: string) => Promise<void>;
  unstageAll: (deck: string) => Promise<void>;
  /** Saves a version (a commit) of what is included, and says so; false when that failed. */
  commit: (deck: string, message: string) => Promise<boolean>;
  /** Includes everything in the deck, then saves a version of it; false when either failed. */
  commitAll: (deck: string, message: string) => Promise<boolean>;
  setView: (view: CompareView) => void;
  setFlipped: (flipped: boolean) => void;
  setTextOpen: (textOpen: boolean) => void;
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
  /**
   * Discards changes with `discard`, a change to the deck its history labels `label`: reads the
   * changes again, selects a slide that is still there, and says what was done (`done`). The
   * message offers Undo only when the history has the change to take back, and says so when
   * files went back with it, which no undo covers.
   */
  const discarding = async (deck: string, discard: (id: string) => Promise<Discarded>, label: string, done: string) => {
    let files = 0;
    const edit = await useApp.getState().editRail(async (id) => {
      const discarded = await discard(id);
      files = discarded.files;
      return discarded;
    });
    await get().refresh(deck);
    if (!edit) return;
    // Discarding a new slide takes away the slide that was selected.
    const { selected, select } = useApp.getState();
    const { slides } = edit.deck;
    if (!slides.some((slide) => slide.id === selected)) select(slides[0]?.id ?? null);
    await refreshHistory(useApp);
    const undoable = useApp.getState().history?.undo?.label === label;
    const text = files > 0 ? `${done}, with ${plural(files, "file")} it used (Undo does not bring files back)` : done;
    const undo = { label: "Undo", run: () => void undoNewest(useApp, label, "discard") };
    showSuccess(text, undoable ? undo : undefined);
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
    flipped: false,
    textOpen: true,

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

    restore: (deck, change, done) => discarding(deck, (id) => api.restoreChange(id, change), DISCARD_LABEL, done),

    restoreAll: (deck) =>
      discarding(deck, (id) => api.restoreAllChanges(id), DISCARD_ALL_LABEL, "The deck is back as in the last version"),

    stageAll: async (deck) => void (await run(deck, () => api.stageAll(deck))),
    unstageAll: async (deck) => void (await run(deck, () => api.unstageAll(deck))),

    commit: async (deck, message) => {
      const done = await run(deck, () => api.commitChanges(deck, message));
      if (done) showSuccess("Saved a version");
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

    setView: (view) => set({ view, flipped: false }),
    setFlipped: (flipped) => set({ flipped }),
    setTextOpen: (textOpen) => set({ textOpen }),

    setDivider: (changes) => set((s) => ({ divider: { ...s.divider, ...changes } })),
    resetDivider: () => set({ divider: DEFAULT_DIVIDER }),
  };
});
