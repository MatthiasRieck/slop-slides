import { api, type DeckHistory, type HistoryEntry, type HistoryStep } from "../lib/api";
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
  /**
   * Puts the deck back as it was at `version` of its history, as one change of its own: undo
   * takes the deck to where it was before. False when it could not.
   */
  restoreVersion: (version: string) => Promise<boolean>;
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
 * Moves the open deck to another version of its history as `move` does, after the edits before
 * it, and shows the first slide that changed. Resolves to the change the history reports (null
 * for none); undefined when the move failed, which is said, or the deck is no longer the one open.
 */
function moveInHistory(
  app: AppStore,
  move: (deck: string) => Promise<HistoryStep>,
): Promise<HistoryEntry | null | undefined> {
  return queueEdit(async () => {
    await flushReview(app);
    const { deck } = app.getState();
    if (!deck) return undefined;
    try {
      const done = await move(deck.id);
      if (app.getState().deck?.id !== deck.id) return undefined;
      const before = (id: string | null) => deck.slides.find((s) => s.id === id)?.hash;
      const changed = done.deck.slides.filter((slide) => before(slide.id) !== slide.hash).map((s) => s.id);
      // The stage follows by itself: the slide it shows changed under its editor is patched in
      // place, and new styles for the deck load it again (see components/stage/stageDocument.ts).
      app.getState().setDeck(done.deck);
      adoptReview(app, done.deck);
      historyRun++;
      const { selected } = app.getState();
      app.setState({ history: done.status });
      if (changed[0] && !(selected && changed.includes(selected))) app.getState().select(changed[0]);
      return done.entry;
    } catch (error) {
      showErrorIn(app, error);
      return undefined;
    }
  });
}

/**
 * Undoes (`back`) or redoes the open deck's newest change. An undone agent turn may take the
 * chat back too (see `turnUndone`).
 */
async function stepHistory(app: AppStore, back: boolean): Promise<void> {
  const entry = await moveInHistory(app, back ? api.undoDeck : api.redoDeck);
  if (entry?.source !== "chat" || !entry.message) return;
  if (back) turnUndone(app, entry);
  else turnRedone(app, entry);
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

  restoreVersion: async (version) =>
    (await moveInHistory(app, (deck) => api.restoreVersion(deck, version))) !== undefined,

  refreshHistory: () => refreshHistory(app),
});
