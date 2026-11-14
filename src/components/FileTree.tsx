import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Globe,
  Loader2,
  MonitorPlay,
  Plus,
  Presentation,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Fragment, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { api, errorMessage, type FileKind, type FileSearch, type WorkspaceEntry } from "../lib/api";
import {
  absolutePath,
  ancestorsOf,
  fileToOpen,
  foldersToReload,
  foldersToReveal,
  isDeckFolder,
  nameSelection,
  parentOf,
  renamedPath,
  rowOfFile,
  type TreeRow,
  toggleFolder,
  treeMove,
  visibleRows,
} from "../lib/fileTree";
import { loadJson, saveJson } from "../lib/storage";
import { cn, plural, revealLabel } from "../lib/utils";
import { useApp } from "../store";
import { ToolButton } from "./Button";
import { inputClass } from "./Field";
import { FileContextMenu } from "./FileContextMenu";
import { createFolder, displayName, renameEntry, trashEntry } from "./fileActions";

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

/** How long the filter waits after the last key before it searches. */
export const FILTER_DELAY = 150;

/**
 * What the filter found for `query` anywhere in the workspace, a moment after the last key;
 * null while there is no query. `searching` until the answer for the query as it is now is in.
 */
export function useFileSearch(root: string, query: string) {
  const wanted = query.trim();
  const [state, setState] = useState<{ query: string; results: FileSearch | null; error: string | null }>({
    query: "",
    results: null,
    error: null,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: another workspace searches anew
  useEffect(() => {
    if (!wanted) return;
    let stale = false;
    const timer = setTimeout(() => {
      api.searchFiles(wanted).then(
        (results) => !stale && setState({ query: wanted, results, error: null }),
        (error) => !stale && setState({ query: wanted, results: null, error: errorMessage(error) }),
      );
    }, FILTER_DELAY);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [root, wanted]);
  if (!wanted) return { active: false, searching: false, results: null, error: null } as const;
  const current = state.query === wanted;
  return {
    active: true,
    searching: !current,
    // The last answer stays on show while the next one is on its way.
    results: state.results,
    error: current ? state.error : null,
  } as const;
}

/**
 * The open workspace's files, as a tree. A deck's folder shows as the deck: one row with the
 * deck's title, which a click opens; its arrow shows the deck's own files. Clicking any other
 * file opens it in the viewer its kind calls for, and a folder opens or closes. With the keys:
 * ↑ ↓ Home End go through the rows, → opens a folder or goes into it, ← closes it or goes to the
 * folder above, Enter does what a click does and F2 renames. A right-click (or Shift+F10) on a
 * row opens its menu (see FileContextMenu). The field above the tree finds files by name, and
 * decks by title, anywhere in the folder.
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
  const { folders, errors, load, reload, forget } = useDirectoryEntries(root);
  const [expanded, setExpanded] = useState(() => loadExpanded(root));
  const [refreshing, setRefreshing] = useState(false);
  /** The row the keys last went to; the one Tab comes back to. */
  const [focused, setFocused] = useState<string | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  /** The row being renamed, in place. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const search = useFileSearch(root, query);
  const treeRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    saveJson(EXPANDED_KEY + root, [...expanded]);
    for (const folder of expanded) void load(folder);
  }, [root, expanded, load]);

  // Show where the open file is, once for each file opened: the folders above it open, level by
  // level as they are listed (a deck's own folder stays closed, its row standing for the deck).
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!openedPath || revealed.current === openedPath) return;
    const above = ancestorsOf(openedPath);
    const known = foldersToReveal(openedPath, folders);
    if (known !== null) revealed.current = openedPath;
    // Until the folder holding it is listed, the folders above that one open, which lists it.
    const open = known ?? above.slice(0, -1);
    setExpanded((prev) => (open.every((f) => prev.has(f)) ? prev : new Set([...prev, ...open])));
  }, [openedPath, folders]);

  const loadedRef = useRef(folders);
  loadedRef.current = folders;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const treeRows = useMemo(() => visibleRows(folders, expanded), [folders, expanded]);
  // With a filter, what it found anywhere in the folder shows instead of the tree, as a flat list.
  const rows: TreeRow[] = useMemo(
    () => (search.active ? (search.results?.found ?? []).map((entry) => ({ entry, depth: 0 })) : treeRows),
    [search.active, search.results, treeRows],
  );
  const rootError = errors.get("");
  const selected = rowOfFile(rows, openedPath);
  // One row is in the tab order: the one the keys went to last, else the open file's, else the first.
  const shown = (path: string | null) => path !== null && rows.some((row) => row.entry.path === path);
  const tabStop = shown(focused) ? focused : (selected ?? rows[0]?.entry.path ?? null);

  const refresh = async () => {
    setRefreshing(true);
    await reload([...folders.keys()]);
    setRefreshing(false);
  };

  const rowElement = (path: string) =>
    Array.from(treeRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? []).find(
      (item) => item.dataset.path === path,
    );
  /** Puts the keyboard focus on the row of `path`, once it shows. */
  const focusRow = (path: string) => {
    setFocused(path);
    requestAnimationFrame(() => rowElement(path)?.focus());
  };

  const toggle = (folder: string) => setExpanded((prev) => toggleFolder(prev, folder));
  /** Leaves the filter for the tree, open on the folder `path` (one of its finds). */
  const showInTree = (path: string) => {
    setQuery("");
    setExpanded((prev) => new Set([...prev, ...ancestorsOf(path), path]));
    focusRow(path);
  };
  /** What a click on a row does: opens the file or the deck, or opens or closes the folder. */
  const activate = (entry: WorkspaceEntry) => {
    const file = fileToOpen(entry);
    if (file !== null) return void useApp.getState().openPath(file);
    if (search.active) showInTree(entry.path);
    else toggle(entry.path);
  };
  const toggleRow = (entry: WorkspaceEntry) => (search.active ? showInTree(entry.path) : toggle(entry.path));

  const rename = async (entry: WorkspaceEntry, newName: string) => {
    setRenaming(null);
    const renamed = await renameEntry(entry, newName);
    if (renamed === null) return rowElement(entry.path)?.focus();
    setExpanded((prev) => new Set([...prev].map((path) => renamedPath(path, entry.path, renamed))));
    await reload([parentOf(entry.path)]);
    focusRow(renamed);
  };

  /** Makes a folder in `parent`, shows it and starts naming it. */
  const newFolder = async (parent: string) => {
    const made = await createFolder(parent);
    if (made === null) return;
    setQuery("");
    if (parent) setExpanded((prev) => new Set([...prev, ...ancestorsOf(made)]));
    await reload([parent]);
    setFocused(made);
    setRenaming(made);
  };

  const trash = async (entry: WorkspaceEntry) => {
    if (!(await trashEntry(entry))) return;
    setExpanded((prev) => (prev.has(entry.path) ? toggleFolder(prev, entry.path) : prev));
    await reload([parentOf(entry.path)]);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // A key typed into a row's name field is the field's.
    if ((event.target as HTMLElement).closest("input")) return;
    const path = (event.target as HTMLElement).closest<HTMLElement>("[role=treeitem]")?.dataset.path;
    if (path === undefined) return;
    const entry = rows.find((row) => row.entry.path === path)?.entry;
    if (!entry) return;
    if (event.key === "F10" && event.shiftKey) {
      const box = rowElement(path)?.getBoundingClientRect();
      if (!box) return;
      event.preventDefault();
      return setMenu({ entry, x: box.left + 24, y: box.bottom });
    }
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      return activate(entry);
    }
    if (event.key === "F2") {
      event.preventDefault();
      return setRenaming(path);
    }
    const move = treeMove(rows, expanded, path, event.key);
    if (!move) return;
    event.preventDefault();
    if ("toggle" in move) return toggleRow(entry);
    setFocused(move.focus);
    rowElement(move.focus)?.focus();
  };

  const found = search.results?.found.length ?? 0;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <FollowWatcher loaded={loadedRef} expanded={expandedRef} reload={reload} forget={forget} />
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b px-2">
        <span title={root} className="min-w-0 flex-1 truncate px-1 text-xs font-medium">
          {name}
        </span>
        <ToolButton variant="panel" label="New deck…" onClick={() => useApp.getState().setNewDeckOpen(true)}>
          <Plus className="size-3.5" />
        </ToolButton>
        <ToolButton variant="panel" label="New folder" onClick={() => void newFolder("")}>
          <FolderPlus className="size-3.5" />
        </ToolButton>
        <ToolButton variant="panel" label={revealLabel} onClick={() => void revealItemInDir(root)}>
          <FolderSearch className="size-3.5" />
        </ToolButton>
        <ToolButton variant="panel" label="Refresh" onClick={() => void refresh()}>
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </ToolButton>
      </div>
      <div className="relative flex shrink-0 items-center border-b px-2 py-1.5">
        <Search aria-hidden className="pointer-events-none absolute left-4 size-3.5 text-muted-foreground" />
        <input
          ref={filterRef}
          type="search"
          aria-label="Filter files"
          placeholder="Filter by name or deck title"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              // Escape clears the filter first; nothing else closes for it.
              event.stopPropagation();
              setQuery("");
            } else if (event.key === "ArrowDown" && rows[0]) {
              event.preventDefault();
              focusRow(rows[0].entry.path);
            }
          }}
          className={cn(inputClass, "px-7 text-xs [&::-webkit-search-cancel-button]:hidden")}
        />
        {query && (
          <ToolButton
            variant="panel"
            size="xs"
            label="Clear the filter"
            onClick={() => {
              setQuery("");
              filterRef.current?.focus();
            }}
            className="absolute right-3"
          >
            <X className="size-3.5" />
          </ToolButton>
        )}
      </div>
      <div
        ref={treeRef}
        role="tree"
        aria-label={search.active ? `Files matching ${query.trim()}` : `Files in ${name}`}
        aria-busy={search.searching || undefined}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        {search.active && search.error ? (
          <p role="alert" className="px-3 py-2 text-xs text-destructive">
            {search.error}
          </p>
        ) : search.active && !search.results ? (
          <Loading text="Searching…" />
        ) : search.active && found === 0 ? (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            {search.searching ? "Searching…" : `Nothing in ${name} matches “${query.trim()}”.`}
          </p>
        ) : rootError && !search.active ? (
          <p className="px-3 py-2 text-xs text-destructive">{rootError}</p>
        ) : !search.active && !folders.has("") ? (
          <Loading text="Loading…" />
        ) : rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">This folder is empty.</p>
        ) : (
          rows.map(({ entry, depth }) => {
            const isOpen = !search.active && expanded.has(entry.path);
            // A folder that could not be listed says why, where its entries would be.
            const error = entry.kind === "directory" && isOpen ? errors.get(entry.path) : undefined;
            return (
              <Fragment key={entry.path}>
                <TreeItem
                  entry={entry}
                  depth={depth}
                  open={isOpen}
                  // Among what the filter found, a row says which folder it is in.
                  where={search.active ? parentOf(entry.path) : undefined}
                  selected={entry.path === selected}
                  tabStop={entry.path === tabStop}
                  renaming={entry.path === renaming}
                  onClick={() => activate(entry)}
                  onToggle={() => toggleRow(entry)}
                  onFocus={() => setFocused(entry.path)}
                  onRename={(newName) => void rename(entry, newName)}
                  onCancelRename={() => {
                    setRenaming(null);
                    rowElement(entry.path)?.focus();
                  }}
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
        {search.active && search.results?.truncated && (
          <p className="px-3 py-2 text-2xs text-muted-foreground">
            The first {found} {plural(found, "match", "matches")}. Type more to narrow it down.
          </p>
        )}
      </div>
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          entry={menu.entry}
          absolute={absolutePath(root, menu.entry.path)}
          expanded={!search.active && expanded.has(menu.entry.path)}
          onOpen={() => activate(menu.entry)}
          onToggle={() => toggleRow(menu.entry)}
          onRename={() => setRenaming(menu.entry.path)}
          onNewFolder={() => void newFolder(menu.entry.path)}
          onTrash={() => void trash(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * Follows the watcher for the tree. Its reports come in bursts while the agent works: what
 * changed adds up, and once the reports pause the folders on show are listed again, each once. A
 * collapsed folder is only forgotten, to be listed when it opens; and nothing is listed while the
 * tree is out of sight, which catches up as it shows again. It shows nothing, and renders on its
 * own as reports come and the tree shows or hides, not the tree with its rows.
 */
function FollowWatcher(props: {
  loaded: RefObject<ReadonlyMap<string, unknown>>;
  expanded: RefObject<ReadonlySet<string>>;
  reload: (paths: readonly string[]) => Promise<unknown>;
  forget: (paths: readonly string[]) => void;
}) {
  const { loaded, expanded, reload, forget } = props;
  const change = useApp((s) => s.workspaceChange);
  /** The tree is on show: the sidebar is open on its tab. */
  const showing = useApp((s) => s.sidebarOpen && s.sidebarTab === "files");
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
      const stale = foldersToReload([...changed.current], loaded.current.keys());
      changed.current.clear();
      const shown = (folder: string) => folder === "" || expanded.current.has(folder);
      forget(stale.filter((folder) => !shown(folder)));
      void reload(stale.filter(shown));
    }, TREE_RELOAD_DELAY);
    return () => clearTimeout(timer);
  }, [change, showing, reload, forget, loaded, expanded]);
  return null;
}

function Loading({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      {text}
    </p>
  );
}

/** A row's indent: the tree's edge, then a step for each folder it is in. */
const INDENT_BASE = 8;
const INDENT_STEP = 12;

/**
 * A row of the tree. A deck's folder shows the deck's icon and title, with the folder's name
 * small after it; pressing the row opens the deck, and its arrow shows the folder's files.
 * While `renaming`, the name is a field: Enter or leaving it renames, Escape leaves it as it was.
 */
function TreeItem(props: {
  entry: WorkspaceEntry;
  depth: number;
  open: boolean;
  /** The folder the row is in, to say after its name; left out in the tree, which shows it. */
  where?: string;
  selected: boolean;
  /** The one row Tab stops at; the arrows go to the others. */
  tabStop: boolean;
  renaming: boolean;
  onClick: () => void;
  /** Opens or closes the folder, from its arrow. */
  onToggle: () => void;
  onFocus: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const { entry, depth, open, selected } = props;
  const folder = entry.kind === "directory";
  const deck = isDeckFolder(entry);
  const Icon = deck ? Presentation : entry.kind === "directory" ? (open ? FolderOpen : Folder) : ICONS[entry.kind];
  const kind = deck ? KIND_LABELS.deck : KIND_LABELS[entry.kind];
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a row holds a name field and an arrow, so it is no button; the tree takes the keys of all its rows
    <div
      role="treeitem"
      data-path={entry.path}
      aria-level={depth + 1}
      aria-label={displayName(entry)}
      aria-expanded={folder ? open : undefined}
      aria-selected={selected}
      tabIndex={props.tabStop ? 0 : -1}
      title={`${entry.path} · ${kind}`}
      onClick={props.renaming ? undefined : props.onClick}
      onFocus={props.onFocus}
      onContextMenu={props.onContextMenu}
      style={{ paddingLeft: INDENT_BASE + depth * INDENT_STEP }}
      className={cn(
        "flex w-full cursor-default items-center gap-1 py-0.5 pr-2 text-left text-xs outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/40",
        selected && "bg-accent font-medium text-foreground",
        !selected && entry.kind === "file" && "text-muted-foreground",
      )}
    >
      {/* The arrow is the pointer's way to open a folder that opens something else when pressed (a deck's); the keys use → and ←. */}
      <span
        aria-hidden
        data-testid={folder ? "tree-arrow" : undefined}
        onClick={
          folder
            ? (event) => {
                event.stopPropagation();
                props.onToggle();
              }
            : undefined
        }
        className={cn("flex shrink-0 rounded-sm", folder && "hover:bg-foreground/10")}
      >
        <ChevronRight className={cn("size-3 text-muted-foreground", !folder && "invisible", open && "rotate-90")} />
      </span>
      <Icon
        className={cn("size-3.5 shrink-0", deck || entry.kind === "deck" ? "text-primary" : "text-muted-foreground")}
      />
      {props.renaming ? (
        <NameField entry={entry} onRename={props.onRename} onCancel={props.onCancelRename} />
      ) : (
        <>
          <span className="truncate">{displayName(entry)}</span>
          {(deck || props.where) && (
            <span className="min-w-8 flex-1 truncate font-normal text-2xs text-muted-foreground">
              {deck ? (props.where ? `${props.where}/${entry.name}` : entry.name) : props.where}
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** The field a row's name is typed in while it is renamed; it opens with the name selected, without the extension. */
function NameField(props: { entry: WorkspaceEntry; onRename: (name: string) => void; onCancel: () => void }) {
  const { entry } = props;
  const ref = useRef<HTMLInputElement>(null);
  /** Set once the field has answered: leaving it after Enter or Escape does not answer again. */
  const done = useRef(false);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(...nameSelection(entry.name, entry.kind === "directory"));
  }, [entry.name, entry.kind]);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    if (name === null) props.onCancel();
    else props.onRename(name);
  };
  return (
    <input
      ref={ref}
      type="text"
      aria-label={`New name for ${entry.name}`}
      defaultValue={entry.name}
      spellCheck={false}
      onClick={(event) => event.stopPropagation()}
      onBlur={(event) => finish(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(event.currentTarget.value);
        } else if (event.key === "Escape") {
          // Escape is the field's: nothing else closes for it.
          event.stopPropagation();
          finish(null);
        }
      }}
      className="h-5 min-w-0 flex-1 rounded-sm border border-primary/60 bg-background px-1 font-normal text-foreground outline-none"
    />
  );
}
