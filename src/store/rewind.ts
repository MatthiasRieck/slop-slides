import { api, type HistoryEntry } from "../lib/api";
import { loadText, saveText } from "../lib/storage";
import { showErrorIn } from "./errors";
import { persistChat } from "./messages";
import { quoteLabel, rewindNote } from "./prompts";
import type { AppStore, Slice } from "./types";

/** How the chat follows when the deck changes of an agent turn are undone (see `answerRewind`). */
export type RewindChoice = "rewind" | "deck";
/** The answer to keep giving, once the user asked not to be asked again. */
export const REWIND_KEY = "slopslide.rewindChoice";

/** The answer kept under `REWIND_KEY`; null while the user wants to be asked. */
export function rememberedRewind(): RewindChoice | null {
  const saved = loadText(REWIND_KEY);
  return saved === "rewind" || saved === "deck" ? saved : null;
}

/** Keeps giving `choice` from now on; null asks again. Throws when storage is full or unavailable. */
export function rememberRewind(choice: RewindChoice | null) {
  saveText(REWIND_KEY, choice);
}

/** The chat following the deck's history: an undone agent turn takes the chat back, or the agent is told. */
export interface RewindSlice {
  /** An undone agent turn whose message is still in the chat, while asking whether to rewind the chat too. */
  rewindAsk: HistoryEntry | null;
  /** Agent turns whose deck changes the user undid; the next message tells the agent. */
  revertNotes: { message: string; label: string }[];

  /**
   * Answers `rewindAsk`: also take the chat back to before the turn's message, keep the chat and
   * tell the agent with the next message, or (null) leave the chat alone. `remember` keeps the
   * answer for next time.
   */
  answerRewind: (choice: RewindChoice | null, remember?: boolean) => Promise<void>;
  /** Stops telling the agent that the changes of the turn of `message` were undone. */
  dropRevertNote: (message: string) => void;
}

export const createRewindSlice: Slice<RewindSlice> = (set, get, app) => ({
  rewindAsk: null,
  revertNotes: [],

  answerRewind: async (choice, remember = false) => {
    const entry = get().rewindAsk;
    set({ rewindAsk: null });
    if (!entry || !choice) return;
    if (remember) rememberRewind(choice);
    await applyRewind(app, entry, choice);
  },

  dropRevertNote: (message) => set((s) => ({ revertNotes: s.revertNotes.filter((n) => n.message !== message) })),
});

/** The deck changes of an agent turn were undone: asks whether the chat follows, unless told before. */
export function turnUndone(app: AppStore, entry: HistoryEntry) {
  const message = app.getState().messages.find((m) => m.id === entry.message);
  if (message?.role !== "user" || message.reverted) return;
  const remembered = rememberedRewind();
  if (remembered) void applyRewind(app, entry, remembered);
  else app.setState({ rewindAsk: entry });
}

/** Redoing an agent turn kept in the chat takes back what undoing it told the agent. */
export function turnRedone(app: AppStore, entry: HistoryEntry) {
  app.setState((s) => ({
    messages: s.messages.map((m) => (m.id === entry.message && m.role === "user" ? { ...m, reverted: false } : m)),
    revertNotes: s.revertNotes.filter((n) => n.message !== entry.message),
    rewindAsk: s.rewindAsk?.id === entry.id ? null : s.rewindAsk,
  }));
  persistChat(app);
}

/**
 * Follows an undone agent turn in the chat: takes the chat back to before its message (which
 * goes back into the composer), or keeps it, marked, and tells the agent with the next message.
 */
async function applyRewind(app: AppStore, entry: HistoryEntry, choice: RewindChoice) {
  const { workspace, messages } = app.getState();
  const index = messages.findIndex((m) => m.id === entry.message);
  const message = messages[index];
  if (!workspace || message?.role !== "user") return;
  const label = quoteLabel(message.text);
  if (choice === "deck") {
    app.setState((s) => ({
      messages: s.messages.map((m) => (m.id === message.id ? { ...message, reverted: true } : m)),
      revertNotes: [...s.revertNotes.filter((n) => n.message !== message.id), { message: message.id, label }],
    }));
    persistChat(app);
    return;
  }
  const kept = new Set(messages.slice(0, index).map((m) => m.id));
  app.setState((s) => ({
    messages: s.messages.slice(0, index),
    revertNotes: s.revertNotes.filter((n) => kept.has(n.message)),
    chatRevision: s.chatRevision + 1,
  }));
  app.getState().fillComposer(message.text);
  persistChat(app);
  try {
    await api.rewindChat(workspace.path, message.id, rewindNote(label));
  } catch (error) {
    showErrorIn(app, error);
  }
}
