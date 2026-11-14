import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Deck } from "../lib/api";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { lastError, toastTexts } from "./errors";
import { railStateOf } from "./slides";
import { backend, calls, DECK, freshStore, historyEntry, historyStatus, resetBackend, type TestStore } from "./testing";

beforeEach(resetBackend);

describe("slide selection", () => {
  it("select changes the slide and bumps revealRev, even for the same slide", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML) });
    const rev = useApp.getState().revealRev;
    useApp.getState().select("outro");
    expect(useApp.getState().selected).toBe("outro");
    expect(useApp.getState().revealRev).toBe(rev + 1);
    // Clicking the selected thumbnail again must still reveal it in the HTML view.
    useApp.getState().select("outro");
    expect(useApp.getState().revealRev).toBe(rev + 2);
  });

  it("selectRelative moves within bounds and bumps revealRev", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    useApp.getState().selectRelative(1);
    expect(useApp.getState().selected).toBe("#2");
    useApp.getState().selectRelative(5);
    expect(useApp.getState().selected).toBe("outro");
    useApp.getState().selectRelative(-10);
    expect(useApp.getState().selected).toBe("intro");
    expect(useApp.getState().revealRev).toBe(3);
  });

  it("selectRelative does nothing without slides", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: { ...deckFor(""), slides: [] }, selected: null });
    useApp.getState().selectRelative(1);
    expect(useApp.getState().selected).toBeNull();
    expect(useApp.getState().revealRev).toBe(0);
  });

  it("setDeck keeps the selection when the slide survives, else picks the first", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "outro" });
    useApp.getState().setDeck(deckFor(DECK_HTML, "2"));
    expect(useApp.getState().selected).toBe("outro");
    useApp.getState().setDeck(deckFor(DECK_HTML.replace(` id="outro"`, ` id="end"`)));
    expect(useApp.getState().selected).toBe("intro");
  });
});

describe("slide image export", () => {
  it("remembers the folder and which slides to save", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK });
    useApp.getState().startImageExport("/out/Talk");
    expect(useApp.getState().imageExport).toEqual({ dir: "/out/Talk", slides: ["intro", "#2", "outro"] });
    useApp.getState().endImageExport();
    expect(useApp.getState().imageExport).toBeNull();
  });

  it("does not start without slides", async () => {
    const useApp = await freshStore();
    useApp.getState().startImageExport("/out/Talk");
    useApp.setState({ deck: { ...DECK, slides: [] } });
    useApp.getState().startImageExport("/out/Talk");
    expect(useApp.getState().imageExport).toBeNull();
  });

  it("is abandoned when the deck closes or another opens", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, imageExport: { dir: "/out", slides: ["intro"] } });
    await useApp.getState().closeDeck();
    expect(useApp.getState().imageExport).toBeNull();
    backend({
      open_workspace: () => ({ path: "/decks/talk", name: "talk" }),
      open_deck: () => DECK,
      load_chat: () => [],
      agent_running: () => false,
    });
    useApp.setState({ imageExport: { dir: "/out", slides: ["intro"] } });
    await useApp.getState().openDeck("/decks/talk/deck.html");
    expect(useApp.getState().imageExport).toBeNull();
  });
});

