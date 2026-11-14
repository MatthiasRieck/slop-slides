import { beforeEach, describe, expect, it } from "vitest";

import type { Deck } from "../lib/api";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { lastError } from "./errors";
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
    // The change was on another slide: the stage goes there, which loads it; no editor starts again for it.
    expect(useApp.getState()).toMatchObject({ selected: "outro", editReload: 0, toasts: [] });
    expect(useApp.getState().history!.redo!.label).toBe("Edit slide");
  });

  it("starts the slide editor again only when the slide shown or the deck's styles changed", async () => {
    const useApp = await freshStore();
    const reloads = () => useApp.getState().editReload;
    const undoing = async (deck: Deck) => {
      useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", editReload: 0 });
      backend({ undo_deck: () => ({ deck, entry: entry("Edit slide"), status: status() }) });
      await useApp.getState().undo();
    };
    // Nothing on a slide changed (the order of the slides, say, or a note): the editor goes on.
    await undoing(deckFor(DECK_HTML));
    expect(reloads()).toBe(0);
    expect(useApp.getState().selected).toBe("intro");
    await undoing(changed("outro"));
    expect(reloads()).toBe(0);
    // The slide it shows is another now, and so are the deck's styles: it has to load them.
    await undoing(changed("intro"));
    expect(reloads()).toBe(1);
    await undoing({ ...deckFor(DECK_HTML), shellHash: "restyled" });
    expect(reloads()).toBe(1);
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
    expect(lastError(useApp.getState())).toContain("still working");
  });

  it("goes back to an earlier version as one change, which undo then takes back", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", editReload: 0 });
    const made = entry("Go back to an earlier version", "deck");
    backend({ restore_version: () => ({ deck: changed("intro"), entry: made, status: status(made) }) });
    expect(await useApp.getState().restoreVersion("v3")).toBe(true);
    expect(calls("restore_version")).toEqual([{ id, version: "v3" }]);
    expect(useApp.getState().deck!.slides.find((s) => s.id === "intro")!.hash).toBe("new");
    expect(useApp.getState().history!.undo!.label).toBe("Go back to an earlier version");
    // The slide on show changed under the editor.
    expect(useApp.getState().editReload).toBe(1);
  });

  it("says why it could not go back to a version, and leaves the deck", async () => {
    const useApp = await freshStore();
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck, selected: "intro" });
    backend({
      restore_version: () => {
        throw "That version of the deck is no longer available.";
      },
    });
    expect(await useApp.getState().restoreVersion("gone")).toBe(false);
    expect(useApp.getState().deck).toBe(deck);
    expect(lastError(useApp.getState())).toContain("no longer available");
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
