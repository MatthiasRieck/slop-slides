import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  Globe,
  Loader2,
  MonitorPlay,
  Presentation,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, errorMessage, type FileKind, type WorkspaceEntry } from "../lib/api";
import { ancestorsOf, foldersToReload, toggleFolder, visibleRows } from "../lib/fileTree";
import { cn, isMac } from "../lib/utils";
import { useApp } from "../store";

const EXPANDED_KEY = "slopslide.expanded:";

const ICONS: Record<Exclude<FileKind, "directory">, typeof File> = {
  deck: Presentation,
  slideshow: MonitorPlay,
  webpage: Globe,
  file: File,
};

const KIND_LABELS: Record<FileKind, string> = {
  directory: "Folder",
  deck: "SlopSlide deck",
  slideshow: "Slideshow",
  webpage: "Web page",
  file: "File",
};

/**
 * Loads the workspace's folders only when asked for (expanded), keeping them after they are
 * collapsed, and reloads loaded ones on request (the watcher reported changes in them).
 */
export function useDirectoryEntries(root: string) {
  const [folders, setFolders] = useState(new Map<string, WorkspaceEntry[]>());
  const [errors, setErrors] = useState(new Map<string, string>());
  const requested = useRef(new Set<string>());
  // Answers for a workspace that has since been closed are dropped.
  const current = useRef(root);

  const load = useCallback(
    async (folder: string, force = false) => {
      if (!force && requested.current.has(folder)) return;
      requested.current.add(folder);
      try {
        const entries = await api.listDir(folder);
        if (current.current !== root) return;
        setFolders((prev) => new Map(prev).set(folder, Array.isArray(entries) ? entries : []));
        setErrors((prev) => {
          const next = new Map(prev);
          next.delete(folder);
          return next;
        });
      } catch (error) {
        if (current.current !== root) return;
        // A folder that is gone shows as empty; any other failure says why.
        setFolders((prev) => {
          const next = new Map(prev);
          next.delete(folder);
          return next;
        });
        if (folder === "" || !force) setErrors((prev) => new Map(prev).set(folder, errorMessage(error)));
        requested.current.delete(folder);
      }
    },
    [root],
  );

  useEffect(() => {
    current.current = root;
    requested.current = new Set();
    setFolders(new Map());
    setErrors(new Map());
    void load("");
  }, [root, load]);

  const reload = useCallback((paths: readonly string[]) => Promise.all(paths.map((p) => load(p, true))), [load]);

  return { folders, errors, load, reload };
}

function loadExpanded(root: string): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY + root) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((p): p is string => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}

/** The open workspace's files. Clicking a file opens it in the viewer its kind calls for. */
export function FileTree() {
  const workspace = useApp((s) => s.workspace);
  if (!workspace) return null;
  // Keyed: another workspace starts with its own tree state.
  return <WorkspaceTree key={workspace.path} root={workspace.path} name={workspace.name} />;
}

function WorkspaceTree({ root, name }: { root: string; name: string }) {
  const openedPath = useApp((s) => s.openedFile?.path ?? null);
  const change = useApp((s) => s.workspaceChange);
  const { folders, errors, load, reload } = useDirectoryEntries(root);
  const [expanded, setExpanded] = useState(() => loadExpanded(root));
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    localStorage.setItem(EXPANDED_KEY + root, JSON.stringify([...expanded]));
    for (const folder of expanded) void load(folder);
  }, [root, expanded, load]);

  // Show where the open file is.
  useEffect(() => {
    if (!openedPath) return;
    const above = ancestorsOf(openedPath);
    setExpanded((prev) => (above.every((f) => prev.has(f)) ? prev : new Set([...prev, ...above])));
  }, [openedPath]);

  // Follow the watcher: reload the folders whose files changed.
  const loadedRef = useRef(folders);
  loadedRef.current = folders;
  useEffect(() => {
    if (change) void reload(foldersToReload(change.paths, loadedRef.current.keys()));
  }, [change, reload]);

  const rows = useMemo(() => visibleRows(folders, expanded), [folders, expanded]);
  const rootError = errors.get("");

  const refresh = async () => {
    setRefreshing(true);
    await reload([...folders.keys()]);
    setRefreshing(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <span title={root} className="min-w-0 flex-1 truncate px-1 text-xs font-medium">
          {name}
        </span>
        <button
          type="button"
          title={isMac ? "Show in Finder" : "Show in folder"}
          onClick={() => void revealItemInDir(root)}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <FolderOpen className="size-3.5" />
        </button>
        <button
          type="button"
          title="Refresh"
          aria-label="Refresh"
          onClick={() => void refresh()}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </button>
      </div>
      <div role="tree" aria-label={`Files in ${name}`} className="min-h-0 flex-1 overflow-y-auto py-1">
        {rootError ? (
          <p className="px-3 py-2 text-xs text-destructive">{rootError}</p>
        ) : !folders.has("") ? (
          <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading…
          </p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">This folder is empty.</p>
        ) : (
          rows.map(({ entry, depth }) => (
            <TreeItem
              key={entry.path}
              entry={entry}
              depth={depth}
              open={expanded.has(entry.path)}
              selected={entry.path === openedPath}
              onClick={() =>
                entry.kind === "directory"
                  ? setExpanded((prev) => toggleFolder(prev, entry.path))
                  : void useApp.getState().openPath(entry.path)
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

function TreeItem(props: { entry: WorkspaceEntry; depth: number; open: boolean; selected: boolean; onClick: () => void }) {
  const { entry, depth, open, selected } = props;
  const folder = entry.kind === "directory";
  const Icon = entry.kind === "directory" ? (open ? FolderOpen : Folder) : ICONS[entry.kind];
  return (
    <button
      type="button"
      role="treeitem"
      aria-expanded={folder ? open : undefined}
      aria-selected={selected}
      title={`${entry.path} · ${KIND_LABELS[entry.kind]}`}
      onClick={props.onClick}
      style={{ paddingLeft: 8 + depth * 12 }}
      className={cn(
        "flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs hover:bg-accent",
        selected && "bg-accent font-medium text-foreground",
        !selected && entry.kind === "file" && "text-muted-foreground",
      )}
    >
      <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground", !folder && "invisible", open && "rotate-90")} />
      <Icon className={cn("size-3.5 shrink-0", entry.kind === "deck" ? "text-primary" : "text-muted-foreground")} />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}
