import { beforeEach, describe, expect, it } from "vitest";

import { DECK_HTML, deckFor } from "../test/fixtures";
import { lastError } from "./errors";
import { backend, calls, freshStore, historyEntry, historyStatus, resetBackend } from "./testing";

beforeEach(resetBackend);

describe("find and replace", () => {
  const entry = historyEntry;
  const status = historyStatus;

  it("undoes a replace while it is the deck's newest change, and refuses once something came after", async () => {
    const useApp = await freshStore();
    const replaced = { deck: deckFor(DECK_HTML), count: 1, slides: [], skipped: [], previous: "", source: "" };
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", toasts: [] });
    backend({
      deck_history: () => status(entry("Replace text")),
      undo_deck: () => ({ deck: deckFor(DECK_HTML), entry: entry("Replace text"), status: status() }),
    });
    expect(await useApp.getState().undoReplace(replaced)).toBe(true);
    expect(calls("undo_deck")).toHaveLength(1);
    backend({ deck_history: () => status(entry("Move slides", "rail")) });
    expect(await useApp.getState().undoReplace(replaced)).toBe(false);
    expect(lastError(useApp.getState())).toContain("cannot be undone");
  });

  const match = (slide: string, index: number, more: Record<string, unknown> = {}) => ({
    slide,
    index,
    locked: false,
    notes: false,
    before: "",
    text: "x",
    after: "",
    ...more,
  });

  it("keeps why a search failed, apart from having found nothing, and forgets it with the query", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    useApp.getState().setSearch({ query: "x" });
    backend({
      find_in_deck: () => {
        throw "the deck file is gone";
      },
    });
    await useApp.getState().runSearch();
    expect(useApp.getState().search).toMatchObject({ matches: null, failed: "the deck file is gone" });
    backend({ find_in_deck: () => [] });
    await useApp.getState().runSearch();
    expect(useApp.getState().search).toMatchObject({ matches: [], failed: null });
    backend({ find_in_deck: () => null });
    await useApp.getState().runSearch();
    expect(useApp.getState().search.failed).toBe("The search gave no result.");
    useApp.getState().setSearch({ query: "" });
    expect(useApp.getState().search).toMatchObject({ matches: null, failed: null });
  });

  it("drops the answer to a query that has changed since it was asked", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    useApp.getState().setSearch({ query: "x" });
    let answer: (found: unknown) => void = () => {};
    backend({ find_in_deck: () => new Promise((resolve) => (answer = resolve)) });
    const first = useApp.getState().runSearch();
    useApp.getState().setSearch({ query: "xy" });
    answer([match("intro", 0)]);
    await first;
    expect(useApp.getState().search.matches).toBeNull();
    // Without a query there is nothing to ask.
    useApp.getState().setSearch({ query: " " });
    await useApp.getState().runSearch();
    expect(calls("find_in_deck")).toHaveLength(1);
  });

  it("asks the search field to take the focus, once, and stays open until the search ends", async () => {
    const useApp = await freshStore();
    useApp.getState().openFind();
    expect(useApp.getState().search).toMatchObject({ open: true, focusAsked: true });
    useApp.getState().findFocused();
    expect(useApp.getState().search).toMatchObject({ open: true, focusAsked: false });
    useApp.getState().setSearch({ query: "x" });
    expect(useApp.getState().search.open).toBe(true);
    useApp.getState().clearSearch();
    expect(useApp.getState().search).toMatchObject({ open: false, query: "" });
  });

  it("opens the Notes tab for a match in a slide's notes, and leaves the sidebar alone for the others", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", sidebarTab: "chat" });
    useApp.getState().setSearch({ query: "x" });
    useApp.getState().setSearchMatches([match("intro", 0), match("outro", 2, { notes: true })]);
    useApp.getState().stepSearch(1);
    expect(useApp.getState()).toMatchObject({ selected: "outro", sidebarTab: "notes" });
    useApp.setState({ sidebarTab: "chat" });
    useApp.getState().stepSearch(1);
    expect(useApp.getState()).toMatchObject({ selected: "intro", sidebarTab: "chat" });
  });

  it("replaces the match in focus by its place on its slide, then goes to the one after it", async () => {
    const useApp = await freshStore();
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck, selected: "outro" });
    useApp.getState().setSearch({ query: "x" });
    useApp.getState().setSearchMatches([match("intro", 0), match("outro", 2), match("outro", 2), match("outro", 2)]);
    useApp.getState().stepSearch(1);
    expect(useApp.getState().search.active).toBe(2);
    const replaced = { deck, count: 1, slides: ["outro"], skipped: [], previous: "", source: "" };
    backend({
      replace_match_in_deck: () => replaced,
      find_in_deck: () => [match("intro", 0), match("outro", 2), match("outro", 2)],
    });
    expect(await useApp.getState().replaceMatch("y")).toEqual(replaced);
    expect(calls("replace_match_in_deck")).toEqual([
      {
        id: deck.id,
        query: "x",
        replacement: "y",
        options: { matchCase: false, wholeWord: false },
        slide: "outro",
        nth: 1,
      },
    ]);
    expect(useApp.getState().search.active).toBe(2);

    // What it was replaced with matches too: on past it, around to the first.
    backend({
      replace_match_in_deck: () => replaced,
      find_in_deck: () => [match("intro", 0), match("outro", 2), match("outro", 2)],
    });
    await useApp.getState().replaceMatch("xx");
    expect(useApp.getState().search.active).toBe(0);
    expect(useApp.getState().selected).toBe("intro");
  });

  it("replaces nothing on a locked slide, or without a match in focus", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    useApp.getState().setSearch({ query: "x" });
    useApp.getState().setSearchMatches([match("intro", 0, { locked: true })]);
    expect(await useApp.getState().replaceMatch("y")).toBeNull();
    useApp.getState().select("outro");
    expect(await useApp.getState().replaceMatch("y")).toBeNull();
    expect(calls("replace_match_in_deck")).toEqual([]);
  });
});
