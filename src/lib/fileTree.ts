/** Pure helpers behind the file tree (components/FileTree.tsx). Paths are workspace-relative and `/`-separated; `""` is the root. */
import type { WorkspaceEntry } from "./api";

/** A tree row: an entry and how deep it sits. */
export interface TreeRow {
  entry: WorkspaceEntry;
  depth: number;
}

/** The folder holding `path`; `""` for entries at the root. */
export function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/** Every folder above `path`, outermost first, not counting the root. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** The file that makes a folder a deck's folder. */
const DECK_FILE = "deck.html";

/** Whether `entry` is a deck's folder, which the tree shows as the deck: one row, named by the deck's title. */
export function isDeckFolder(entry: WorkspaceEntry): entry is WorkspaceEntry & { deckTitle: string } {
  return entry.kind === "directory" && entry.deckTitle !== undefined;
}

/** The deck file of the deck folder `entry`, which a click on its row opens. */
export function deckFileOf(entry: WorkspaceEntry): string {
  return `${entry.path}/${DECK_FILE}`;
}

/** What a click on the row of `entry` opens: its deck for a deck's folder, itself for a file, nothing for a plain folder. */
export function fileToOpen(entry: WorkspaceEntry): string | null {
  if (isDeckFolder(entry)) return deckFileOf(entry);
  return entry.kind === "directory" ? null : entry.path;
}

/**
 * The rows to show: the root's entries, and those of every expanded folder under its parent. A
 * deck's folder is the deck's row, so the deck file inside it is not listed again: expanded, the
 * folder shows what else it holds (the deck's images, its narration).
 */
export function visibleRows(
  folders: ReadonlyMap<string, readonly WorkspaceEntry[]>,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (folder: string, depth: number, deckFile: string | null) => {
    for (const entry of folders.get(folder) ?? []) {
      if (entry.path === deckFile) continue;
      rows.push({ entry, depth });
      if (entry.kind === "directory" && expanded.has(entry.path)) {
        visit(entry.path, depth + 1, isDeckFolder(entry) ? deckFileOf(entry) : null);
      }
    }
  };
  visit("", 0, null);
  return rows;
}

/**
 * The folders to open so that the row of the open file `path` shows, as far as `folders` (the
 * listings loaded so far) tell; null while the folder holding it is not listed yet, so it is not
 * known whether that folder is a deck's. A deck in a folder of its own shows as that folder's
 * row, so the folder itself stays closed.
 */
export function foldersToReveal(
  path: string,
  folders: ReadonlyMap<string, readonly WorkspaceEntry[]>,
): string[] | null {
  const above = ancestorsOf(path);
  const holder = above.at(-1);
  if (holder === undefined) return [];
  const entry = folders.get(parentOf(holder))?.find((e) => e.path === holder);
  if (!entry) return folders.has(parentOf(holder)) ? above : null;
  return isDeckFolder(entry) && deckFileOf(entry) === path ? above.slice(0, -1) : above;
}

/**
 * The row that stands for the open file among `rows`: its own, or the row of the deck's folder
 * it is the deck of. Null when neither shows.
 */
export function rowOfFile(rows: readonly TreeRow[], file: string | null): string | null {
  if (file === null) return null;
  const row = rows.find(({ entry }) => entry.path === file || (isDeckFolder(entry) && deckFileOf(entry) === file));
  return row?.entry.path ?? null;
}

/** Whether `path` is `folder` or lies inside it. */
export function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** `path` after `from` was renamed to `to`: what was at or inside `from` is at or inside `to`. */
export function renamedPath(path: string, from: string, to: string): string {
  return isWithin(path, from) ? to + path.slice(from.length) : path;
}

/**
 * The part of a name to select when renaming starts, as `[start, end]`: all of a folder's, and
 * a file's up to its extension, which usually stays.
 */
export function nameSelection(name: string, folder: boolean): [number, number] {
  const dot = name.lastIndexOf(".");
  return [0, folder || dot <= 0 ? name.length : dot];
}

/** What the system calls where deleted files go: the Recycle Bin on Windows, the Trash elsewhere. */
export function trashNameFor(userAgent: string): string {
  return userAgent.includes("Windows") ? "Recycle Bin" : "Trash";
}

/**
 * The loaded folders whose listing `changed` paths may have changed: the folders holding them,
 * and the paths themselves when they are folders (deleted or replaced as a whole).
 */
export function foldersToReload(changed: readonly string[], loaded: Iterable<string>): string[] {
  const have = new Set(loaded);
  const reload = new Set<string>();
  for (const path of changed) {
    for (const folder of [parentOf(path), path]) if (have.has(folder)) reload.add(folder);
  }
  return [...reload].sort();
}

/** `expanded` without `folder` and the folders inside it, or with `folder` added. */
export function toggleFolder(expanded: ReadonlySet<string>, folder: string): Set<string> {
  const next = new Set(expanded);
  if (!next.has(folder)) return next.add(folder);
  for (const path of expanded) if (path === folder || path.startsWith(`${folder}/`)) next.delete(path);
  return next;
}

/** What a key pressed on a tree row does: the row the focus goes to, or the folder that opens or closes. */
export type TreeMove = { focus: string } | { toggle: string };

/**
 * What `key` does on the row `current` of `rows`: ↑ and ↓ go to the row before and after, Home
 * and End to the ends; → opens a closed folder, and on an open one goes to its first entry; ←
 * closes an open folder, and anywhere else goes to the folder the row is in. Null when the key
 * moves nothing (another key, the end of the tree, a row that is gone).
 */
export function treeMove(
  rows: readonly TreeRow[],
  expanded: ReadonlySet<string>,
  current: string,
  key: string,
): TreeMove | null {
  const at = rows.findIndex((row) => row.entry.path === current);
  const row = rows[at];
  if (!row) return null;
  const to = (index: number): TreeMove | null => {
    const target = rows[index];
    return target && index !== at ? { focus: target.entry.path } : null;
  };
  const folder = row.entry.kind === "directory";
  const open = folder && expanded.has(current);
  switch (key) {
    case "ArrowDown":
      return to(at + 1);
    case "ArrowUp":
      return to(at - 1);
    case "Home":
      return to(0);
    case "End":
      return to(rows.length - 1);
    case "ArrowRight":
      if (!folder) return null;
      if (!open) return { toggle: current };
      // Its first entry is the next row, when it has any (loaded).
      return (rows[at + 1]?.depth ?? 0) > row.depth ? to(at + 1) : null;
    case "ArrowLeft": {
      if (open) return { toggle: current };
      const parent = parentOf(current);
      return parent ? { focus: parent } : null;
    }
    default:
      return null;
  }
}

/** The absolute path of the workspace-relative `path`, joined the way the root is written. */
export function absolutePath(root: string, path: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.endsWith(separator) ? root.slice(0, -1) : root;
  return path ? `${base}${separator}${path.split("/").join(separator)}` : base;
}