describe("slide rail changes", () => {
  const edited = (previous: string, source: string, deck: Deck = deckFor(DECK_HTML)) => ({
    deck,
    previous,
    source,
    created: [],
  });

  async function hide(useApp: TestStore, previous: string, source: string) {
    backend({ set_slides_hidden: () => edited(previous, source) });
    await useApp.getState().setSlidesHidden(["intro"], true);
  }

  it("shows the deck a change gives back and asks the deck's history what undo would do", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", history: null });
    const status = { undo: { id: "e1", source: "rail", label: "Hide slides", time: 0 }, redo: null, current: "e1" };
    await hide(useApp, "<0>", "<1>");
    backend({ deck_history: () => status });
    await useApp.getState().refreshHistory();
    expect(calls("set_slides_hidden")).toHaveLength(1);
    expect(useApp.getState().history).toEqual(status);
  });

  it("waits for slide edits still being saved", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    const order: string[] = [];
    backend({
      update_slide: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("edit");
        return deckFor(DECK_HTML);
      },
      set_slides_hidden: () => {
        order.push("hide");
        return edited("<0>", "<1>");
      },
    });
    void useApp.getState().saveSlideEdit("intro", "<section></section>");
    await useApp.getState().setSlidesHidden(["intro"], true);
    expect(order).toEqual(["edit", "hide"]);
  });

  it("puts the optimistic order back from disk when a move fails", async () => {
    const useApp = await freshStore();
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck, selected: "intro" });
    backend({
      reorder_slides: () => {
        throw "The slides changed while reordering; try again.";
      },
      load_deck: () => deck,
    });
    await useApp.getState().moveSlides(1);
    expect(useApp.getState().deck).toEqual(deck);
    expect(lastError(useApp.getState())).toBe("The slides changed while reordering; try again.");
  });

  it("does not move past the end, or while a search shows only some slides", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    await useApp.getState().moveSlides(-1);
    useApp.getState().setSearch({ query: "x" });
    useApp.getState().setSearchMatches([]);
    await useApp.getState().moveSlides(1);
    expect(calls("reorder_slides")).toEqual([]);
  });

  it("forgets picked slides that are gone", async () => {
    const useApp = await freshStore();
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck, selected: "intro", railSelected: ["intro", "gone"] });
    useApp.getState().setDeck(deckFor(DECK_HTML, "2"));
    expect(useApp.getState().railSelected).toEqual(["intro"]);
  });

  it("deletes nothing when all that was asked for is locked", async () => {
    const useApp = await freshStore();
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck: { ...deck, slides: deck.slides.map((s) => ({ ...s, locked: true })) } });
    await useApp.getState().deleteSlides(["intro"]);
    expect(calls("delete_slides")).toEqual([]);
  });
});

