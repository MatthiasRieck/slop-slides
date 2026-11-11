import { api, type Deck, type OpenedFile, type WorkspaceInfo } from "../lib/api";
import { loadText, saveText } from "../lib/storage";
import { basename } from "../lib/utils";
import { leaveChat, loadChat } from "./chat";
import { confirmDiscard, confirmStopAgent } from "./confirm";
import { NO_EDIT_STATE } from "./editing";
import { showErrorIn } from "./errors";
import { refreshHistory } from "./history";
import { workspaceName } from "./paths";
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
  /** Back to the start screen; false when the user kept unsaved edits, or the agent's running turn, instead. */
  closeWorkspace: () => Promise<boolean>;
  /**
   * Opens a workspace file (by its workspace-relative path) in the viewer for its kind. `byAgent`:
   * the agent asked to show it, which the folder's own chat follows (staying on show while its
   * turn runs); a deck's chat stays with its deck, and says so instead.
   */
  openPath: (path: string, options?: { byAgent?: boolean }) => Promise<void>;
  /**
   * Opens a deck by its id (the deck file's absolute path), and its chat with it; while the
   * agent works in the chat on show, the user stops it first or stays. False when it did not open.
   */
  openDeck: (id: string, options?: OpenDeckOptions) => Promise<boolean>;
  /** Creates a deck at the root of the open workspace and opens it. */
  createDeck: (title: string, template?: string | null) => Promise<void>;
  /** Makes a deck from the PowerPoint file at `path`, in the workspace, and opens it. */
  importPptx: (path: string) => Promise<void>;
  /**
   * Closes the open file, back to the folder and its own chat; false when it stays open: the
   * user kept unsaved edits or the agent's running turn, or another window shows that chat.
   */
  closeDeck: () => Promise<boolean>;
  setCodeDirty: (dirty: boolean) => void;
}

/** How a deck opens (see `WorkspaceSlice.openDeck`). */
export interface OpenDeckOptions {
  /** The folder's own chat stays on show: it made the deck and is still at work on it. */
  keepChat?: boolean;
  /** A deck that cannot open (say, open in another window) is passed over without a word. */
  quiet?: boolean;
}

/** The file last open in each workspace, reopened with it: `slopslide.lastFile:<root>`. */
const LAST_FILE_KEY = "slopslide.lastFile:";

/** Whether the user gives up the unsaved edits in the sidebar's HTML tab. */
export function confirmDiscardEdits(app: AppStore): Promise<boolean> {
  const name = basename(app.getState().deck?.id ?? "") || "the deck";
  return confirmDiscard(`You have unsaved changes to ${name}. Discard them?`);
}

/**
 * Gets what is open ready to give way, the chat about `next` coming on show (null: none). False
 * when the user stays: for unsaved edits, or for the agent's turn, which ends with its chat
 * leaving.
 */
async function leaveFile(app: AppStore, next: string | null): Promise<boolean> {
  const { deck, codeDirty, running, chatKey, workspace } = app.getState();
  if (deck && codeDirty && !(await confirmDiscardEdits(app))) return false;
  const leaving = chatKey !== next;
  if (leaving && running) {
    const about = deck ? basename(deck.id) : (workspace?.name ?? "this folder");
    if (!(await confirmStopAgent(`The agent is still working in the chat of ${about}. Stop it to go on?`))) {
      return false;
    }
  }
  if (deck) await flushReview(app);
  if (leaving) await leaveChat(app);
  return true;
}

/** Reopens `path` the next time its workspace opens. */
function rememberFile(app: AppStore, path: string) {
  const { workspace } = app.getState();
  if (workspace) saveText(LAST_FILE_KEY + workspace.path, path);
}

/** Shows the workspace file `path` in the viewer its kind calls for: a deck in the editor. */
async function openFileAt(app: AppStore, path: string, file: OpenedFile, options: OpenDeckOptions = {}) {
  const { closeDeck, openDeck } = app.getState();
  if (file.kind === "deck") return openDeck(file.absolute, options);
  if (!(await closeDeck())) return false;
  rememberFile(app, path);
  app.setState((s) => ({ openedFile: file, fileRev: s.fileRev + 1 }));
  return true;
}

/**
 * Opens deck `id` in the editor and its chat beside it, whatever was open (see `leaveFile`)
 * giving way. False, saying why unless `quiet`, when the deck cannot open; what was open stays.
 */
