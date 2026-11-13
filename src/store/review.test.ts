import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "../test/tauri";
import { lastError } from "./errors";
import { backend, calls, DECK, freshModule, freshStore, resetBackend } from "./testing";

beforeEach(resetBackend);

describe("review", () => {
  it("clearSketch and setSketches edit ink per slide", async () => {
    const useApp = await freshStore();
    const ink = [{ tool: "pen" as const, color: "#fff", points: [[0, 0]] as [number, number][] }];
    useApp.getState().setSketches((all) => ({ ...all, a: ink, b: ink }));
    useApp.getState().clearSketch("a");
    useApp.getState().clearSketch("missing");
    expect(useApp.getState().sketches).toEqual({ b: ink });
  });

  describe("review marks", () => {
    const ink = [{ tool: "pen" as const, color: "#fff", points: [[0.5, 0.5]] as [number, number][] }];

    afterEach(() => {
      vi.useRealTimers();
    });

    it("are saved to deck.html once drawing pauses, without empty slides", async () => {
      vi.useFakeTimers();
      const useApp = await freshStore();
      useApp.setState({ deck: DECK });
      useApp.getState().setSketches((all) => ({ ...all, intro: ink }));
      useApp.getState().setSketches((all) => ({ ...all, outro: ink }));
      useApp.getState().clearSketch("outro");
      useApp.getState().setSketches((all) => ({ ...all, "#2": [] }));
      await vi.advanceTimersByTimeAsync(300);
      expect(calls("save_review")).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      expect(calls("save_review")).toEqual([{ id: "/decks/talk/deck.html", review: { intro: ink } }]);
    });

    it("are saved right away when the deck closes", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK });
      useApp.getState().setSketches(() => ({ intro: ink }));
      let deckWhenSaved: unknown = "not saved";
      invoke.mockImplementation(async (command: string) => {
        if (command === "save_review") deckWhenSaved = useApp.getState().deck;
      });
      await useApp.getState().closeDeck();
      expect(calls("save_review")).toEqual([{ id: "/decks/talk/deck.html", review: { intro: ink } }]);
      expect(deckWhenSaved).toBe(DECK);
      expect(useApp.getState().deck).toBeNull();
    });

    it("are not saved when they end up as the file has them", async () => {
      const { useApp, flushReviewSave } = await freshModule();
      useApp.setState({ deck: DECK });
      useApp.getState().setSketches(() => ({ intro: ink }));
      useApp.getState().clearSketch("intro");
      await flushReviewSave();
      expect(calls("save_review")).toEqual([]);
    });

    it("report a failed save", async () => {
      const { useApp, flushReviewSave } = await freshModule();
      backend({
        save_review: () => {
          throw "disk full";
        },
      });
      useApp.setState({ deck: DECK });
      useApp.getState().setSketches(() => ({ intro: ink }));
      await flushReviewSave();
      expect(lastError(useApp.getState())).toBe("Could not save the review marks and comments: disk full");
    });

    it("are loaded with the deck", async () => {
      const useApp = await freshStore();
      backend({
        open_deck: () => ({ ...DECK, review: { intro: ink } }),
        load_chat: () => [],
        agent_running: () => false,
      });
      await useApp.getState().openDeck("/decks/talk/deck.html");
      expect(useApp.getState().sketches).toEqual({ intro: ink });
    });
  });
});

describe("the list of comments", () => {
  const comment = (id: string, text: string) => ({ id, text, x: 0.5, y: 0.5 });

  it("goes to a comment's slide with the review on show, and asks the stage to open it once", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro", comments: { outro: [comment("c", "Thanks")] } });
    useApp.getState().setReviewVisible(false);
    useApp.getState().showComment("outro", "c");
    expect(useApp.getState()).toMatchObject({
      selected: "outro",
      reviewVisible: true,
      commentAsked: { slide: "outro", id: "c" },
    });
    useApp.getState().commentShown();
    expect(useApp.getState().commentAsked).toBeNull();
  });

  it("has the next message take every comment of the deck, those left out before too", async () => {
    const useApp = await freshStore();
    useApp.setState({
      deck: DECK,
      selected: "intro",
      comments: { intro: [comment("a", "One")], outro: [comment("b", "Two")] },
      commentsHeld: { b: "Two" },
      commentScope: "slide",
    });
    useApp.getState().takeAllComments();
    expect(useApp.getState()).toMatchObject({ commentScope: "deck", commentsHeld: {}, reviewVisible: true });
  });
});
