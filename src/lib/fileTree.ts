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
export function visibleRows(folders: ReadonlyMap<string, readonly WorkspaceEntry[]>, expanded: ReadonlySet<string>): TreeRow[] {
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
