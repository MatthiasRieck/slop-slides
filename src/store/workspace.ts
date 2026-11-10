import { api, type Deck, errorMessage, type OpenedFile, type WorkspaceInfo } from "../lib/api";
import { loadText, saveText } from "../lib/storage";
import { basename } from "../lib/utils";
import { loadWorkspaceChat } from "./chat";
import { confirmDiscard } from "./confirm";
import { NO_EDIT_STATE } from "./editing";
import { showErrorIn } from "./errors";
import { refreshHistory } from "./history";
import { settleInterrupted } from "./messages";
import { relativePath, workspaceName } from "./paths";
import { flushReview, reviewLoaded } from "./review";
import { NO_SEARCH } from "./search";
import { NO_RAIL_STATE } from "./slides";
import type { AppStore, Slice } from "./types";

/** Files changed on disk in the open workspace, as the watcher reported them last. */
export interface WorkspaceChange {
  /** Workspace-relative, `/`-separated. */
  paths: string[];
  rev: number;
}

/** The folder open in the app and the file open in it: opening, creating and closing them. */
export interface WorkspaceSlice {
  /** The folder open in the file tree; null on the start screen. */
  workspace: WorkspaceInfo | null;
  /** The workspace file shown in the main area: a deck (also in `deck`) or another page. */
  openedFile: OpenedFile | null;
  /** Bumped when the open file (not a deck) changes on disk, so its viewer reloads. */
  fileRev: number;
  /** What changed on disk last, for the file tree to reload those folders. */
  workspaceChange: WorkspaceChange | null;
  /** Bumped when attached assets change, reloading every slide preview. */
  assetsRev: number;
  /** The sidebar's HTML tab holds edits that are not saved to the deck file yet. */
  codeDirty: boolean;

  /** Opens a folder in the file tree, reopening the file last open in it. */
  openWorkspace: (path: string) => Promise<void>;
  /** Back to the start screen; false when the user kept unsaved edits instead. */
  closeWorkspace: () => Promise<boolean>;
  /** Opens a workspace file (by its workspace-relative path) in the viewer for its kind. */
  openPath: (path: string) => Promise<void>;
  /** Opens a deck by its id (the deck file's absolute path). */
  openDeck: (id: string) => Promise<void>;
  /** Creates a deck at the root of the open workspace and opens it. */
  createDeck: (title: string, template?: string | null) => Promise<void>;
  /** Makes a deck from the PowerPoint file at `path`, in the workspace, and opens it. */
  importPptx: (path: string) => Promise<void>;
  /** Closes the open file; false when the user kept unsaved edits instead. */
  closeDeck: () => Promise<boolean>;
  setCodeDirty: (dirty: boolean) => void;
}

/** The file last open in each workspace, reopened with it: `slopslide.lastFile:<root>`. */
const LAST_FILE_KEY = "slopslide.lastFile:";

/** Whether the user gives up the unsaved edits in the sidebar's HTML tab. */
export function confirmDiscardEdits(app: AppStore): Promise<boolean> {
  const name = basename(app.getState().deck?.id ?? "") || "the deck";
  return confirmDiscard(`You have unsaved changes to ${name}. Discard them?`);
}

/** Reopens `path` the next time its workspace opens. */
function rememberFile(app: AppStore, path: string) {
  const { workspace } = app.getState();
  if (workspace) saveText(LAST_FILE_KEY + workspace.path, path);
}

/** Shows the workspace file `path` in the viewer its kind calls for: a deck in the editor. */
async function openFileAt(app: AppStore, path: string, file: OpenedFile) {
  const { closeDeck, openDeck } = app.getState();
  if (file.kind === "deck") return openDeck(file.absolute);
  if (!(await closeDeck())) return;
  rememberFile(app, path);
  app.setState((s) => ({ openedFile: file, fileRev: s.fileRev + 1 }));
}

/** Shows the deck at workspace path `path` in the editor, remembering it as the workspace's open file. */
async function showDeck(app: AppStore, path: string, deck: Deck) {
  rememberFile(app, path);
  app.setState({ openedFile: { path, absolute: deck.id, kind: "deck" } });
  await loadDeckState(app, deck);
}

