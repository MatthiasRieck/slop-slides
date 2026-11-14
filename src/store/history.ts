import { api, type DeckHistory } from "../lib/api";
import { editsSaved, queueEdit } from "./editQueue";
import { showErrorIn } from "./errors";
import { adoptReview, flushReview } from "./review";
import { turnRedone, turnUndone } from "./rewind";
import type { AppStore, Slice } from "./types";

/** Undo and redo of the open deck. */
export interface HistorySlice {
  /**
   * What undo and redo would do in the open deck: its one history of every change, whatever
   * made it (see src-tauri/src/history.rs). Null until known.
   */
  history: DeckHistory | null;

  /** Takes back the deck's newest change, whatever made it: an edit, the rail, the agent, … */
  undo: () => Promise<void>;
  /** Makes the change undone last again. */
  redo: () => Promise<void>;
  /** Asks the deck's history what undo and redo would do now. */
  refreshHistory: () => Promise<void>;
}

/** Only the newest history check counts; an earlier one can come back after it. */
let historyRun = 0;

/** Asks the open deck's history what undo and redo would do now. */
export async function refreshHistory(app: AppStore) {
  const { deck } = app.getState();
  const run = ++historyRun;
  if (!deck) {
    app.setState({ history: null });
    return;
  }
  try {
    const history = await api.deckHistory(deck.id);
    if (run === historyRun && app.getState().deck?.id === deck.id) app.setState({ history });
  } catch {
    if (run === historyRun) app.setState({ history: null });
  }
}

/**
 * Undoes (`back`) or redoes the open deck's newest change, after the edits before it, and shows
 * the first slide it changed. An undone agent turn may take the chat back too (see `turnUndone`).
 */
function stepHistory(app: AppStore, back: boolean): Promise<void> {
  return queueEdit(async () => {
    await flushReview(app);
    const { deck } = app.getState();
    if (!deck) return;
    try {
      const done = await (back ? api.undoDeck(deck.id) : api.redoDeck(deck.id));
      if (app.getState().deck?.id !== deck.id) return;
      const before = (id: string | null) => deck.slides.find((s) => s.id === id)?.hash;
      const changed = done.deck.slides.filter((slide) => before(slide.id) !== slide.hash).map((s) => s.id);
      app.getState().setDeck(done.deck);
      adoptReview(app, done.deck);
      historyRun++;
      const { selected } = app.getState();
      // The slide editor starts again only when what it shows changed under it: the slide on the
      // stage, or the deck's styles. A change to another slide leaves it running.
      const reloads = done.deck.shellHash !== deck.shellHash || (selected !== null && changed.includes(selected));
      app.setState((s) => ({ history: done.status, editReload: reloads ? s.editReload + 1 : s.editReload }));
      if (changed[0] && !(selected && changed.includes(selected))) app.getState().select(changed[0]);
      const entry = done.entry;
      if (entry?.source === "chat" && entry.message) {
        if (back) turnUndone(app, entry);
        else turnRedone(app, entry);
      }
    } catch (error) {
      showErrorIn(app, error);
    }
  });
}

/**
 * Takes back the change the deck's history labels `label`, for the Undo offered right after it
 * (in a toast, say), as long as it still is the deck's newest change: undoing whatever came after
 * it instead would not be what the button said. `what` names the change in the message shown when
 * it cannot. Resolves to whether it was undone.
 */
export async function undoNewest(app: AppStore, label: string, what: string): Promise<boolean> {
  await editsSaved();
  await refreshHistory(app);
  const { deck, history } = app.getState();
  if (!deck) return false;
  if (history?.undo?.label !== label) {
    showErrorIn(app, `The ${what} cannot be undone: the deck changed since.`);
    return false;
  }
  await app.getState().undo();
  return true;
}

export const createHistorySlice: Slice<HistorySlice> = (_set, _get, app) => ({
  history: null,

  undo: () => stepHistory(app, true),

  redo: () => stepHistory(app, false),

  refreshHistory: () => refreshHistory(app),
});
