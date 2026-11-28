import { beforeEach, describe, expect, it } from "vitest";

import type { Deck } from "../lib/api";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { lastError } from "./errors";
import { undoNewest } from "./history";
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

  it("keeps the slides shown side by side when the change was on another of them", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", railSelected: ["intro", "outro"], editReload: 0 });
    backend({ undo_deck: () => ({ deck: changed("outro"), entry: entry("Edit slide"), status: status() }) });
    await useApp.getState().undo();
    expect(useApp.getState()).toMatchObject({ selected: "outro", railSelected: ["intro", "outro"], editReload: 0 });
    // A change on a slide that is not among them goes there, and shows it alone.
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", railSelected: ["intro", "outro"] });
    backend({ undo_deck: () => ({ deck: changed("#2"), entry: entry("Edit slide"), status: status() }) });
    await useApp.getState().undo();
    expect(useApp.getState()).toMatchObject({ selected: "#2", railSelected: [] });
  });

  it("shows the slide an element went to, with the others, when it is taken back from there or put there again", async () => {
    const useApp = await freshStore();
    // A move between two slides shown side by side changed both; the stage is on the second.
    const both = (): Deck => {
      const deck = changed("intro");
      return { ...deck, slides: deck.slides.map((s) => (s.id === "outro" ? { ...s, hash: "new" } : s)) };
    };
    const shown = { selected: "outro", railSelected: ["intro", "outro"] };
    backend({
      undo_deck: () => ({ deck: both(), entry: entry("Edit slide"), status: status() }),
      redo_deck: () => ({ deck: deckFor(DECK_HTML), entry: entry("Edit slide"), status: status() }),
    });
    useApp.setState({ deck: deckFor(DECK_HTML), ...shown, editReload: 0 });
    await useApp.getState().undo();
    // The slide on the stage is one of those that changed: it stays, and its editor starts again.
    expect(useApp.getState()).toMatchObject({ ...shown, editReload: 1 });
    await useApp.getState().redo();
    expect(useApp.getState()).toMatchObject({ ...shown, editReload: 2 });
  });

  it("redo keeps the slides shown side by side when the change was on another of them", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", railSelected: ["intro", "outro"], editReload: 0 });
    backend({ redo_deck: () => ({ deck: changed("outro"), entry: entry("Edit slide"), status: status() }) });
    await useApp.getState().redo();
    expect(useApp.getState()).toMatchObject({ selected: "outro", railSelected: ["intro", "outro"], editReload: 0 });
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

  describe("of the newest change, as long as it is the one meant", () => {
    const move = { ...entry("Edit slide"), group: "edit:transfer:7" };
    const only = { deck: id, group: "edit:transfer:7" };
    /** A store on the deck, whose history says `newest` is what undo takes back, and `redone` what redo makes again. */
    const withHistory = async (newest: typeof move | null, redone: typeof move | null = null) => {
      const useApp = await freshStore();
      useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
      backend({
        deck_history: () => status(newest, redone),
        undo_deck: () => ({ deck: changed("intro"), entry: newest, status: status(null, newest) }),
      });
      return useApp;
    };

    it("undoes the change with that label", async () => {
      const useApp = await withHistory(move);
      expect(await undoNewest(useApp, "Edit slide", "move")).toBe(true);
      expect(calls("undo_deck")).toEqual([{ id }]);
      expect(lastError(useApp.getState())).toBeNull();
    });

    it("undoes nothing when a change with another label is the newest, and says so", async () => {
      const useApp = await withHistory({ ...move, label: "Move slides" });
      expect(await undoNewest(useApp, "Edit slide", "move")).toBe(false);
      expect(calls("undo_deck")).toEqual([]);
      expect(lastError(useApp.getState())).toBe("The move cannot be undone: the deck changed since.");
    });

    it("undoes the change of the group asked for", async () => {
      const useApp = await withHistory(move);
      expect(await undoNewest(useApp, "Edit slide", "move", only)).toBe(true);
      expect(calls("undo_deck")).toEqual([{ id }]);
    });

    it("leaves a change alone that is labelled alike but of another group, or of none", async () => {
      for (const group of ["edit:transfer:8", "edit:intro:nudge:0", null, undefined]) {
        resetBackend();
        const useApp = await withHistory({ ...move, group } as typeof move);
        expect(await undoNewest(useApp, "Edit slide", "move", only)).toBe(false);
        expect(calls("undo_deck")).toEqual([]);
        expect(lastError(useApp.getState())).toBe("The move cannot be undone: the deck changed since.");
      }
    });

    it("says nothing when the change was undone already", async () => {
      const useApp = await withHistory({ ...move, group: "edit:intro:nudge:0" }, move);
      expect(await undoNewest(useApp, "Edit slide", "move", only)).toBe(false);
      expect(calls("undo_deck")).toEqual([]);
      expect(lastError(useApp.getState())).toBeNull();
      // Without the group, there is no telling: the newest change is not undone for its label alone.
      const empty = await withHistory(null, move);
      expect(await undoNewest(empty, "Edit slide", "move", only)).toBe(false);
      expect(lastError(empty.getState())).toBeNull();
    });

    it("undoes nothing in another deck than the one the change was made in, and says nothing", async () => {
      const useApp = await withHistory(move);
      expect(await undoNewest(useApp, "Edit slide", "move", { ...only, deck: "/decks/other/deck.html" })).toBe(false);
      expect(calls("undo_deck")).toEqual([]);
      expect(lastError(useApp.getState())).toBeNull();
    });
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
