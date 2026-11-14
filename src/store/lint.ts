import { api, type Deck, errorMessage, type LintIssue } from "../lib/api";
import type { Slice } from "./types";

/** The HTML lint of the open deck's file. */
export interface LintSlice {
  /** Lint result for the saved deck file; null until a check finishes, and after one that failed. */
  lint: LintIssue[] | null;
  /** Why the last check gave no result; null while one is under way or when it worked. */
  lintError: string | null;

  /** Checks the deck file now. */
  refreshLint: () => Promise<void>;
  /**
   * The deck file changed: checks it again once it has stayed as it is for a moment, as each
   * check reads the whole deck. A deck just opened is checked at once.
   */
  lintChanged: () => void;
}

/** How long the deck stays unchanged before it is checked again. */
export const LINT_DELAY = 400;

/** Only the newest check counts; an earlier one can come back after it. */
let lintRun = 0;
/** The check waiting for the deck to settle. */
let lintTimer: ReturnType<typeof setTimeout> | undefined;

const contentKeys = new WeakMap<Deck, string>();

/**
 * What of `deck` the lint reads: its file's shared part and every slide's markup, as a key that
 * changes when any of them does. Worked out once per deck, which stays the same object for as
 * long as nothing in it changes (see `shareDeck`).
 */
export function lintKey(deck: Deck | null): string {
  if (!deck) return "";
  let key = contentKeys.get(deck);
  if (key === undefined) {
    key = [deck.id, deck.shellHash, ...deck.slides.map((slide) => `${slide.id}:${slide.hash}`)].join("|");
    contentKeys.set(deck, key);
  }
  return key;
}

export const createLintSlice: Slice<LintSlice> = (set, get) => ({
  lint: null,
  lintError: null,

  refreshLint: async () => {
    clearTimeout(lintTimer);
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

  lintChanged: () => {
    clearTimeout(lintTimer);
    const { deck, lint, lintError } = get();
    if (!deck) return;
    // Nothing is known of a deck just opened, so there is nothing to show while waiting.
    if (lint === null && lintError === null) void get().refreshLint();
    else lintTimer = setTimeout(() => void get().refreshLint(), LINT_DELAY);
  },
});
