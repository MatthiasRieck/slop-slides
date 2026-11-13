import { beforeEach, describe, expect, it, vi } from "vitest";

import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { lastError } from "./errors";
import { backend, calls, DECK, freshStore, resetBackend } from "./testing";

beforeEach(resetBackend);

describe("what is said over the slides", () => {
  it("saves a slide's narration after any slide edits still being saved", async () => {
    const useApp = await freshStore();
    backend({
      update_slide: () => deckFor(DECK_HTML, "2"),
      set_slide_narration: ({ slide, text }) => {
        const deck = deckFor(DECK_HTML, "3");
        return { ...deck, slides: deck.slides.map((s) => (s.id === slide ? { ...s, narration: text } : s)) };
      },
    });
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    const edit = useApp.getState().saveSlideEdit("intro", "<section></section>");
    const narration = useApp.getState().setNarration("intro", "Welcome, everyone.");
    await Promise.all([edit, narration]);
    expect(invoke.mock.calls.map(([c]) => c).filter((c) => c !== "deck_history")).toEqual([
      "update_slide",
      "set_slide_narration",
    ]);
    expect(calls("set_slide_narration")).toEqual([
      { id: "/decks/talk/deck.html", slide: "intro", text: "Welcome, everyone." },
    ]);
    expect(useApp.getState().deck!.slides[0]).toMatchObject({ hash: "intro-3", narration: "Welcome, everyone." });
  });

  it("reports a narration that could not be saved", async () => {
    const useApp = await freshStore();
    backend({
      set_slide_narration: () => {
        throw "The slide `intro` is locked; unlock it to change it.";
      },
    });
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", toasts: [] });
    await useApp.getState().setNarration("intro", "Hi");
    expect(lastError(useApp.getState())).toContain("locked");
  });

  it("saves speaker notes after edits still being saved, and shows the deck", async () => {
    const useApp = await freshStore();
    const next = deckFor(DECK_HTML, "noted");
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", slideMode: "view" });
    backend({ set_slide_notes: () => next });
    await useApp.getState().setNotes("intro", "Pause here");
    expect(calls("set_slide_notes")).toEqual([{ id: DECK.id, slide: "intro", text: "Pause here" }]);
    expect(useApp.getState().deck).toBe(next);
  });
});

describe("cleaning up recorded narration", () => {
  it("fills the composer with the request and leaves sending it to the user", async () => {
    const useApp = await freshStore();
    const fillComposer = vi.fn();
    useApp.setState({ fillComposer, sidebarOpen: true, sidebarTab: "chat" });
    useApp.getState().cleanNarration("intro");
    expect(fillComposer.mock.calls[0]?.[0]).toContain("the narration of slide `intro`");
  });
});
