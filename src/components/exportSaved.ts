import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { basename, revealLabel } from "../lib/utils";
import { showError, showSuccess } from "../store";

/**
 * Shows `path` (a file or a folder) in the system's file manager. That it cannot be shown is said
 * as that, never as a failure to save: the file is there.
 */
export async function revealSaved(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch (error) {
    showError(error, `${basename(path)} is saved, but it could not be shown in its folder: `);
  }
}

/**
 * Says that an export is saved at `path` (as `text`, or "Saved deck.pdf"), with a button that
 * shows it in its folder: the file manager opens when asked for, not by itself.
 */
export function showSaved(path: string, text = `Saved ${basename(path)}`) {
  showSuccess(text, { label: revealLabel, run: () => void revealSaved(path) });
}