describe("the slide clipboard", () => {
  async function storeWith(deck: Deck) {
    const useApp = await freshStore();
    useApp.setState({ deck, selected: "intro" });
    return useApp;
  }
  const pasted = (deck: Deck, created: string[]) => ({ deck, previous: "<old>", source: "<new>", created });
  const withSlides = (...ids: string[]): Deck => ({ ...DECK, slides: ids.map((id) => ({ ...DECK.slides[0]!, id })) });

  it("copies the selected slide, says so, and pastes one from the clipboard after it", async () => {
    const useApp = await storeWith(DECK);
    const next = withSlides("intro", "pasted", "#2", "outro");
    backend({ paste_slides: () => pasted(next, ["pasted"]) });
    expect(await useApp.getState().copySlides()).toBe(true);
    expect(calls("copy_slides")).toEqual([{ id: DECK.id, slides: ["intro"] }]);
    expect(toastTexts(useApp.getState(), "success")).toEqual(["1 slide copied"]);
    expect(await useApp.getState().pasteSlides()).toBe(true);
    expect(calls("paste_slides")).toEqual([{ id: DECK.id, after: "intro" }]);
    expect(useApp.getState()).toMatchObject({ deck: next, selected: "pasted", railSelected: [] });

    backend({ paste_slides: () => null });
    expect(await useApp.getState().pasteSlides()).toBe(false);
    expect(useApp.getState().selected).toBe("pasted");
  });

  it("copies every picked slide, in deck order whatever order they were picked in", async () => {
    const useApp = await storeWith(DECK);
    useApp.setState({ selected: "outro", railSelected: ["outro", "intro"] });
    await useApp.getState().copySlides();
    expect(calls("copy_slides")).toEqual([{ id: DECK.id, slides: ["intro", "outro"] }]);
    expect(toastTexts(useApp.getState(), "success")).toEqual(["2 slides copied"]);
  });

  it("picks all the slides a paste brought in, with the last of them on the stage", async () => {
    const useApp = await storeWith(DECK);
    const next = withSlides("intro", "a", "b", "#2", "outro");
    backend({ paste_slides: () => pasted(next, ["a", "b"]) });
    expect(await useApp.getState().pasteSlides()).toBe(true);
    expect(useApp.getState()).toMatchObject({ selected: "b", railSelected: ["a", "b"] });
  });

  it("cuts the picked slides that are not locked: copies them, deletes them, and offers to take it back", async () => {
    const deck = { ...DECK, slides: DECK.slides.map((s) => ({ ...s, locked: s.id === "#2" })) };
    const useApp = await storeWith(deck);
    useApp.setState({ railSelected: ["intro", "#2", "outro"] });
    const left = withSlides("#2");
    backend({ delete_slides: () => pasted(left, []) });
    await useApp.getState().cutSlides();
    expect(calls("copy_slides")).toEqual([{ id: DECK.id, slides: ["intro", "outro"] }]);
    expect(calls("delete_slides")).toEqual([{ id: DECK.id, slides: ["intro", "outro"] }]);
    expect(useApp.getState().toasts.at(-1)).toMatchObject({ kind: "success", text: "Cut 2 slides" });
    expect(useApp.getState().toasts.at(-1)!.action!.label).toBe("Undo");
  });

  it("deletes nothing when the slides could not be copied for a cut", async () => {
    const useApp = await storeWith(DECK);
    backend({
      copy_slides: () => {
        throw "could not copy";
      },
    });
    await useApp.getState().cutSlides();
    expect(calls("delete_slides")).toEqual([]);
    expect(lastError(useApp.getState())).toBe("could not copy");
  });

  it("pastes at the end without a selection, and reports failures", async () => {
    const useApp = await storeWith(DECK);
    useApp.setState({ selected: null });
    expect(await useApp.getState().copySlides()).toBe(false);
    expect(calls("copy_slides")).toEqual([]);
    backend({
      paste_slides: () => {
        throw "The clipboard holds no slide.";
      },
    });
    expect(await useApp.getState().pasteSlides()).toBe(false);
    expect(calls("paste_slides")).toEqual([{ id: DECK.id, after: null }]);
    expect(lastError(useApp.getState())).toBe("The clipboard holds no slide.");
  });
});

describe("what the rail says after it took something away", () => {
  const edit = (deck: Deck) => ({ deck, previous: "<old>", source: "<new>", created: [] });
  const without = (...gone: string[]): Deck => ({ ...DECK, slides: DECK.slides.filter((s) => !gone.includes(s.id)) });

  it("says how many slides were deleted, and its Undo takes the deletion back", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro" });
    backend({
      delete_slides: () => edit(without("intro", "outro")),
      deck_history: () => historyStatus(historyEntry("Delete slides", "rail")),
      undo_deck: () => ({ deck: DECK, entry: historyEntry("Delete slides", "rail"), status: historyStatus() }),
    });
    await useApp.getState().deleteSlides(["intro", "outro"]);
    const toast = useApp.getState().toasts.at(-1)!;
    expect(toast).toMatchObject({ kind: "success", text: "Deleted 2 slides" });
    toast.action!.run();
    await vi.waitFor(() => expect(calls("undo_deck")).toHaveLength(1));
    await vi.waitFor(() => expect(useApp.getState().deck).toEqual(DECK));
  });

  it("does not undo something else when the deck changed since the deletion", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro" });
    backend({
      delete_slides: () => edit(without("intro")),
      deck_history: () => historyStatus(historyEntry("Edit slide")),
    });
    await useApp.getState().deleteSlides(["intro"]);
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Deleted 1 slide"]);
    useApp.getState().toasts.at(-1)!.action!.run();
    await vi.waitFor(() => expect(lastError(useApp.getState())).toContain("cannot be undone"));
    expect(calls("undo_deck")).toEqual([]);
  });

  it("says nothing when the deletion failed", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro" });
    backend({
      delete_slides: () => {
        throw "disk full";
      },
      load_deck: () => DECK,
    });
    await useApp.getState().deleteSlides(["intro"]);
    expect(toastTexts(useApp.getState(), "success")).toEqual([]);
    expect(lastError(useApp.getState())).toBe("disk full");
  });

  it("names the section it removed, whose slides stay, with an Undo", async () => {
    const useApp = await freshStore();
    const deck = { ...DECK, sections: [{ index: 0, title: "Opening", before: 0 }] };
    useApp.setState({ deck, selected: "intro" });
    backend({
      delete_section: () => DECK,
      deck_history: () => historyStatus(historyEntry("Delete section", "rail")),
      undo_deck: () => ({ deck, entry: null, status: historyStatus() }),
    });
    await useApp.getState().removeSection(0);
    expect(calls("delete_section")).toEqual([{ id: DECK.id, index: 0 }]);
    const toast = useApp.getState().toasts.at(-1)!;
    expect(toast.text).toBe("Removed the section “Opening”; its slides stay");
    toast.action!.run();
    await vi.waitFor(() => expect(calls("undo_deck")).toHaveLength(1));
  });
});

