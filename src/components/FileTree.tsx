import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  FolderSearch,
  Globe,
  Loader2,
  MonitorPlay,
  Presentation,
  RefreshCw,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, errorMessage, type FileKind, type WorkspaceEntry } from "../lib/api";
import { absolutePath, ancestorsOf, foldersToReload, toggleFolder, treeMove, visibleRows } from "../lib/fileTree";
import { loadJson, saveJson } from "../lib/storage";
import { cn, revealLabel } from "../lib/utils";
import { useApp } from "../store";
import { ToolButton } from "./Button";
import { FileContextMenu } from "./FileContextMenu";

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
        // A folder that is gone since (a reload finds it missing) shows as empty; any other failure says why.
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
  return loadJson(
    EXPANDED_KEY + root,
    new Set(),
    (saved) => new Set(Array.isArray(saved) ? saved.filter((p): p is string => typeof p === "string") : []),
  );
}

/**
 * The open workspace's files, as a tree. Clicking a file opens it in the viewer its kind calls
 * for, and a folder opens or closes. With the keys: ↑ ↓ Home End go through the rows, → opens a
 * folder or goes into it, ← closes it or goes to the folder above, Enter does what a click does.
 * A right-click (or Shift+F10) on a row opens its menu (see FileContextMenu).
 */
export function FileTree() {
  const workspace = useApp((s) => s.workspace);
  if (!workspace) return null;
  // Keyed: another workspace starts with its own tree state.
  return <WorkspaceTree key={workspace.path} root={workspace.path} name={workspace.name} />;
}

/** The row whose menu is open, and where. */
interface OpenMenu {
  entry: WorkspaceEntry;
  x: number;
  y: number;
}

function WorkspaceTree({ root, name }: { root: string; name: string }) {
  const openedPath = useApp((s) => s.openedFile?.path ?? null);
  const change = useApp((s) => s.workspaceChange);
  const { folders, errors, load, reload } = useDirectoryEntries(root);
  const [expanded, setExpanded] = useState(() => loadExpanded(root));
  const [refreshing, setRefreshing] = useState(false);
  /** The row the keys last went to; the one Tab comes back to. */
  const [focused, setFocused] = useState<string | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveJson(EXPANDED_KEY + root, [...expanded]);
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
  // One row is in the tab order: the one the keys went to last, else the open file's, else the first.
  const shown = (path: string | null) => path !== null && rows.some((row) => row.entry.path === path);
  const tabStop = shown(focused) ? focused : shown(openedPath) ? openedPath : (rows[0]?.entry.path ?? null);

  const refresh = async () => {
    setRefreshing(true);
    await reload([...folders.keys()]);
    setRefreshing(false);
  };

  const toggle = (folder: string) => setExpanded((prev) => toggleFolder(prev, folder));
  const open = (entry: WorkspaceEntry) =>
    entry.kind === "directory" ? toggle(entry.path) : void useApp.getState().openPath(entry.path);

  const rowElement = (path: string) =>
    Array.from(treeRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? []).find(
      (item) => item.dataset.path === path,
    );

  const onKeyDown = (event: React.KeyboardEvent) => {
    const path = (event.target as HTMLElement).closest<HTMLElement>("[role=treeitem]")?.dataset.path;
    if (path === undefined) return;
    if (event.key === "F10" && event.shiftKey) {
      const entry = rows.find((row) => row.entry.path === path)?.entry;
      const box = rowElement(path)?.getBoundingClientRect();
      if (!entry || !box) return;
      event.preventDefault();
      return setMenu({ entry, x: box.left + 24, y: box.bottom });
    }
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const move = treeMove(rows, expanded, path, event.key);
    if (!move) return;
    event.preventDefault();
    if ("toggle" in move) return toggle(move.toggle);
    setFocused(move.focus);
    rowElement(move.focus)?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <span title={root} className="min-w-0 flex-1 truncate px-1 text-xs font-medium">
          {name}
        </span>
        <ToolButton variant="panel" label={revealLabel} onClick={() => void revealItemInDir(root)}>
          <FolderSearch className="size-3.5" />
        </ToolButton>
        <ToolButton variant="panel" label="Refresh" onClick={() => void refresh()}>
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </ToolButton>
      </div>
      <div
        ref={treeRef}
        role="tree"
        aria-label={`Files in ${name}`}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
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
          rows.map(({ entry, depth }) => {
            const isOpen = expanded.has(entry.path);
            // A folder that could not be listed says why, where its entries would be.
            const error = entry.kind === "directory" && isOpen ? errors.get(entry.path) : undefined;
            return (
              <Fragment key={entry.path}>
                <TreeItem
                  entry={entry}
                  depth={depth}
                  open={isOpen}
                  selected={entry.path === openedPath}
                  tabStop={entry.path === tabStop}
                  onClick={() => open(entry)}
                  onFocus={() => setFocused(entry.path)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ entry, x: event.clientX, y: event.clientY });
                  }}
                />
                {error && (
                  <p
                    role="alert"
                    style={{ paddingLeft: INDENT_BASE + (depth + 1) * INDENT_STEP + 16 }}
                    className="py-0.5 pr-2 text-xs text-destructive"
                  >
                    {error}
                  </p>
                )}
              </Fragment>
            );
          })
        )}
      </div>
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          entry={menu.entry}
          absolute={absolutePath(root, menu.entry.path)}
          expanded={expanded.has(menu.entry.path)}
          onOpen={() => open(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** A row's indent: the tree's edge, then a step for each folder it is in. */
const INDENT_BASE = 8;
const INDENT_STEP = 12;

function TreeItem(props: {
  entry: WorkspaceEntry;
  depth: number;
  open: boolean;
  selected: boolean;
  /** The one row Tab stops at; the arrows go to the others. */
  tabStop: boolean;
  onClick: () => void;
  onFocus: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const { entry, depth, open, selected } = props;
  const folder = entry.kind === "directory";
  const Icon = entry.kind === "directory" ? (open ? FolderOpen : Folder) : ICONS[entry.kind];
  return (
    <button
      type="button"
      role="treeitem"
      data-path={entry.path}
      aria-level={depth + 1}
      aria-expanded={folder ? open : undefined}
      aria-selected={selected}
      tabIndex={props.tabStop ? 0 : -1}
      title={`${entry.path} · ${KIND_LABELS[entry.kind]}`}
      onClick={props.onClick}
      onFocus={props.onFocus}
      onContextMenu={props.onContextMenu}
      style={{ paddingLeft: INDENT_BASE + depth * INDENT_STEP }}
      className={cn(
        "flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/40",
        selected && "bg-accent font-medium text-foreground",
        !selected && entry.kind === "file" && "text-muted-foreground",
      )}
    >
      <ChevronRight
        className={cn("size-3 shrink-0 text-muted-foreground", !folder && "invisible", open && "rotate-90")}
      />
      <Icon className={cn("size-3.5 shrink-0", entry.kind === "deck" ? "text-primary" : "text-muted-foreground")} />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}
