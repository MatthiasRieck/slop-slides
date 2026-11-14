// What the Files tab does to a file or folder besides opening it: add it to the chat, rename
// it, make a folder, move it to the trash. Each says what went wrong in a toast.
import { api, type WorkspaceEntry } from "../lib/api";
import { isDeckFolder, isWithin, renamedPath, trashNameFor } from "../lib/fileTree";
import { showError, showSuccess, useApp } from "../store";
import { confirmAction } from "../store/confirm";

/** What the system calls where deleted files go. */
export const trashName = trashNameFor(navigator.userAgent);

/** What the user calls the row of `entry`: a deck by its title, anything else by its file name. */
export const displayName = (entry: WorkspaceEntry) => entry.deckTitle ?? entry.name;

/** Attaches the file or folder to the chat's next message, and goes to the message box. */
export function addToChat(entry: WorkspaceEntry) {
  const app = useApp.getState();
  app.attachToComposer(entry.path);
  app.focusComposer();
}

/**
 * Closes the open file when it is `entry` or inside it, as it is about to move or go; its path,
 * for opening it again where it then is. `false` when it stays open (the user kept unsaved
 * edits, or the agent's running turn), and null when nothing had to close.
 */
async function closeOpenFileIn(entry: WorkspaceEntry): Promise<string | null | false> {
  const app = useApp.getState();
  const open = app.openedFile?.path;
  if (open === undefined || !isWithin(open, entry.path)) return null;
  return (await app.closeDeck()) ? open : false;
}

/**
 * Renames `entry` to `name` where it is; its new path, or null when it keeps its name (the name
 * is taken or not one, or the open file inside it stayed open). The file open inside it closes
 * for the rename and opens again under its new path.
 */
export async function renameEntry(entry: WorkspaceEntry, name: string): Promise<string | null> {
  if (name.trim() === entry.name || name.trim() === "") return null;
  const open = await closeOpenFileIn(entry);
  if (open === false) return null;
  let renamed: string | null = null;
  try {
    renamed = await api.renameEntry(entry.path, name);
  } catch (error) {
    showError(error, { doing: `Could not rename ${entry.name}` });
  }
  // Open again what was open: under its new path, or where it still is.
  if (open !== null) await useApp.getState().openPath(renamed === null ? open : renamedPath(open, entry.path, renamed));
  return renamed;
}

/** Makes a new folder in the folder `parent` (`""` for the root); its path, or null when it could not be made. */
export async function createFolder(parent: string): Promise<string | null> {
  try {
    return await api.createFolder(parent);
  } catch (error) {
    showError(error, { doing: "Could not make the folder" });
    return null;
  }
}

/**
 * Moves `entry` to the system's trash, once the user says so; whether it went. The file open
 * inside it closes first.
 */
export async function trashEntry(entry: WorkspaceEntry): Promise<boolean> {
  const name = displayName(entry);
  const what = isDeckFolder(entry)
    ? "The deck goes with everything in its folder: its images and its narration."
    : entry.kind === "directory"
      ? "The folder goes with everything in it."
      : "";
  const confirmed = await confirmAction({
    title: `Move “${name}” to the ${trashName}?`,
    message: `${what} You can put it back from the ${trashName}.`.trim(),
    confirmLabel: `Move to ${trashName}`,
    destructive: true,
  });
  if (!confirmed || (await closeOpenFileIn(entry)) === false) return false;
  try {
    await api.trashEntry(entry.path);
  } catch (error) {
    showError(error, { doing: `Could not move ${name} to the ${trashName}` });
    return false;
  }
  showSuccess(`Moved “${name}” to the ${trashName}.`);
  return true;
}