describe("going through the slides", () => {
  const found = (slide: string, index: number) => ({
    slide,
    index,
    locked: false,
    notes: false,
    before: "",
    text: "x",
    after: "",
  });
  const five: Deck = { ...DECK, slides: ["a", "b", "c", "d", "e"].map((id) => ({ ...DECK.slides[0]!, id })) };
  async function searching(selected: string, ...matches: [string, number][]) {
    const useApp = await freshStore();
    useApp.setState({ deck: five, selected });
    useApp.getState().setSearch({ query: "x" });
    useApp.getState().setSearchMatches(matches.map(([slide, index]) => found(slide, index)));
    return useApp;
  }

  it("steps through the slides a search found, the ones the rail lists, and stops at their ends", async () => {
    const useApp = await searching("b", ["b", 1], ["b", 1], ["d", 3], ["e", 4]);
    useApp.getState().selectRelative(1);
    expect(useApp.getState().selected).toBe("d");
    useApp.getState().selectRelative(1);
    useApp.getState().selectRelative(1);
    expect(useApp.getState().selected).toBe("e");
    useApp.getState().selectRelative(-1);
    useApp.getState().selectRelative(-1);
    useApp.getState().selectRelative(-1);
    expect(useApp.getState().selected).toBe("b");
  });

  it("goes from a slide without a match to the nearest one with, that way, or stays", async () => {
    const useApp = await searching("c", ["b", 1], ["e", 4]);
    useApp.getState().selectRelative(1);
    expect(useApp.getState().selected).toBe("e");
    useApp.getState().select("c");
    useApp.getState().selectRelative(-1);
    expect(useApp.getState().selected).toBe("b");
    useApp.getState().select("a");
    useApp.getState().selectRelative(-1);
    expect(useApp.getState().selected).toBe("a");
  });

  it("steps through every slide when the search found nothing, as the rail then lists none", async () => {
    const useApp = await searching("b");
    useApp.getState().selectRelative(1);
    expect(useApp.getState().selected).toBe("c");
  });

  it("goes to the first and the last slide, of those a search found while one is on", async () => {
    const useApp = await searching("c", ["b", 1], ["d", 3]);
    useApp.getState().selectEdge("last");
    expect(useApp.getState().selected).toBe("d");
    useApp.getState().selectEdge("first");
    expect(useApp.getState().selected).toBe("b");
    useApp.getState().clearSearch();
    useApp.getState().selectEdge("last");
    expect(useApp.getState().selected).toBe("e");
    useApp.getState().selectEdge("first");
    expect(useApp.getState().selected).toBe("a");
  });

  it("picks every slide the rail lists, keeping the one shown where it is among them", async () => {
    const useApp = await searching("d", ["b", 1], ["d", 3]);
    useApp.getState().selectAllSlides();
    expect(useApp.getState()).toMatchObject({ selected: "d", railSelected: ["b", "d"] });
    useApp.getState().clearSearch();
    useApp.getState().selectAllSlides();
    expect(useApp.getState().railSelected).toEqual(["a", "b", "c", "d", "e"]);
    // Picking slides the one shown is not among shows the first of them.
    useApp.getState().pickSlides(["a", "b"]);
    expect(useApp.getState()).toMatchObject({ selected: "a", railSelected: ["a", "b"] });
    useApp.getState().pickSlides(["c"]);
    expect(useApp.getState()).toMatchObject({ selected: "c", railSelected: [] });
  });
});

