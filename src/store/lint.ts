import { api, type LintIssue } from "../lib/api";
import type { Slice } from "./types";

/** The HTML lint of the open deck's file. */
export interface LintSlice {
  /** Lint result for the saved deck file; null until the first check finishes. */
  lint: LintIssue[] | null;

  refreshLint: () => Promise<void>;
}

/** Only the newest check counts; an earlier one can come back after it. */
let lintRun = 0;

export const createLintSlice: Slice<LintSlice> = (set, get) => ({
  lint: null,

  refreshLint: async () => {
    const { deck } = get();
    if (!deck) return;
    const run = ++lintRun;
    try {
      const issues = await api.lintDeck(deck.id);
      // Ignore answers that a newer check (or another deck) has overtaken.
      if (run === lintRun && get().deck?.id === deck.id) set({ lint: Array.isArray(issues) ? issues : null });
    } catch {
      if (run === lintRun) set({ lint: null });
    }
  },
});
