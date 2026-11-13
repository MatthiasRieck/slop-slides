import { api, type Deck, type OpenedFile, type WorkspaceInfo } from "../lib/api";
import { loadText, saveText } from "../lib/storage";
import { basename, dirname } from "../lib/utils";
import { leaveChat, loadChat } from "./chat";
import { askUnsaved, confirmStopAgent } from "./confirm";
import { NO_EDIT_STATE } from "./editing";
import { showErrorIn, showInfoIn } from "./errors";
import { refreshHistory } from "./history";
import { relativePath, workspaceName } from "./paths";
import { flushReview, reviewLoaded } from "./review";
import { NO_SEARCH } from "./search";
import { NO_RAIL_STATE, railStateOf } from "./slides";
import type { AppState, AppStore, Slice } from "./types";

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
  /**
   * Opens the deck file at the absolute path `file` in `folder` (the folder the file is in,
   * unless given), which becomes the workspace: how a deck opens from outside a workspace.
   */
  openDeckFile: (file: string, folder?: string) => Promise<void>;
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
  /** Gives the open deck the title `title`; false when it is empty or the deck could not be renamed. */
  renameDeck: (title: string) => Promise<boolean>;
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

/** Saves what the sidebar's HTML tab holds to the deck file, while the tab's editor is there to. */
type CodeSave = () => Promise<void>;
let codeSave: CodeSave | null = null;

/**
 * Lets the store save the HTML tab's edits: the editor (components/CodeView.tsx) gives its own
 * save while it is mounted. Returns what takes it back.
 */
export function provideCodeSave(save: CodeSave): () => void {
  codeSave = save;
  return () => {
    if (codeSave === save) codeSave = null;
  };
}

/**
 * Saves the HTML tab's edits to the deck file. False when they are still unsaved after it (the
 * file changed on disk meanwhile, say): the tab then shows, where the editor says why.
 */
async function saveCodeEdits(app: AppStore): Promise<boolean> {
  await codeSave?.();
  if (!app.getState().codeDirty) return true;
  app.getState().setSidebarTab("code");
  return false;
}

/**
 * Settles the unsaved edits in the sidebar's HTML tab before what would lose them: the user
 * saves them, gives them up, or stays. True when nothing unsaved is left to lose.
 */
export async function settleUnsavedEdits(app: AppStore): Promise<boolean> {
  const { deck, codeDirty } = app.getState();
  if (!deck || !codeDirty) return true;
  const answer = await askUnsaved(basename(deck.id) || "the deck");
  if (answer === "cancel") return false;
  return answer === "discard" || saveCodeEdits(app);
}

/** What leaving what is open is for, and what else stands in its way. */
interface LeaveOptions {
  /** What stopping the agent is for, as the question ends: "Stop it to …?" */
  to?: string;
  /** Asked after the unsaved edits and before the agent's turn; false when the user stays for it. */
  alsoAsk?: () => Promise<boolean>;
}

/**
 * Gets what is open ready to give way, the chat about `next` coming on show (null: none). False
 * when the user stays: for unsaved edits (which they can save or give up instead), for what
 * `alsoAsk` asks about, or for the agent's turn, which ends with its chat leaving.
 */
async function leaveFile(app: AppStore, next: string | null, options: LeaveOptions = {}): Promise<boolean> {
  if (!(await settleUnsavedEdits(app))) return false;
  const { deck, running, chatKey, workspace } = app.getState();
  if (options.alsoAsk && !(await options.alsoAsk())) return false;
  const leaving = chatKey !== next;
  if (leaving && running) {
    const about = deck ? basename(deck.id) : (workspace?.name ?? "this folder");
    const to = options.to ?? "go on";
    if (!(await confirmStopAgent(`The agent is still working in the chat of ${about}. Stop it to ${to}?`))) {
      return false;
    }
  }
  if (deck) await flushReview(app);
  if (leaving) await leaveChat(app);
  return true;
}

/**
 * Gets what is open ready for its window to close, as for any leaving (see `leaveFile`): the
 * user is asked about unsaved edits, about what `alsoAsk` holds (changes kept outside this
 * store) and about the agent's running turn, and the review marks and the chat are saved. False
 * when the user stays, and the window with them.
 */
