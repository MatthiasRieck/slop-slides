import { beforeEach, describe, expect, it } from "vitest";

import { DECK_HTML, deckFor } from "../test/fixtures";
import type { UserMessage } from "./messages";
import { REWIND_KEY, rememberedRewind, rememberRewind } from "./rewind";
import { backend, calls, freshStore, historyEntry, historyStatus, resetBackend } from "./testing";

beforeEach(resetBackend);

describe("the chat following an undone agent turn", () => {
  const entry = historyEntry;
  const status = historyStatus;
  const user = (id: string, text: string): UserMessage => ({
    id,
    role: "user",
    text,
    slide: null,
    attachments: [],
    createdAt: 0,
  });

  beforeEach(() => localStorage.removeItem("slopslide.rewindChoice"));

  async function undoneTurn() {
    const useApp = await freshStore();
    useApp.setState({
      deck: deckFor(DECK_HTML),
      selected: "intro",
      messages: [user("m0", "First"), user("m1", "Make   the title\nbigger")],
      rewindAsk: null,
      revertNotes: [],
    });
    const turn = entry("Make the title bigger", "chat", "m1");
    backend({
      undo_deck: () => ({ deck: deckFor(DECK_HTML), entry: turn, status: status(null, turn) }),
      redo_deck: () => ({ deck: deckFor(DECK_HTML), entry: turn, status: status(turn) }),
    });
    await useApp.getState().undo();
    return { useApp, turn };
  }

  it("asks whether the chat goes back too", async () => {
    const { useApp, turn } = await undoneTurn();
    expect(useApp.getState().rewindAsk).toEqual(turn);
    await useApp.getState().answerRewind(null);
    expect(useApp.getState().rewindAsk).toBeNull();
    expect(useApp.getState().messages).toHaveLength(2);
    expect(calls("rewind_chat")).toEqual([]);
  });

  it("rewinding takes the chat back to before the message, which goes back into the composer", async () => {
    const { useApp } = await undoneTurn();
    await useApp.getState().answerRewind("rewind");
    expect(useApp.getState().messages.map((m) => m.id)).toEqual(["m0"]);
    expect(useApp.getState().composerFill?.text).toBe("Make   the title\nbigger");
    expect(calls("rewind_chat")).toEqual([
      { id: "/decks/talk", message: "m1", note: expect.stringContaining('message "Make the title bigger"') },
    ]);
    expect(calls("save_chat").at(-1)).toMatchObject({ chat: [expect.objectContaining({ id: "m0" })] });
  });

  it("rewinding puts the message back with what went along with it", async () => {
    const useApp = await freshStore();
    const sent: UserMessage = {
      ...user("m1", "Bigger"),
      slide: "outro",
      slides: ["intro"],
      attachments: ["assets/a.png"],
      screenshot: "/s/shot.png",
    };
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", messages: [sent], rewindAsk: null });
    const turn = entry("Bigger", "chat", "m1");
    backend({ undo_deck: () => ({ deck: deckFor(DECK_HTML), entry: turn, status: status(null, turn) }) });
    await useApp.getState().undo();
    await useApp.getState().answerRewind("rewind");
    expect(useApp.getState().composerFill).toMatchObject({
      text: "Bigger",
      attachments: ["assets/a.png"],
      slides: ["intro"],
      includeSlide: true,
      screenshot: "/s/shot.png",
    });
  });

  it("keeping the chat marks the message and tells the agent with the next message", async () => {
    const { useApp } = await undoneTurn();
    await useApp.getState().answerRewind("deck");
    const kept = useApp.getState().messages[1] as UserMessage;
    expect(kept.reverted).toBe(true);
    expect(useApp.getState().revertNotes).toEqual([{ message: "m1", label: '"Make the title bigger"' }]);
    backend({});
    await useApp.getState().send("Next", { includeSlide: false, attachments: [] });
    const { prompt } = calls("send_message")[0]!.args as { prompt: string };
    expect(prompt).toMatch(/^\[note\]The user undid the changes your turn for the message "Make the title bigger"/);
    expect(prompt.endsWith("Next")).toBe(true);
    expect(useApp.getState().revertNotes).toEqual([]);
  });

  it("the note can be left out", async () => {
    const { useApp } = await undoneTurn();
    await useApp.getState().answerRewind("deck");
    useApp.getState().dropRevertNote("m1");
    expect(useApp.getState().revertNotes).toEqual([]);
  });

  it("redoing a kept turn takes the note back", async () => {
    const { useApp } = await undoneTurn();
    await useApp.getState().answerRewind("deck");
    await useApp.getState().redo();
    expect((useApp.getState().messages[1] as UserMessage).reverted).toBe(false);
    expect(useApp.getState().revertNotes).toEqual([]);
  });

  it("remembers the answer when asked to, and asks no more", async () => {
    const { useApp } = await undoneTurn();
    await useApp.getState().answerRewind("deck", true);
    expect(localStorage.getItem("slopslide.rewindChoice")).toBe("deck");
    await useApp.getState().redo();
    await useApp.getState().undo();
    expect(useApp.getState().rewindAsk).toBeNull();
    expect((useApp.getState().messages[1] as UserMessage).reverted).toBe(true);
  });

  it("asks nothing for a turn whose message is no longer in the chat", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", messages: [], rewindAsk: null });
    const turn = entry("Gone", "chat", "m9");
    backend({ undo_deck: () => ({ deck: deckFor(DECK_HTML), entry: turn, status: status() }) });
    await useApp.getState().undo();
    expect(useApp.getState().rewindAsk).toBeNull();
  });
});

describe("the remembered rewind answer", () => {
  beforeEach(() => localStorage.removeItem(REWIND_KEY));

  it("is kept until asked again, and only a known answer counts", () => {
    expect(rememberedRewind()).toBeNull();
    rememberRewind("rewind");
    expect(rememberedRewind()).toBe("rewind");
    rememberRewind(null);
    expect(localStorage.getItem(REWIND_KEY)).toBeNull();
    localStorage.setItem(REWIND_KEY, "always");
    expect(rememberedRewind()).toBeNull();
  });
});
