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

  it("places the deck's comments once, however often they are asked for", async () => {
    const { useApp, commentsInScope, commentsToSend, deckComments, hasComments, hasReview } = await freshModule();
    useApp.setState({
      deck: DECK,
      selected: "intro",
      comments: { intro: [comment("a", "One")], outro: [comment("b", "Two")], gone: [comment("c", "Lost")] },
      commentsHeld: { a: "One" },
      commentScope: "deck",
      reviewVisible: true,
    });
    const all = deckComments(useApp.getState());
    expect(all.map((c) => [c.id, c.slideNumber])).toEqual([
      ["a", 1],
      ["b", 3],
    ]);
    // Another part of the store changing leaves the lists as they are: the very same ones.
    useApp.getState().setCommentTexts(true);
    expect(deckComments(useApp.getState())).toBe(all);
    const inScope = commentsInScope(useApp.getState());
    expect(inScope).toEqual(all);
    expect(commentsInScope(useApp.getState())).toBe(inScope);
    expect(commentsToSend(useApp.getState())).toBe(1);

    useApp.setState({ commentScope: "slide" });
    const here = commentsInScope(useApp.getState());
    expect(here.map((c) => c.id)).toEqual(["a"]);
    expect(commentsInScope(useApp.getState())).toBe(here);
    expect(commentsToSend(useApp.getState())).toBe(0);
    useApp.getState().select("outro");
    expect(commentsInScope(useApp.getState()).map((c) => c.id)).toEqual(["b"]);

    // A comment added shows in all of them.
    useApp.getState().addComment("outro", comment("d", "Three"));
    expect(deckComments(useApp.getState()).map((c) => c.id)).toEqual(["a", "b", "d"]);
    expect(commentsToSend(useApp.getState())).toBe(2);
    useApp.getState().setReviewVisible(false);
    expect(commentsInScope(useApp.getState())).toEqual([]);
    expect(commentsToSend(useApp.getState())).toBe(0);

    expect(hasComments(useApp.getState())).toBe(true);
    expect(hasReview({ sketches: {}, comments: { intro: [] } })).toBe(false);
    expect(hasReview({ sketches: { intro: [{ tool: "pen", color: "#fff", points: [[0, 0]] }] }, comments: {} })).toBe(
      true,
    );
    expect(hasReview({ sketches: {}, comments: { intro: [comment("a", "One")] } })).toBe(true);
  });

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

  describe("sent comments", () => {
    const comments = () => ({ intro: [comment("a", "One")], outro: [comment("b", "Two")] });

    it("stay on their slides marked as sent, and do not go out again", async () => {
      const { useApp, commentsInScope, unsentComments, hasUnsentComments } = await freshModule();
      useApp.setState({
        deck: DECK,
        selected: "intro",
        comments: comments(),
        commentScope: "deck",
        reviewVisible: true,
      });
      useApp.getState().markCommentsSent([comment("a", "One")]);
      expect(useApp.getState().comments.intro).toEqual([{ ...comment("a", "One"), sent: true }]);
      expect(commentsInScope(useApp.getState()).map((c) => c.id)).toEqual(["b"]);
      expect(unsentComments(useApp.getState()).map((c) => c.id)).toEqual(["b"]);
      useApp.getState().markCommentsSent([comment("b", "Two")]);
      expect(hasUnsentComments(useApp.getState())).toBe(false);
    });

    it("go out again once changed, or when asked to", async () => {
      const { useApp, commentsInScope } = await freshModule();
      const sent = { intro: [{ ...comment("a", "One"), sent: true }], outro: [{ ...comment("b", "Two"), sent: true }] };
      useApp.setState({ deck: DECK, selected: "intro", comments: sent, commentScope: "deck", reviewVisible: true });
      useApp.getState().updateComment("intro", "a", "One, again");
      expect(useApp.getState().comments.intro).toEqual([comment("a", "One, again")]);
      useApp.setState({ commentsHeld: { b: "Two" } });
      useApp.getState().resendComment("outro", "b");
      expect(useApp.getState().comments.outro).toEqual([comment("b", "Two")]);
      expect(useApp.getState().commentsHeld).toEqual({});
      expect(commentsInScope(useApp.getState()).map((c) => c.id)).toEqual(["a", "b"]);
    });

    it("are resolved together, leaving those still to send", async () => {
      const { useApp } = await freshModule();
      useApp.setState({
        deck: DECK,
        comments: { intro: [{ ...comment("a", "One"), sent: true }, comment("c", "Three")], outro: [] },
      });
      useApp.getState().resolveSentComments();
      expect(useApp.getState().comments).toEqual({ intro: [comment("c", "Three")], outro: [] });
    });

    it("are saved as sent in the deck file", async () => {
      vi.useFakeTimers();
      const { useApp, flushReviewSave } = await freshModule();
      useApp.setState({ deck: DECK, comments: comments() });
      useApp.getState().markCommentsSent([comment("a", "One")]);
      await flushReviewSave();
      expect(calls("save_comments").at(-1)).toMatchObject({ comments: { intro: [{ id: "a", sent: true }] } });
      vi.useRealTimers();
    });
  });

  describe("choosing in the list which go out", () => {
    it("takes one of another slide along by widening to the deck, keeping the rest out", async () => {
      const { useApp, commentGoing, deckComments } = await freshModule();
      useApp.setState({
        deck: DECK,
        selected: "intro",
        comments: { intro: [comment("a", "One")], outro: [comment("b", "Two"), comment("c", "Three")] },
        commentScope: "slide",
        commentsHeld: {},
        reviewVisible: true,
      });
      const [a, b, c] = deckComments(useApp.getState());
      expect([a, b, c].map((x) => commentGoing(useApp.getState(), x!))).toEqual([true, false, false]);
      useApp.getState().setCommentGoing(b!, true);
      expect(useApp.getState().commentScope).toBe("deck");
      expect([a, b, c].map((x) => commentGoing(useApp.getState(), x!))).toEqual([true, true, false]);
      useApp.getState().setCommentGoing(a!, false);
      expect(commentGoing(useApp.getState(), a!)).toBe(false);
    });
  });
});
