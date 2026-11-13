import { beforeEach, describe, expect, it } from "vitest";

import type { Deck } from "../lib/api";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { lastError } from "./errors";
import { backend, calls, DECK, freshStore, resetBackend, type TestStore } from "./testing";

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
    expect(useApp.getState().deck).toBe(deck);
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
    useApp.getState().setDeck(deck);
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

  it("copies the selected slide and pastes one from the clipboard after it", async () => {
    const useApp = await storeWith(DECK);
    const next = {
      ...DECK,
      slides: [DECK.slides[0], { ...DECK.slides[0], id: "pasted" }, ...DECK.slides.slice(1)],
    };
    backend({ paste_slide: () => ({ deck: next, slide: "pasted" }) });
    await useApp.getState().copySlide();
    expect(calls("copy_slide")).toEqual([{ id: DECK.id, slide: "intro" }]);
    expect(await useApp.getState().pasteSlide()).toBe(true);
    expect(calls("paste_slide")).toEqual([{ id: DECK.id, after: "intro" }]);
    expect(useApp.getState()).toMatchObject({ deck: next, selected: "pasted" });

    backend({ paste_slide: () => null });
    expect(await useApp.getState().pasteSlide()).toBe(false);
    expect(useApp.getState().selected).toBe("pasted");
  });

  it("pastes a slide at the end without a selection, and reports failures", async () => {
    const useApp = await storeWith(DECK);
    useApp.setState({ selected: null });
    await useApp.getState().copySlide();
    expect(calls("copy_slide")).toEqual([]);
    backend({
      paste_slide: () => {
        throw "The clipboard holds no slide.";
      },
    });
    expect(await useApp.getState().pasteSlide()).toBe(false);
    expect(calls("paste_slide")).toEqual([{ id: DECK.id, after: null }]);
    expect(lastError(useApp.getState())).toBe("The clipboard holds no slide.");
  });
});