describe("the rail's other changes", () => {
  it("adds a blank slide after the selected one, or after the one named, and selects it", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro" });
    const next = { ...DECK, slides: [...DECK.slides, { ...DECK.slides[0]!, id: "slide" }] };
    backend({ add_slide: () => ({ deck: next, slide: "slide" }) });
    await useApp.getState().addSlide();
    expect(calls("add_slide")).toEqual([{ id: DECK.id, after: "intro" }]);
    expect(useApp.getState().selected).toBe("slide");
    await useApp.getState().addSlide("outro");
    expect(calls("add_slide").at(-1)).toEqual({ id: DECK.id, after: "outro" });
  });

  it("locks several slides as one change", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro" });
    const locked = { ...DECK, slides: DECK.slides.map((s) => ({ ...s, locked: true })) };
    backend({ set_slides_locked: () => locked });
    await useApp.getState().setSlidesLocked(["intro", "outro"], true);
    expect(calls("set_slides_locked")).toEqual([{ id: DECK.id, slides: ["intro", "outro"], locked: true }]);
    expect(useApp.getState().deck).toEqual(locked);
    await useApp.getState().setSlidesLocked([], true);
    expect(calls("set_slides_locked")).toHaveLength(1);
  });

  it("starts a section at a slide and says which one it made, for naming it", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro" });
    const next = { ...DECK, sections: [{ index: 0, title: "New section", before: 2 }] };
    backend({ add_section: () => next });
    expect(await useApp.getState().startSection("outro")).toBe(0);
    expect(calls("add_section")).toEqual([{ id: DECK.id, before: "outro", title: "New section" }]);
    expect(await useApp.getState().startSection("gone")).toBeNull();
  });

  it("remembers each deck's folded sections between launches", async () => {
    localStorage.clear();
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro" });
    useApp.getState().toggleSection("intro");
    useApp.getState().setSectionsCollapsed(["outro"], true);
    expect(useApp.getState().collapsedSections).toEqual(["intro", "outro"]);
    expect(railStateOf(DECK.id).collapsedSections).toEqual(["intro", "outro"]);
    expect(railStateOf("/other/deck.html").collapsedSections).toEqual([]);

    backend({
      open_workspace: () => ({ path: "/decks/talk", name: "talk" }),
      open_deck: () => DECK,
      load_chat: () => [],
      agent_running: () => false,
    });
    const again = await freshStore();
    await again.getState().openDeck(DECK.id);
    expect(again.getState().collapsedSections).toEqual(["intro", "outro"]);
    again.getState().setSectionsCollapsed([], false);
    expect(again.getState().collapsedSections).toEqual([]);
    expect(railStateOf(DECK.id).collapsedSections).toEqual([]);
    localStorage.clear();
  });

  it("opens a deck with nothing folded when what was remembered is no list of slides", async () => {
    localStorage.setItem("slopslide.collapsedSections", JSON.stringify({ [DECK.id]: "intro", other: [1] }));
    expect(railStateOf(DECK.id).collapsedSections).toEqual([]);
    localStorage.setItem("slopslide.collapsedSections", "not json");
    expect(railStateOf(DECK.id).collapsedSections).toEqual([]);
    localStorage.clear();
  });

  it("plays the shown slide's animations again, turning them on if the stage showed final states", async () => {
    const useApp = await freshStore();
    useApp.getState().setFinalState(true);
    const rev = useApp.getState().replayRev;
    useApp.getState().replaySlide();
    expect(useApp.getState()).toMatchObject({ finalState: false, replayRev: rev + 1 });
  });
});