export function leaveForClose(app: AppStore, alsoAsk?: () => Promise<boolean>): Promise<boolean> {
  return leaveFile(app, null, { to: "close the window", alsoAsk });
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
  const { workspace } = app.getState();
  rememberFile(app, workspaceName(workspace, id));
  showDeck(app, id, deck, { workspace });
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

/** The workspace a deck shows in; `workspaceChange` is reset when the workspace opens with the deck. */
type WorkspaceOpening = Pick<AppState, "workspace"> & Partial<Pick<AppState, "workspaceChange">>;

/**
 * Shows the deck just opened from the file `id`, the editor starting afresh on it, in the
 * workspace `workspace` (which may open with it). One change of state: the window goes from
 * what it showed to the deck, with nothing in between.
 */
function showDeck(app: AppStore, id: string, deck: Deck, opening: WorkspaceOpening) {
  const { workspace } = opening;
  reviewLoaded(deck);
  app.setState({
    ...NO_DECK,
    ...opening,
    openedFile: { path: workspaceName(workspace, id), absolute: id, kind: "deck" },
    deck,
    selected: deck.slides[0]?.id ?? null,
    assetsRev: 0,
    sketches: deck.review ?? {},
    comments: deck.comments ?? {},
    search: NO_SEARCH,
    ...railStateOf(deck.id),
  });
  void refreshHistory(app);
}

/** What a workspace opens with: the file last open in it, if it can show again. */
interface Reopened {
  /** The file last open, when it is still there and the folder's own chat does not stay on show. */
  file: OpenedFile | null;
  /** That file's deck, open again in the backend. */
  deck: Deck | null;
}

/**
 * Opens again what was last open in `workspace`, in the backend only. The folder's chat, still
 * at work, stays on show rather than give way to a deck's, so nothing reopens then; a deck open
 * in another window stays there; and a file that is gone since is forgotten.
 */
async function reopenLast(workspace: WorkspaceInfo): Promise<Reopened> {
  const key = LAST_FILE_KEY + workspace.path;
  const last = loadText(key);
  if (last === null) return { file: null, deck: null };
  // Neither waits for the other: what the file is, and whether the folder's agent is at work.
  const [file, busy] = await Promise.all([
    api.openFile(last).catch(() => null),
    api.agentRunning(workspace.path).catch(() => false),
  ]);
  if (!file) saveText(key, null);
  if (!file || busy) return { file: null, deck: null };
  if (file.kind !== "deck") return { file, deck: null };
  try {
    return { file, deck: await api.openDeck(file.absolute, { keepChat: false, quiet: true }) };
  } catch {
    return { file: null, deck: null };
  }
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
    let workspace: WorkspaceInfo;
    try {
      workspace = await api.openWorkspace(path);
    } catch (error) {
      showErrorIn(app, error);
      return;
    }
    const { file, deck } = await reopenLast(workspace);
    try {
      if (file && deck) {
        // The folder and its deck show together, and only the deck's chat is loaded: the
        // folder's own would give way to it at once.
        showDeck(app, file.absolute, deck, { workspace, workspaceChange: null });
        await loadChat(app, file.absolute);
        return;
      }
      set((s) => ({ workspace, openedFile: file, fileRev: s.fileRev + (file ? 1 : 0), workspaceChange: null }));
      await loadChat(app, workspace.path);
    } catch (error) {
      showErrorIn(app, error);
      return;
    }
    if (!file) get().setSidebarTab("files");
  },

  openDeckFile: async (file, folder = dirname(file)) => {
    await get().openWorkspace(folder);
    const { workspace } = get();
    // The folder may not have opened: it is open, without a deck, in another window.
    if (!workspace) return;
    await get().openPath(relativePath(workspace, file) ?? basename(file));
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
      showInfoIn(app, `The agent made ${path}. This chat stays with ${basename(deck.id)}.`, {
        label: "Open",
        run: () => void get().openPath(path),
      });
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
      if (skipped.length > 0) showInfoIn(app, `Imported, with these changes: ${skipped.join("; ")}.`);
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

  renameDeck: async (title) => {
    const { deck } = get();
    const next = title.trim();
    if (!deck || !next) return false;
    if (next === deck.title) return true;
    try {
      const renamed = await api.renameDeck(deck.id, next);
      if (get().deck?.id === deck.id) get().setDeck(renamed);
      return true;
    } catch (error) {
      showErrorIn(app, error);
      return false;
    }
  },

  setCodeDirty: (codeDirty) => set({ codeDirty }),
});
