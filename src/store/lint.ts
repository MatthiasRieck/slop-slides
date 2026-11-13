import { api, errorMessage, type LintIssue } from "../lib/api";
import type { Slice } from "./types";

/** The HTML lint of the open deck's file. */
export interface LintSlice {
  /** Lint result for the saved deck file; null until a check finishes, and after one that failed. */
  lint: LintIssue[] | null;
  /** Why the last check gave no result; null while one is under way or when it worked. */
  lintError: string | null;

  refreshLint: () => Promise<void>;
}

/** Only the newest check counts; an earlier one can come back after it. */
let lintRun = 0;

export const createLintSlice: Slice<LintSlice> = (set, get) => ({
  lint: null,
  lintError: null,

  refreshLint: async () => {
    const { deck } = get();
    if (!deck) return;
    const run = ++lintRun;
    // A check that failed is being tried again: it shows as checking, not as failed.
    if (get().lintError !== null) set({ lintError: null });
    try {
      const issues = await api.lintDeck(deck.id);
      // Ignore answers that a newer check (or another deck) has overtaken.
      if (run !== lintRun || get().deck?.id !== deck.id) return;
      if (Array.isArray(issues)) set({ lint: issues, lintError: null });
      else set({ lint: null, lintError: "The check gave no result." });
    } catch (error) {
      if (run === lintRun) set({ lint: null, lintError: errorMessage(error) });
    }
  },
});
