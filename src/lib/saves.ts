// Whether the open deck is being saved: the app saves every change as it is made, and the top bar
// says so (see components/SaveStatus.tsx). Every command to the backend passes through
// `trackingSaves` (see ./api.ts), which counts the ones that write the deck file while they run.
import { create } from "zustand";

/** The commands that write the open deck's file. */
const WRITES = new Set([
  "add_section",
  "add_slide",
  "add_template_slide",
  "apply_template",
  "delete_recorded_narration",
  "delete_section",
  "delete_section_slides",
  "delete_slides",
  "duplicate_slides",
  "import_assets",
  "paste_slides",
  "redo_deck",
  "rename_deck",
  "rename_section",
  "reorder_slides",
  "replace_in_deck",
  "replace_match_in_deck",
  "restore_all_changes",
  "restore_change",
  "restore_slides",
  "restore_version",
  "save_asset",
  "save_comments",
  "save_deck_source",
  "save_review",
  "set_narration_language",
  "set_narration_provider",
  "set_narration_voice",
  "set_slide_locked",
  "set_slide_narration",
  "set_slide_notes",
  "set_slide_size",
  "set_slide_time",
  "set_slide_timing",
  "set_slides_hidden",
  "set_slides_locked",
  "undo_deck",
  "update_slide",
]);

/** How saving the deck stands. */
export interface Saves {
  /** How many writes are under way. */
  pending: number;
  /** The write that ended last failed: what it was to save is not in the deck file. */
  failed: boolean;
}

/** How saving the deck stands now. */
export const useSaves = create<Saves>(() => ({ pending: 0, failed: false }));

/** Whether the command `command` writes the deck file. */
export const isWrite = (command: string) => WRITES.has(command);

/**
 * `invoke`, counting the commands that write the deck file while they run. The others pass
 * through untouched.
 */
export function trackingSaves<Invoke extends (command: string, ...rest: never[]) => Promise<unknown>>(
  invoke: Invoke,
): Invoke {
  const tracked = (command: string, ...rest: never[]) => {
    if (!isWrite(command)) return invoke(command, ...rest);
    useSaves.setState((s) => ({ pending: s.pending + 1 }));
    const settle = (failed: boolean) => useSaves.setState((s) => ({ pending: Math.max(0, s.pending - 1), failed }));
    // Called now, not in a `then`: a command that throws at once is still let go of.
    let result: Promise<unknown>;
    try {
      result = invoke(command, ...rest);
    } catch (error) {
      settle(true);
      throw error;
    }
    result.then(
      () => settle(false),
      () => settle(true),
    );
    return result;
  };
  return tracked as Invoke;
}

/** Resolves once no write is under way. */
export function savesSettled(): Promise<void> {
  if (useSaves.getState().pending === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = useSaves.subscribe((s) => {
      if (s.pending > 0) return;
      stop();
      resolve();
    });
  });
}

/** Starts over, for another deck: nothing is being saved, and nothing failed. */
export function resetSaves() {
  useSaves.setState({ pending: 0, failed: false });
}
