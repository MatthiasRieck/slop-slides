import { beforeEach, describe, expect, it } from "vitest";

import { DECK_HTML, deckFor } from "../test/fixtures";
import type { UserMessage } from "./messages";
import { backend, calls, freshStore, historyEntry, historyStatus, resetBackend, settingsBackend } from "./testing";

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
      ...settingsBackend(),
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

  it("remembers the answer in the app's settings when asked to, and asks no more", async () => {
    const { useApp } = await undoneTurn();
    await useApp.getState().answerRewind("deck", true);
    expect(calls("update_settings")).toEqual([{ patch: { rewind: "deck" } }]);
    expect(useApp.getState().settings.rewind).toBe("deck");
    // The window's storage has no part in it any more.
    expect(localStorage.getItem("slopslide.rewindChoice")).toBeNull();
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

describe("the rewind answer the settings hold", () => {
  const turn = historyEntry("Bigger", "chat", "m1");
  const message: UserMessage = { id: "m1", role: "user", text: "Bigger", slide: null, attachments: [], createdAt: 0 };

  async function undoWith(rewind: "ask" | "rewind" | "deck") {
    const useApp = await freshStore();
    useApp.setState((s) => ({
      deck: deckFor(DECK_HTML),
      selected: "intro",
      messages: [message],
      settings: { ...s.settings, rewind },
    }));
    backend({ undo_deck: () => ({ deck: deckFor(DECK_HTML), entry: turn, status: historyStatus(null, turn) }) });
    await useApp.getState().undo();
    return useApp;
  }

  it("asks while they say to ask", async () => {
    expect((await undoWith("ask")).getState().rewindAsk).toEqual(turn);
  });

  it("is given without asking otherwise", async () => {
    const kept = await undoWith("deck");
    expect(kept.getState().rewindAsk).toBeNull();
    expect((kept.getState().messages[0] as UserMessage).reverted).toBe(true);
    const rewound = await undoWith("rewind");
    expect(rewound.getState().rewindAsk).toBeNull();
    expect(rewound.getState().messages).toEqual([]);
  });

  it("is not read from what storage held before the settings had it", async () => {
    localStorage.setItem("slopslide.rewindChoice", "deck");
    expect((await undoWith("ask")).getState().rewindAsk).toEqual(turn);
  });
});
