import { beforeEach, describe, expect, it } from "vitest";

import type { Deck } from "../lib/api";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { backend, calls, freshStore, historyEntry, historyStatus, resetBackend } from "./testing";

beforeEach(resetBackend);

describe("undo and redo", () => {
  const id = "/decks/talk/deck.html";
  const entry = historyEntry;
  const status = historyStatus;
  /** The deck with `slide`'s hash changed. */
  const changed = (slide: string): Deck => {
    const deck = deckFor(DECK_HTML);
    return { ...deck, slides: deck.slides.map((s) => (s.id === slide ? { ...s, hash: "new" } : s)) };
  };
  it("undo takes back the deck's newest change, shows the deck and selects the slide it changed", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", editReload: 0 });
    backend({
      undo_deck: () => ({
        deck: changed("outro"),
        entry: entry("Edit slide"),
        status: status(null, entry("Edit slide")),
      }),
      deck_history: () => status(null, entry("Edit slide")),
    });
    await useApp.getState().undo();
    expect(calls("undo_deck")).toEqual([{ id }]);
    expect(useApp.getState().deck!.slides.find((s) => s.id === "outro")!.hash).toBe("new");
    expect(useApp.getState()).toMatchObject({ selected: "outro", editReload: 1, error: null });
    expect(useApp.getState().history!.redo!.label).toBe("Edit slide");
  });

  it("keeps the selected slide when the change was on it", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    backend({ redo_deck: () => ({ deck: changed("intro"), entry: entry("Edit slide"), status: status() }) });
    await useApp.getState().redo();
    expect(calls("redo_deck")).toEqual([{ id }]);
    expect(useApp.getState().selected).toBe("intro");
  });

  it("reports an undo the deck's history refused", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    backend({
      undo_deck: () => {
        throw "The agent is still working on the deck; stop it or wait for it to finish first.";
      },
    });
    await useApp.getState().undo();
    expect(useApp.getState().error).toContain("still working");
  });

  it("takes back review marks with the deck", async () => {
    const useApp = await freshStore();
    const stroke = { tool: "pen" as const, color: "#ef4444", points: [[0.1, 0.2]] as [number, number][] };
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", sketches: {} });
    backend({
      undo_deck: () => ({
        deck: { ...deckFor(DECK_HTML), review: { intro: [stroke] } },
        entry: entry("Review marks", "review"),
        status: status(),
      }),
    });
    await useApp.getState().undo();
    expect(useApp.getState().sketches).toEqual({ intro: [stroke] });
  });
});
