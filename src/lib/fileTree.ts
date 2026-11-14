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

/** The rows to show: the root's entries, and those of every expanded folder under its parent. */
export function visibleRows(
  folders: ReadonlyMap<string, readonly WorkspaceEntry[]>,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (folder: string, depth: number) => {
    for (const entry of folders.get(folder) ?? []) {
      rows.push({ entry, depth });
      if (entry.kind === "directory" && expanded.has(entry.path)) visit(entry.path, depth + 1);
    }
  };
  visit("", 0);
  return rows;
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
