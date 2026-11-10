import { beforeEach, describe, expect, it } from "vitest";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
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
    await useApp.getState().refreshLint();
    expect(calls("lint_deck")).toEqual([{ id: "/decks/talk/deck.html" }]);
    expect(useApp.getState().lint).toEqual([issue()]);
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
    await second;
    answers[0]!([issue()]);
    await first;
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
  });

  it("resets lint and composer text when the deck closes", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), lint: [], composerFill: { text: "x", rev: 1 } });
    await useApp.getState().closeDeck();
    expect(useApp.getState().lint).toBeNull();
    expect(useApp.getState().composerFill).toBeNull();
  });
});