describe("what a new deck leaves as it was", () => {
  const many = (count: number, changed = -1): Deck => ({
    ...DECK,
    slides: Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      hash: i === changed ? "changed" : `h${i}`,
      hidden: false,
      locked: false,
      moved: false,
    })),
  });

  it("keeps every slide but the changed one the object it was", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: many(6), selected: "s0" });
    const before = useApp.getState().deck!;
    useApp.getState().setDeck(many(6, 2));
    const { deck } = useApp.getState();
    expect(deck!.slides[3]).toBe(before.slides[3]);
    expect(deck!.slides[2]).not.toBe(before.slides[2]);
    expect(deck!.slides[2]!.hash).toBe("changed");
    expect(deck!.sections).toBe(before.sections);
  });

  it("leaves the store alone, and the deck's history unasked, for a deck that is the one shown", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: many(6), selected: "s0" });
    const before = useApp.getState();
    const told = vi.fn();
    useApp.subscribe(told);
    useApp.getState().setDeck(many(6));
    expect(useApp.getState()).toBe(before);
    expect(told).not.toHaveBeenCalled();
    expect(calls("deck_history")).toEqual([]);
    // One that changed is asked about once.
    useApp.getState().setDeck(many(6, 1));
    expect(calls("deck_history")).toHaveLength(1);
  });

  it("keeps the empty list of picks the same list from one selection to the next", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: many(6), selected: "s0" });
    const { railSelected } = useApp.getState();
    useApp.getState().select("s1");
    useApp.getState().selectRelative(1);
    useApp.getState().setDeck(many(5));
    expect(useApp.getState().railSelected).toBe(railSelected);
  });
});

