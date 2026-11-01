import { create } from "zustand";

import { api, type DeckChanges, errorMessage, type SlideChange } from "./lib/api";
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
  picked: string | null;
  /** Leaves the slides that did not change out of the list. */
  onlyChanges: boolean;
  divider: Divider;
  /** Reads the changes of `deck` again. */
  refresh: (deck: string) => Promise<void>;
  /** Picks a row of the list; a slide still in the deck becomes the app's selected slide too. */
  pick: (key: string) => void;
  /** Picks the next (1) or previous (-1) row of the list. */
  step: (by: 1 | -1) => void;
  setOnlyChanges: (onlyChanges: boolean) => void;
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

export const useChanges = create<ChangesState>((set, get) => ({
  changes: null,
  deck: null,
  picked: null,
  onlyChanges: false,
  divider: DEFAULT_DIVIDER,

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

  setDivider: (changes) => set((s) => ({ divider: { ...s.divider, ...changes } })),
  resetDivider: () => set({ divider: DEFAULT_DIVIDER }),
}));