async function switchToDeck(app: AppStore, id: string, { keepChat = false, quiet = false }: OpenDeckOptions) {
  let deck: Deck;
  try {
    deck = await api.openDeck(id, { keepChat, quiet });
  } catch (error) {
    if (!quiet) showErrorIn(app, error);
    return false;
  }
  const path = workspaceName(app.getState().workspace, id);
  rememberFile(app, path);
  app.setState({ ...NO_DECK, openedFile: { path, absolute: id, kind: "deck" } });
  await loadDeckState(app, deck);
  if (keepChat) app.setState({ chatFollowsDeck: true });
  else await loadChat(app, id);
  return true;
}

/** The editor with no deck in it. */
const NO_DECK = {
  codeDirty: false,
  chatFollowsDeck: false,
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
  slideMode: "view" as const,
  editTool: "select" as const,
  ...NO_EDIT_STATE,
  ...NO_RAIL_STATE,
};

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
      await loadChat(app, workspace.path);
    } catch (error) {
      showErrorIn(app, error);
      return;
    }
    const workspacePath = get().workspace!.path;
    const last = loadText(LAST_FILE_KEY + workspacePath);
    // The folder's chat, still at work, stays on show rather than give way to a deck's.
    if (last === null || get().running) return get().setSidebarTab("files");
    let opened = false;
    try {
      // A deck open in another window stays there: this one starts at the files.
      opened = await openFileAt(app, last, await api.openFile(last), { quiet: true });
    } catch {
      // A file that is gone since just leaves the viewer empty.
      saveText(LAST_FILE_KEY + workspacePath, null);
    }
    if (!opened) get().setSidebarTab("files");
  },

  closeWorkspace: async () => {
    if (!get().workspace) return true;
    if (!(await leaveFile(app, null))) return false;
    await api.closeWorkspace();
    set({
      ...NO_DECK,
      workspace: null,
      workspaceChange: null,
      chatKey: null,
      messages: [],
      queue: [],
      running: false,
      sessionProvider: null,
    });
    return true;
  },

  openPath: async (path, { byAgent = false } = {}) => {
    const { workspace, openedFile, chatKey, deck } = get();
    if (!workspace || openedFile?.path === path) return;
    if (byAgent && deck && chatKey === deck.id) {
      // A deck's chat stays with its deck; going to the file is the user's to do.
      set({ error: `The agent made ${path}. Open it from the Files tab: this chat stays with ${basename(deck.id)}.` });
      return;
    }
    try {
      await openFileAt(app, path, await api.openFile(path), { keepChat: byAgent });
    } catch (error) {
      showErrorIn(app, error);
    }
  },

  openDeck: async (id, options = {}) => {
    if (get().deck?.id === id) return true;
    const { chatKey, workspace } = get();
    // Only the folder's own chat stays beside a deck.
    const keepChat = !!options.keepChat && chatKey === workspace?.path;
    if (!(await leaveFile(app, keepChat ? chatKey : id))) return false;
    return switchToDeck(app, id, { ...options, keepChat });
  },

  createDeck: async (title, template = null) => {
    if (!(await leaveFile(app, null))) return;
    try {
      const deck = await api.createDeck(title, template);
      await switchToDeck(app, deck.id, {});
    } catch (error) {
      showErrorIn(app, error);
    }
  },

  importPptx: async (path) => {
    if (!(await leaveFile(app, null))) return;
    try {
      const { deck, skipped } = await api.importPptx(path);
      await switchToDeck(app, deck.id, {});
      if (skipped.length > 0) set({ error: `Imported, with these changes: ${skipped.join("; ")}.` });
    } catch (error) {
      showErrorIn(app, error);
    }
  },

  closeDeck: async () => {
    const { deck, workspace } = get();
    if (!deck) {
      set({ openedFile: null });
      return true;
    }
    if (!(await leaveFile(app, workspace?.path ?? null))) return false;
    try {
      await api.closeDeck();
    } catch (error) {
      showErrorIn(app, error);
      return false;
    }
    set(NO_DECK);
    if (workspace && get().chatKey !== workspace.path) await loadChat(app, workspace.path);
    return true;
  },

  setCodeDirty: (codeDirty) => set({ codeDirty }),
});