/** Starts the editor afresh on a deck just opened. */
async function loadDeckState(app: AppStore, deck: Deck) {
  reviewLoaded(deck);
  app.setState({
    deck,
    selected: deck.slides[0]?.id ?? null,
    assetsRev: 0,
    presenting: false,
    lint: null,
    composerFill: null,
    sketches: deck.review ?? {},
    sketchesSent: {},
    comments: deck.comments ?? {},
    commentsHeld: {},
    imageExport: null,
    search: NO_SEARCH,
    editing: false,
    slideMode: "view",
    editTool: "select",
    ...NO_EDIT_STATE,
    ...NO_RAIL_STATE,
  });
  void refreshHistory(app);
}

export const createWorkspaceSlice: Slice<WorkspaceSlice> = (set, get, app) => ({
  workspace: null,
  openedFile: null,
  fileRev: 0,
  workspaceChange: null,
  assetsRev: 0,
  codeDirty: false,

  openWorkspace: async (path) => {
    if (get().workspace?.path === path) return;
    if (!(await get().closeWorkspace())) return;
    try {
      const workspace = await api.openWorkspace(path);
      set({ workspace, openedFile: null, workspaceChange: null });
      await loadWorkspaceChat(app, workspace.path);
    } catch (error) {
      showErrorIn(app, error);
      return;
    }
    const workspacePath = get().workspace!.path;
    const last = loadText(LAST_FILE_KEY + workspacePath);
    if (last === null) return get().setSidebarTab("files");
    // A file that is gone since just leaves the viewer empty.
    try {
      await openFileAt(app, last, await api.openFile(last));
    } catch {
      saveText(LAST_FILE_KEY + workspacePath, null);
      get().setSidebarTab("files");
    }
  },

  closeWorkspace: async () => {
    if (!get().workspace) return true;
    if (!(await get().closeDeck())) return false;
    const { workspace, messages, running } = get();
    if (workspace) {
      if (running) await api.interruptAgent(workspace.path);
      await api.saveChat(workspace.path, messages.map(settleInterrupted));
    }
    await api.closeWorkspace();
    set({
      workspace: null,
      openedFile: null,
      workspaceChange: null,
      messages: [],
      queue: [],
      running: false,
      sessionProvider: null,
    });
    return true;
  },

  openPath: async (path) => {
    const { workspace, openedFile } = get();
    if (!workspace || openedFile?.path === path) return;
    try {
      await openFileAt(app, path, await api.openFile(path));
    } catch (error) {
      showErrorIn(app, error);
    }
  },

  openDeck: async (id) => {
    if (get().deck?.id === id) return;
    if (!(await get().closeDeck())) return;
    try {
      const deck = await api.openDeck(id);
      const path = relativePath(get().workspace, id);
      if (path !== null) rememberFile(app, path);
      set({ openedFile: { path: path ?? basename(id), absolute: id, kind: "deck" } });
      await loadDeckState(app, deck);
    } catch (error) {
      set({ openedFile: null, error: errorMessage(error) });
    }
  },

  createDeck: async (title, template = null) => {
    if (!(await get().closeDeck())) return;
    try {
      const deck = await api.createDeck(title, template);
      await showDeck(app, workspaceName(get().workspace, deck.id), deck);
    } catch (error) {
      showErrorIn(app, error);
    }
  },

  importPptx: async (path) => {
    if (!(await get().closeDeck())) return;
    try {
      const { deck, skipped } = await api.importPptx(path);
      await showDeck(app, workspaceName(get().workspace, deck.id), deck);
      if (skipped.length > 0) set({ error: `Imported, with these changes: ${skipped.join("; ")}.` });
    } catch (error) {
      showErrorIn(app, error);
    }
  },

  closeDeck: async () => {
    if (!get().deck) {
      set({ openedFile: null });
      return true;
    }
    if (get().codeDirty && !(await confirmDiscardEdits(app))) return false;
    await flushReview(app);
    set({
      codeDirty: false,
      openedFile: null,
      deck: null,
      selected: null,
      presenting: false,
      lint: null,
      composerFill: null,
      composerImages: [],
      sketches: {},
      sketchesSent: {},
      comments: {},
      commentsHeld: {},
      imageExport: null,
      editing: false,
      slideMode: "view",
      editTool: "select",
      ...NO_EDIT_STATE,
      ...NO_RAIL_STATE,
    });
    return true;
  },

  setCodeDirty: (codeDirty) => set({ codeDirty }),
});
