import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  FolderSearch,
  Globe,
  MonitorPlay,
  Presentation,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Item } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage, type FileKind, type WorkspaceEntry } from "../lib/api";
import { absolutePath, ancestorsOf, foldersToReload, toggleFolder, treeMove, visibleRows } from "../lib/fileTree";
import { loadJson, saveJson } from "../lib/storage";
import { cn, revealLabel } from "../lib/utils";
import { useApp } from "../store";
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

/** How long the watcher stays quiet before the tree lists again the folders whose files changed. */
export const TREE_RELOAD_DELAY = 100;

/**
 * Loads the workspace's folders only when asked for (expanded), keeping them after they are
 * collapsed, and reloads loaded ones on request (the watcher reported changes in them). A
 * loaded folder can be forgotten instead: it is listed again when next asked for.
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

  const forget = useCallback((paths: readonly string[]) => {
    if (paths.length === 0) return;
    for (const path of paths) requested.current.delete(path);
    setFolders((prev) => {
      const next = new Map(prev);
      for (const path of paths) next.delete(path);
      return next;
    });
  }, []);

  return { folders, errors, load, reload, forget };
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
  /** The tree is on show: the sidebar is open on its tab. */
  const showing = useApp((s) => s.sidebarOpen && s.sidebarTab === "files");
  const { folders, errors, load, reload, forget } = useDirectoryEntries(root);
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

  // Follow the watcher. Its reports come in bursts while the agent works: what changed adds up,
  // and once the reports pause the folders on show are listed again, each once. A collapsed
  // folder is only forgotten, to be listed when it opens; and nothing is listed while the tree
  // is out of sight, which catches up as it shows again.
  const loadedRef = useRef(folders);
  loadedRef.current = folders;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const changed = useRef(new Set<string>());
  /** The report there was before the tree was: it has just listed what it shows. */
  const reported = useRef(change);
  useEffect(() => {
    if (change && change !== reported.current) {
      reported.current = change;
      for (const path of change.paths) changed.current.add(path);
    }
    if (!showing || changed.current.size === 0) return;
    const timer = setTimeout(() => {
      const stale = foldersToReload([...changed.current], loadedRef.current.keys());
      changed.current.clear();
      const shown = (folder: string) => folder === "" || expandedRef.current.has(folder);
      forget(stale.filter((folder) => !shown(folder)));
      void reload(stale.filter(shown));
    }, TREE_RELOAD_DELAY);
    return () => clearTimeout(timer);
  }, [change, showing, reload, forget]);

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

  /** What the rows of every level share. */
  const tree: TreeProps = {
    folders,
    errors,
    expanded,
    openedPath,
    tabStop,
    toggle,
    onFocus: setFocused,
    onMenu: setMenu,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <span title={root} className="min-w-0 flex-1 truncate px-1 text-xs font-medium">
          {name}
        </span>
        <Button variant="tool" size="icon-xs" tooltip={revealLabel} onClick={() => void revealItemInDir(root)}>
          <FolderSearch />
        </Button>
        <Button variant="tool" size="icon-xs" tooltip="Refresh" onClick={() => void refresh()}>
          <RefreshCw className={cn(refreshing && "animate-spin")} />
        </Button>
      </div>
      {/* The tree scrolls by itself (the app's thin scrollbars): nothing here is a tab stop but its rows. */}
      <div
        ref={treeRef}
        role="tree"
        aria-label={`Files in ${name}`}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        {rootError ? (
          <Alert variant="destructive" className="rounded-none border-0 px-3 py-2">
            <AlertDescription className="text-xs">{rootError}</AlertDescription>
          </Alert>
        ) : !folders.has("") ? (
          <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
            <Spinner aria-hidden="true" className="size-3.5" />
            Loading…
          </p>
        ) : rows.length === 0 ? (
          <Empty className="p-4">
            <EmptyHeader>
              <EmptyDescription className="text-xs">This folder is empty.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <TreeLevel folder="" depth={0} tree={tree} />
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

/** What every level of the tree is drawn from, and what its rows do. */
interface TreeProps {
  folders: ReadonlyMap<string, readonly WorkspaceEntry[]>;
  errors: ReadonlyMap<string, string>;
  expanded: ReadonlySet<string>;
  openedPath: string | null;
  /** The one row Tab stops at; the arrows go to the others. */
  tabStop: string | null;
  toggle: (folder: string) => void;
  onFocus: (path: string) => void;
  onMenu: (menu: OpenMenu) => void;
}

/**
 * The entries of one folder, `depth` folders down. A file is a row, which opens it; a folder is a
 * collapsible: its row opens and closes it, and its entries (or why they could not be listed) are
 * its content, there only while it is open.
 */
function TreeLevel({ folder, depth, tree }: { folder: string; depth: number; tree: TreeProps }) {
  return (tree.folders.get(folder) ?? []).map((entry) => {
    const selected = entry.path === tree.openedPath;
    /** What a row is, whatever it holds. */
    const row = {
      size: "xs",
      render: <button type="button" />,
      role: "treeitem",
      "data-path": entry.path,
      "aria-level": depth + 1,
      "aria-selected": selected,
      tabIndex: entry.path === tree.tabStop ? 0 : -1,
      title: `${entry.path} · ${KIND_LABELS[entry.kind]}`,
      onFocus: () => tree.onFocus(entry.path),
      onContextMenu: (event: React.MouseEvent) => {
        event.preventDefault();
        tree.onMenu({ entry, x: event.clientX, y: event.clientY });
      },
      style: { paddingLeft: INDENT_BASE + depth * INDENT_STEP },
      className: cn(
        "flex-nowrap gap-1 rounded-none border-0 py-0.5 pr-2 text-left text-xs hover:bg-muted focus-visible:bg-muted focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:ring-inset",
        selected && "bg-muted font-medium text-foreground",
        !selected && entry.kind === "file" && "text-muted-foreground",
      ),
    } satisfies React.ComponentProps<typeof Item> & { "data-path": string };

    if (entry.kind !== "directory") {
      const Icon = ICONS[entry.kind];
      return (
        <Item key={entry.path} {...row} onClick={() => void useApp.getState().openPath(entry.path)}>
          <ChevronRight className="invisible size-3 shrink-0" />
          <Icon className={cn("size-3.5 shrink-0", entry.kind === "deck" ? "text-primary" : "text-muted-foreground")} />
          <span className="truncate">{entry.name}</span>
        </Item>
      );
    }

    const open = tree.expanded.has(entry.path);
    const Icon = open ? FolderOpen : Folder;
    // A folder that could not be listed says why, where its entries would be.
    const error = tree.errors.get(entry.path);
    return (
      <Collapsible key={entry.path} open={open} onOpenChange={() => tree.toggle(entry.path)}>
        <CollapsibleTrigger render={<Item {...row} />}>
          <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground", open && "rotate-90")} />
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{entry.name}</span>
        </CollapsibleTrigger>
        <CollapsibleContent role="group">
          <TreeLevel folder={entry.path} depth={depth + 1} tree={tree} />
          {error && (
            <p
              role="alert"
              style={{ paddingLeft: INDENT_BASE + (depth + 1) * INDENT_STEP + 16 }}
              className="py-0.5 pr-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
    );
  });
}
