import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { LINT_DELAY, lintKey } from "./lint";
import { backend, calls, freshStore, resetBackend } from "./testing";

beforeEach(resetBackend);

describe("lint", () => {
  const issue = (patch: Record<string, unknown> = {}) => ({
    rule: "unclosed-tag",
    severity: "error",
    message: "<div> is never closed.",
    line: 12,
    slide: "intro",
    ...patch,
  });

  it("refreshLint stores the backend's issues", async () => {
    const useApp = await freshStore();
    backend({ lint_deck: () => [issue()] });
    useApp.setState({ deck: deckFor(DECK_HTML) });
    expect(await useApp.getState().refreshLint()).toBe(true);
    expect(calls("lint_deck")).toEqual([{ id: "/decks/talk/deck.html" }]);
    expect(useApp.getState().lint).toEqual([issue()]);
  });

  it("opens the deck's code in the sidebar on a line, until the code shows it", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), sidebarTab: "chat" });
    useApp.getState().revealCodeLine(42);
    expect(useApp.getState()).toMatchObject({ codeReveal: 42, sidebarTab: "code", sidebarOpen: true });
    useApp.getState().codeLineShown();
    expect(useApp.getState().codeReveal).toBeNull();
  });

  it("does nothing without a deck", async () => {
    const useApp = await freshStore();
    await useApp.getState().refreshLint();
    expect(calls("lint_deck")).toEqual([]);
    expect(useApp.getState().lint).toBeNull();
  });

  it("keeps only the newest of overlapping checks", async () => {
    const useApp = await freshStore();
    const answers: ((issues: unknown) => void)[] = [];
    invoke.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    useApp.setState({ deck: deckFor(DECK_HTML) });
    const first = useApp.getState().refreshLint();
    const second = useApp.getState().refreshLint();
    answers[1]!([]);
    expect(await second).toBe(true);
    answers[0]!([issue()]);
    // The overtaken check is not the one shown.
    expect(await first).toBe(false);
    expect(useApp.getState().lint).toEqual([]);
  });

  it("drops results for a deck that is no longer open", async () => {
    const useApp = await freshStore();
    let answer: (issues: unknown) => void = () => {};
    invoke.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    useApp.setState({ deck: deckFor(DECK_HTML) });
    const pending = useApp.getState().refreshLint();
    useApp.setState({ deck: { ...deckFor(DECK_HTML), id: "other" } });
    answer([issue()]);
    await pending;
    expect(useApp.getState().lint).toBeNull();
  });

  it("clears the status when linting fails", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), lint: [] });
    backend({
      lint_deck: () => {
        throw new Error("deck not found: talk");
      },
    });
    await useApp.getState().refreshLint();
    expect(useApp.getState().lint).toBeNull();
    expect(useApp.getState().lintError).toBe("deck not found: talk");
  });

  it("is checking again, not failed, while a failed check is retried, and forgets the failure once one works", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), lint: null, lintError: "no" });
    let answer: (issues: unknown) => void = () => {};
    invoke.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const pending = useApp.getState().refreshLint();
    expect(useApp.getState()).toMatchObject({ lint: null, lintError: null });
    answer([issue()]);
    await pending;
    expect(useApp.getState()).toMatchObject({ lint: [issue()], lintError: null });
  });

  it("takes an answer that is no list of issues for a failed check", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), lint: [] });
    backend({ lint_deck: () => null });
    await useApp.getState().refreshLint();
    expect(useApp.getState().lint).toBeNull();
    expect(useApp.getState().lintError).toBe("The check gave no result.");
  });

  describe("as the deck changes", () => {
    beforeEach(() => void vi.useFakeTimers());
    afterEach(() => void vi.useRealTimers());

    it("checks a deck just opened at once", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: deckFor(DECK_HTML), lint: null, lintError: null });
      backend({ lint_deck: () => [] });
      useApp.getState().lintChanged();
      expect(calls("lint_deck")).toHaveLength(1);
    });

    it("checks once after a burst of saves, when the deck has settled", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: deckFor(DECK_HTML), lint: [], lintError: null });
      backend({ lint_deck: () => [issue()] });
      for (let save = 0; save < 5; save++) {
        useApp.getState().lintChanged();
        await vi.advanceTimersByTimeAsync(LINT_DELAY - 100);
      }
      expect(calls("lint_deck")).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      expect(calls("lint_deck")).toHaveLength(1);
      expect(useApp.getState().lint).toEqual([issue()]);
    });

    it("waits after a failed check too, and a check asked for by hand takes the waiting one's place", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: deckFor(DECK_HTML), lint: null, lintError: "no" });
      backend({ lint_deck: () => [] });
      useApp.getState().lintChanged();
      expect(calls("lint_deck")).toEqual([]);
      // Still shown as failed until the check runs.
      expect(useApp.getState().lintError).toBe("no");
      await useApp.getState().refreshLint();
      expect(calls("lint_deck")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(LINT_DELAY * 2);
      expect(calls("lint_deck")).toHaveLength(1);
    });

    it("checks nothing without a deck", async () => {
      const useApp = await freshStore();
      useApp.getState().lintChanged();
      await vi.advanceTimersByTimeAsync(LINT_DELAY * 2);
      expect(calls("lint_deck")).toEqual([]);
    });
  });

  it("knows what of a deck the check reads, worked out once per deck", async () => {
    const deck = deckFor(DECK_HTML);
    const read = vi.spyOn(deck.slides, "map");
    expect(lintKey(deck)).toBe("/decks/talk/deck.html|shell-1|intro:intro-1|#2:#2-1|outro:outro-1");
    expect(lintKey(deck)).toBe(lintKey(deck));
    expect(read).toHaveBeenCalledTimes(1);
    expect(lintKey(deckFor(DECK_HTML, "2"))).not.toBe(lintKey(deck));
    expect(lintKey(null)).toBe("");
  });

  it("resets lint and composer text when the deck closes", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), lint: [], composerFill: { text: "x", rev: 1 } });
    await useApp.getState().closeDeck();
    expect(useApp.getState().lint).toBeNull();
    expect(useApp.getState().composerFill).toBeNull();
  });
});