describe("changes to the slides that show before the deck file has them", () => {
  /** A backend that answers `command` when the test says so. */
  function held<T>(command: string, others: Record<string, () => unknown> = {}) {
    let settle: { resolve: (value: T) => void; reject: (error: unknown) => void } | undefined;
    backend({
      ...others,
      [command]: () => new Promise<T>((resolve, reject) => (settle = { resolve, reject })),
    });
    // The change waits for the ones before it, so the backend hears of it a moment later.
    const asked = () => vi.waitFor(() => expect(settle).toBeDefined());
    return {
      resolve: async (value: T) => {
        await asked();
        settle!.resolve(value);
      },
      reject: async (error: unknown) => {
        await asked();
        settle!.reject(error);
      },
    };
  }
  const answer = (deck: Deck) => ({ deck, previous: "<0>", source: "<1>", created: [] });
  const without = (id: string): Deck => ({ ...DECK, slides: DECK.slides.filter((s) => s.id !== id) });
  const marked = (id: string, marks: { hidden?: boolean; locked?: boolean }): Deck => ({
    ...DECK,
    slides: DECK.slides.map((s) => (s.id === id ? { ...s, ...marks } : s)),
  });
  const ids = (useApp: TestStore) => useApp.getState().deck!.slides.map((s) => s.id);

  it("takes a deleted slide out at once, with the next one on the stage, and says so once it is done", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro" });
    const backend = held("delete_slides");
    const done = useApp.getState().deleteSlides(["intro"]);
    expect(ids(useApp)).toEqual(["#2", "outro"]);
    expect(useApp.getState().selected).toBe("#2");
    expect(toastTexts(useApp.getState(), "success")).toEqual([]);
    await backend.resolve(answer(without("intro")));
    await done;
    expect(ids(useApp)).toEqual(["#2", "outro"]);
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Deleted 1 slide"]);
    // The history is asked once, when the deck file has the change.
    expect(calls("deck_history")).toHaveLength(1);
  });

  it("brings a deleted slide back, on the stage again, when the deck file refused", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro" });
    const backend = held("delete_slides", { load_deck: () => DECK });
    const done = useApp.getState().deleteSlides(["intro"]);
    expect(ids(useApp)).toEqual(["#2", "outro"]);
    await backend.reject("disk full");
    await done;
    expect(ids(useApp)).toEqual(["intro", "#2", "outro"]);
    expect(useApp.getState().selected).toBe("intro");
    expect(lastError(useApp.getState())).toBe("disk full");
    expect(toastTexts(useApp.getState(), "success")).toEqual([]);
  });

  it("goes back to the deck as it was when the deck file cannot be read either", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "outro" });
    const backend = held("delete_slides", {
      load_deck: () => {
        throw "gone";
      },
    });
    const done = useApp.getState().deleteSlides(["intro"]);
    await backend.reject("disk full");
    await done;
    expect(useApp.getState().deck).toEqual(DECK);
    expect(lastError(useApp.getState())).toBe("disk full");
  });

  it.each([
    ["hides", "set_slides_hidden", { hidden: true }, (deck: Deck) => answer(deck)],
    ["locks", "set_slides_locked", { locked: true }, (deck: Deck) => deck],
  ] as const)(
    "%s a slide at once, and takes it back when the deck file refused",
    async (_, command, marks, answered) => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "intro" });
      const change = () =>
        "hidden" in marks
          ? useApp.getState().setSlidesHidden(["#2"], true)
          : useApp.getState().setSlidesLocked(["#2"], true);
      const slide = () => useApp.getState().deck!.slides[1]!;

      const first = held(command);
      const done = change();
      expect(slide()).toMatchObject(marks);
      // The slides that did not change are the objects they were.
      expect(useApp.getState().deck!.slides[0]).toBe(DECK.slides[0]);
      await first.resolve(answered(marked("#2", marks)));
      await done;
      expect(slide()).toMatchObject(marks);
      expect(calls("deck_history")).toHaveLength(1);

      useApp.setState({ deck: DECK });
      const second = held(command, { load_deck: () => DECK });
      const failed = change();
      expect(slide()).toMatchObject(marks);
      await second.reject("disk full");
      await failed;
      expect(slide()).toMatchObject({ hidden: false, locked: false });
      expect(lastError(useApp.getState())).toBe("disk full");
    },
  );

  it("keeps a deleted slide out of a deck that arrives before the deletion was made", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "outro" });
    const backend = held("delete_slides");
    const done = useApp.getState().deleteSlides(["intro"]);
    // A slide edit saved before it, or the deck file read again: the file still has the slide.
    useApp.getState().setDeck(deckFor(DECK_HTML, "2"));
    expect(ids(useApp)).toEqual(["#2", "outro"]);
    expect(useApp.getState().deck!.slides[0]!.hash).toBe("#2-2");
    await backend.resolve(answer({ ...deckFor(DECK_HTML, "2"), slides: deckFor(DECK_HTML, "2").slides.slice(1) }));
    await done;
    // Once made, nothing is held back from the decks that follow.
    useApp.getState().setDeck(deckFor(DECK_HTML, "3"));
    expect(ids(useApp)).toEqual(["intro", "#2", "outro"]);
  });

  it("asks the deck's history once for a move, when the deck file has it", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro" });
    const moved = { ...DECK, slides: [DECK.slides[1]!, DECK.slides[0]!, DECK.slides[2]!] };
    const backend = held("reorder_slides");
    const done = useApp.getState().moveSlides(1);
    expect(ids(useApp)).toEqual(["#2", "intro", "outro"]);
    expect(calls("deck_history")).toEqual([]);
    await backend.resolve(answer(moved));
    await done;
    expect(calls("deck_history")).toHaveLength(1);
  });
});
