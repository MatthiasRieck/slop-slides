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
});
