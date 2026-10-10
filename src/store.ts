import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";

import {
  api,
  errorMessage,
  type AgentEvent,
  type AgentEventEnvelope,
  type Deck,
  type LintIssue,
  type OpenedFile,
  type Slide,
  type TemplateSummary,
  type WorkspaceChanged,
  type WorkspaceInfo,
} from "./lib/api";
import { latestContext, mergeContext, type ContextUsage } from "./lib/context";
import { inkBounds, type Stroke } from "./lib/ink";
import { DEFAULT_SIZE, pixelsOf, resizePrompt, sameSize, type SlideSize } from "./lib/slideSize";
import { basename, dirname, layoutLabel } from "./lib/utils";
import {
  defaultModel,
  pickContextWindow,
  pickEffort,
  requestEffort,
  type Provider,
  type ProviderInfo,
} from "./lib/models";

import { isPermissionMode, type Approval, type PermissionMode } from "./lib/permissions";

export type ChatPart =
  | { kind: "approval"; approval: Approval; status: "pending" | "resolved" | "expired" }
  | { kind: "approvalReview"; id: string; status: string; detail: string | null }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: Record<string, unknown>;
      status: "running" | "done" | "error";
    };

export interface UserMessage {
  id: string;
  role: "user";
  text: string;
  slide: string | null;
  attachments: string[];
  /** The user drew on the slide before sending; absent in chats saved before sketches. */
  sketch?: Sketch | null;
  /** Absolute path of a screenshot of the slide sent along (for tidying hand edits). */
  screenshot?: string | null;
  /** Set when the message ran a command instead of prompting the agent. */
  command?: "compact";
  createdAt: number;
}

/** What the agent is told about a drawing on the current slide. */
export interface Sketch {
  /** Absolute path of the slide screenshot with the drawing (in the deck's session); null if it failed. */
  image: string | null;
  /** The marked area in slide pixels. */
  bounds: { left: number; top: number; right: number; bottom: number };
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  parts: ChatPart[];
  status: "streaming" | "done" | "interrupted" | "error";
  thinking: boolean;
  error: string | null;
  costUsd: number | null;
  durationMs: number | null;
  /** The provider that wrote this reply; absent in chats saved before it was recorded. */
  provider?: Provider;
  /** How full the provider's context was after this reply, as far as it was reported. */
  context?: ContextUsage | null;
  /** The agent is summarizing the conversation. */
  compacting?: boolean;
  /** The conversation was summarized during this reply. */
  compacted?: boolean;
  createdAt: number;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface ModelSelection {
  provider: Provider;
  model: string;
  /** Shown until the provider list arrives. */
  label: string;
  effort: string;
  /** Claude only; `null` when the model has a single context window. */
  contextWindow: string | null;
}

const PERMISSION_KEY = "slopslide.codexPermissions";
function loadPermissions(): PermissionMode {
  const saved = localStorage.getItem(PERMISSION_KEY);
  return isPermissionMode(saved) ? saved : "ask";
}

const SELECTION_KEY = "slopslide.selection";
const REVIEW_VISIBLE_KEY = "slopslide.reviewVisible";
const FAVORITES_KEY = "slopslide.favoriteModels";

const DEFAULT_SELECTION: ModelSelection = {
  provider: "claude",
  model: "claude-opus-5-5",
  label: "Claude Opus 5.5",
  effort: "medium",
  contextWindow: "1m",
};

function loadSelection(): ModelSelection {
  try {
    const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "null") as Partial<ModelSelection> | null;
    if (saved?.provider && saved.model && saved.label && saved.effort) {
      return { ...saved, contextWindow: saved.contextWindow ?? null } as ModelSelection;
    }
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_SELECTION;
}

function saveSelection(selection: ModelSelection) {
  localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
  useApp.setState({ selection });
}

/** Moves a selection that is no longer offered onto an installed provider's default model. */
function reconcileSelection(selection: ModelSelection, providers: ProviderInfo[]): ModelSelection {
  const current = providers.find((p) => p.id === selection.provider);
  const model = current?.models.find((m) => m.id === selection.model);
  if (model) {
    return {
      ...selection,
      label: model.label,
      effort: pickEffort(model, selection.effort),
      contextWindow: pickContextWindow(model, selection.contextWindow),
    };
  }
  // A provider whose models could not be listed keeps the saved choice rather than losing it.
  if (current?.installed && current.error) return selection;
  const fallback = [current, ...providers].find((p) => p?.installed && p.models.length > 0);
  const next = fallback && defaultModel(fallback);
  if (!fallback || !next) return selection;
  return {
    provider: fallback.id,
    model: next.id,
    label: next.label,
    effort: pickEffort(next, selection.effort),
    contextWindow: pickContextWindow(next, null),
  };
}

function loadFavorites(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export type StageView = "slides" | "code";

/** The right sidebar's tabs, in order (see components/Sidebar.tsx). */
export const SIDEBAR_TABS = ["chat", "files"] as const;
export type SidebarTab = (typeof SIDEBAR_TABS)[number];
const isSidebarTab = (value: unknown): value is SidebarTab => SIDEBAR_TABS.includes(value as SidebarTab);

const SIDEBAR_OPEN_KEY = "slopslide.sidebarOpen";
const SIDEBAR_TAB_KEY = "slopslide.sidebarTab";
/** The file last open in each workspace, reopened with it: `slopslide.lastFile:<root>`. */
const LAST_FILE_KEY = "slopslide.lastFile:";

/** Files changed on disk in the open workspace, as the watcher reported them last. */
export interface WorkspaceChange {
  /** Workspace-relative, `/`-separated. */
  paths: string[];
  rev: number;
}

interface AppState {
  /** The folder open in the file tree; null on the start screen. */
  workspace: WorkspaceInfo | null;
  /** The workspace file shown in the main area: a deck (also in `deck`) or another page. */
  openedFile: OpenedFile | null;
  /** Bumped when the open file (not a deck) changes on disk, so its viewer reloads. */
  fileRev: number;
  /** What changed on disk last, for the file tree to reload those folders. */
  workspaceChange: WorkspaceChange | null;
  deck: Deck | null;
  /** Id of the selected slide. */
  selected: string | null;
  /** Bumped whenever the user picks a slide, so views can reveal it even if unchanged. */
  revealRev: number;
  /** Whether the stage shows the rendered slide or the deck file's source. */
  view: StageView;
  /** The HTML view holds edits that are not saved to the deck file yet. */
  codeDirty: boolean;
  /** The right sidebar is shown; the user can collapse it to give the stage more room. */
  sidebarOpen: boolean;
  /** The sidebar tab shown. */
  sidebarTab: SidebarTab;
  /** The slide rail is shown; the user can collapse it to give the stage more room. */
  railOpen: boolean;
  /** Bumped when attached assets change, reloading every slide preview. */
  assetsRev: number;
  messages: ChatMessage[];
  running: boolean;
  selection: ModelSelection;
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  /** `provider:model` keys starred in the model picker. */
  favoriteModels: string[];
  presenting: boolean;
  /** Installed agent CLIs and their models; `undefined` while loading. */
  providers: ProviderInfo[] | undefined;
  error: string | null;
  /** Lint result for the saved deck file; null until the first check finishes. */
  lint: LintIssue[] | null;
  /**
   * Text to put in the chat composer, with a counter so the same text can be sent twice.
   * `screenshot` is a slide screenshot shown with the text and sent along with the message.
   */
  composerFill: { text: string; rev: number; screenshot?: string } | null;
  /**
   * Ink drawn on slides in the editor, by slide id. Saved in the deck file as review marks, and
   * sent along with the next message about the slide while it has changed since last sent.
   */
  sketches: Record<string, Stroke[]>;
  /** The marks each slide had when they were last sent (or skipped), so they go out once. */
  sketchesSent: Record<string, Stroke[]>;
  /** Review marks are shown on the stage (and sent to the agent). */
  reviewVisible: boolean;
  /** Slides being saved as images into `dir`, one at a time; null when not exporting. */
  imageExport: { dir: string; slides: string[] } | null;
  /** The stage lets the user edit text and move elements on the slide. */
  editing: boolean;
  /** Bumped when a slide edit could not be saved, so the stage reloads the slide from disk. */
  editReload: number;
  /** Slide edits that can be undone, newest last. */
  slideUndo: SlideUndo[];
  /** Templates for layouts and styles; `undefined` until loaded. */
  templates: TemplateSummary[] | undefined;
  /** Undone slide edits that can be redone, newest last. */
  slideRedo: SlideUndo[];

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
  /** Closes the open file; false when the user kept unsaved edits instead. */
  closeDeck: () => Promise<boolean>;
  setDeck: (deck: Deck) => void;
  select: (slide: string | null) => void;
  selectRelative: (delta: number) => void;
  setView: (view: StageView) => void;
  setCodeDirty: (dirty: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  /** Shows the sidebar on `tab`. */
  setSidebarTab: (tab: SidebarTab) => void;
  setRailOpen: (open: boolean) => void;
  setModel: (provider: Provider, model: string) => void;
  setEffort: (effort: string) => void;
  setContextWindow: (contextWindow: string) => void;
  refreshProviders: () => Promise<void>;
  toggleFavoriteModel: (key: string) => void;
  setPresenting: (presenting: boolean) => void;
  setError: (error: string | null) => void;
  refreshLint: () => Promise<void>;
  fillComposer: (text: string, options?: { screenshot?: string | null }) => void;
  setSketches: (update: (all: Record<string, Stroke[]>) => Record<string, Stroke[]>) => void;
  clearSketch: (slide: string) => void;
  /** Keeps the slide's current marks out of the next message. */
  skipSketch: (slide: string) => void;
  setReviewVisible: (visible: boolean) => void;
  startImageExport: (dir: string) => void;
  endImageExport: () => void;
  /** Enters or leaves edit mode, keeping the edits made so far. */
  setEditing: (editing: boolean) => void;
  /** Saves `markup` as the new version of `slide`, after any edits still being saved. */
  saveSlideEdit: (slide: string, markup: string) => Promise<void>;
  undoSlideEdit: () => Promise<void>;
  redoSlideEdit: () => Promise<void>;
  /** Undoes every edit made since entering edit mode, then leaves it. */
  discardSlideEdits: () => Promise<void>;
  refreshTemplates: () => Promise<void>;
  /**
   * Restyles the deck like the template: an empty deck takes its styles directly; otherwise
   * the composer gets a prompt asking the agent to.
   */
  applyStyle: (template: string) => Promise<void>;
  /**
   * Adds a slide on the template's layout `slide` after the selected one: a copy of it when
   * the deck uses that template, else a prompt in the composer for the agent.
   */
  addLayoutSlide: (template: string, slide: string) => Promise<void>;
  /** Puts a prompt in the composer to rebuild the selected slide on the template's layout. */
  changeLayout: (template: string, slide: string) => Promise<void>;
  /** Saves the deck as a user template with placeholder content; null when it failed. */
  saveAsTemplate: (name: string) => Promise<TemplateSummary | null>;
  /**
   * Screenshots the slide, leaves edit mode, and puts a prompt in the composer asking the agent
   * to rebuild the slide's layout around the user's hand edits, with the screenshot attached.
   * `overflow` lists elements the slide editor found running past the slide or cut off.
   */
  tidyLayout: (overflow?: string[]) => Promise<void>;
  /**
   * Gives every slide the canvas `size`, then (when the deck has slides) puts a prompt in the
   * composer asking the agent to lay the slides out again for it.
   */
  resizeSlides: (size: SlideSize) => Promise<void>;
  send: (
    text: string,
    options: { includeSlide: boolean; attachments: string[]; screenshot?: string },
  ) => Promise<void>;
  /** Has the agent summarize the conversation so far, freeing up its context. */
  compact: () => Promise<void>;
  interrupt: () => void;
  resetChat: () => Promise<void>;
}

interface SlideUndo {
  slide: string;
  /** Markup to restore. */
  markup: string;
  /** The slide's hash right after the edit; undo is refused once the slide changed again. */
  after: string;
}

const UNDO_KEPT = 50;

export const TIDY_PROMPT =
  "Tidy up the layout of this slide. I edited it by hand: keep my text and keep things where I moved them, at the size and angle I gave them, but rebuild the layout cleanly and fix any overflow or clipping.";

export const tidyPrompt = (overflow: string[] = []) =>
  overflow.length ? `${TIDY_PROMPT}\n\nThe editor found overflow:\n${overflow.map((o) => `- ${o}`).join("\n")}` : TIDY_PROMPT;

/** How a prompt names a template's layout: its readable name, the slide and file to read. */
const layoutRef = (template: TemplateSummary, slide: string, path: string) =>
  `the "${layoutLabel(slide)}" layout of the "${template.title}" template (slide \`${slide}\` in \`${path}\`)`;

export const stylePrompt = (template: TemplateSummary, path: string) =>
  `Restyle the whole deck in the "${template.title}" style. The template is at \`${path}\`: take over its design system (fonts, colors, styles, decorative elements) and rebuild every slide on its closest layout. Keep all content, slide ids, and sections, and set <meta name="slopslide-template" content="${template.id}">.`;

export const addLayoutPrompt = (template: TemplateSummary, slide: string, path: string, after: string | null) =>
  `Add a new slide ${after ? "after this one" : "at the end of the deck"} based on ${layoutRef(template, slide, path)}. Recreate the layout with this deck's design system and fill it with content that fits the deck.`;

export const changeLayoutPrompt = (template: TemplateSummary, slide: string, path: string) =>
  `Change the layout of this slide to ${layoutRef(template, slide, path)}. Only change the arrangement: keep this slide's id, its content, and its style (this deck's fonts, colors, and decorative elements), and do not take over the template's style.`;

const newId = () => crypto.randomUUID();
let lintRun = 0;
/** Slide edits are saved one after another, each based on the previous one's result. */
let editQueue: Promise<void> = Promise.resolve();

export const useApp = create<AppState>((set, get) => ({
  workspace: null,
  openedFile: null,
  fileRev: 0,
  workspaceChange: null,
  deck: null,
  selected: null,
  revealRev: 0,
  view: localStorage.getItem("slopslide.view") === "code" ? "code" : "slides",
  codeDirty: false,
  sidebarOpen: localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false",
  sidebarTab: loadSidebarTab(),
  railOpen: localStorage.getItem("slopslide.railOpen") !== "false",
  assetsRev: 0,
  messages: [],
  running: false,
  selection: loadSelection(),
  permissionMode: loadPermissions(),
  setPermissionMode: (permissionMode) => {
    if (get().running || !isPermissionMode(permissionMode)) return;
    localStorage.setItem(PERMISSION_KEY, permissionMode);
    set({ permissionMode });
  },
  favoriteModels: loadFavorites(),
  presenting: false,
  providers: undefined,
  error: null,
  lint: null,
  composerFill: null,
  sketches: {},
  sketchesSent: {},
  reviewVisible: localStorage.getItem(REVIEW_VISIBLE_KEY) !== "false",
  imageExport: null,
  editing: false,
  editReload: 0,
  slideUndo: [],
  slideRedo: [],
  templates: undefined,

  openWorkspace: async (path) => {
    if (get().workspace?.path === path) return;
    if (!(await get().closeWorkspace())) return;
    try {
      const workspace = await api.openWorkspace(path);
      set({ workspace, openedFile: null, workspaceChange: null });
      await loadWorkspaceChat(workspace.path);
    } catch (error) {
      set({ error: errorMessage(error) });
      return;
    }
    const workspacePath = get().workspace!.path;
    const last = localStorage.getItem(LAST_FILE_KEY + workspacePath);
    if (last === null) return get().setSidebarTab("files");
    // A file that is gone since just leaves the viewer empty.
    try {
      await openFileAt(last, await api.openFile(last));
    } catch {
      localStorage.removeItem(LAST_FILE_KEY + workspacePath);
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
    set({ workspace: null, openedFile: null, workspaceChange: null, messages: [], running: false });
    return true;
  },

  openPath: async (path) => {
    const { workspace, openedFile } = get();
    if (!workspace || openedFile?.path === path) return;
    try {
      await openFileAt(path, await api.openFile(path));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  openDeck: async (id) => {
    if (get().deck?.id === id) return;
    if (!(await get().closeDeck())) return;
    try {
      const deck = await api.openDeck(id);
      const path = relativePath(get().workspace, id);
      if (path !== null) rememberFile(path);
      set({ openedFile: { path: path ?? basename(id), absolute: id, kind: "deck" } });
      await loadDeckState(deck);
    } catch (error) {
      set({ openedFile: null, error: errorMessage(error) });
    }
  },

  createDeck: async (title, template = null) => {
    if (!(await get().closeDeck())) return;
    try {
      const deck = await api.createDeck(title, template);
      const path = relativePath(get().workspace, deck.id) ?? basename(deck.id);
      rememberFile(path);
      set({ openedFile: { path, absolute: deck.id, kind: "deck" } });
      await loadDeckState(deck);
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  closeDeck: async () => {
    if (!get().deck) {
      set({ openedFile: null });
      return true;
    }
    if (get().codeDirty && !(await confirmDiscardEdits())) return false;
    await flushReviewSave();
    set({ codeDirty: false, openedFile: null, deck: null, selected: null, presenting: false, lint: null, composerFill: null, sketches: {}, sketchesSent: {}, imageExport: null, editing: false, slideUndo: [], slideRedo: [] });
    return true;
  },

  setDeck: (deck) => {
    const { selected } = get();
    const stillThere = deck.slides.some((s) => s.id === selected);
    set({ deck, selected: stillThere ? selected : (deck.slides[0]?.id ?? null) });
  },

  select: (slide) => set((s) => ({ selected: slide, revealRev: s.revealRev + 1 })),

  selectRelative: (delta) => {
    const { deck, selected } = get();
    if (!deck || deck.slides.length === 0) return;
    const index = deck.slides.findIndex((s) => s.id === selected);
    const next = Math.min(deck.slides.length - 1, Math.max(0, index + delta));
    set((s) => ({ selected: deck.slides[next]?.id ?? null, revealRev: s.revealRev + 1 }));
  },

  setView: (view) => {
    localStorage.setItem("slopslide.view", view);
    set({ view });
  },

  setCodeDirty: (codeDirty) => set({ codeDirty }),

  setSidebarOpen: (sidebarOpen) => {
    localStorage.setItem(SIDEBAR_OPEN_KEY, String(sidebarOpen));
    set({ sidebarOpen });
  },

  setSidebarTab: (sidebarTab) => {
    localStorage.setItem(SIDEBAR_TAB_KEY, sidebarTab);
    if (!get().sidebarOpen) get().setSidebarOpen(true);
    set({ sidebarTab });
  },

  setRailOpen: (railOpen) => {
    localStorage.setItem("slopslide.railOpen", String(railOpen));
    set({ railOpen });
  },

  setModel: (provider, id) => {
    const model = get()
      .providers?.find((p) => p.id === provider)
      ?.models.find((m) => m.id === id);
    if (!model) return;
    const effort = pickEffort(model, get().selection.effort);
    // Each model starts on its own default window: 1M costs more on models where it is optional.
    const contextWindow = pickContextWindow(model, null);
    saveSelection({ provider, model: id, label: model.label, effort, contextWindow });
  },

  setEffort: (effort) => saveSelection({ ...get().selection, effort }),

  setContextWindow: (contextWindow) => saveSelection({ ...get().selection, contextWindow }),

  refreshProviders: async () => {
    set({ providers: undefined });
    const result = await api.listProviders().catch(() => null);
    const providers = Array.isArray(result) ? result : [];
    set({ providers });
    if (providers.length > 0) saveSelection(reconcileSelection(get().selection, providers));
  },

  toggleFavoriteModel: (key) => {
    const { favoriteModels } = get();
    const next = favoriteModels.includes(key)
      ? favoriteModels.filter((k) => k !== key)
      : [...favoriteModels, key];
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
    set({ favoriteModels: next });
  },

  setPresenting: (presenting) => set({ presenting }),

  setError: (error) => set({ error }),

  refreshLint: async () => {
    const { deck } = get();
    if (!deck) return;
    const run = ++lintRun;
    try {
      const issues = await api.lintDeck(deck.id);
      // Ignore answers that a newer check (or another deck) has overtaken.
      if (run === lintRun && get().deck?.id === deck.id) set({ lint: Array.isArray(issues) ? issues : null });
    } catch {
      if (run === lintRun) set({ lint: null });
    }
  },

  fillComposer: (text, { screenshot } = {}) =>
    set((s) => ({ composerFill: { text, rev: (s.composerFill?.rev ?? 0) + 1, ...(screenshot && { screenshot }) } })),

  setSketches: (update) => {
    set((s) => ({ sketches: update(s.sketches) }));
    scheduleReviewSave();
  },

  clearSketch: (slide) => {
    set((s) => {
      const { [slide]: _, ...rest } = s.sketches;
      return { sketches: rest };
    });
    scheduleReviewSave();
  },

  skipSketch: (slide) => set((s) => ({ sketchesSent: { ...s.sketchesSent, [slide]: s.sketches[slide] ?? [] } })),

  setReviewVisible: (reviewVisible) => {
    localStorage.setItem(REVIEW_VISIBLE_KEY, String(reviewVisible));
    set({ reviewVisible });
  },

  startImageExport: (dir) => {
    const { deck } = get();
    if (deck && deck.slides.length > 0) set({ imageExport: { dir, slides: deck.slides.map((s) => s.id) } });
  },

  endImageExport: () => set({ imageExport: null }),

  setEditing: (editing) => {
    if (editing === get().editing) return;
    if (editing && selectedSlide()?.locked) return;
    // Each edit session starts with fresh history; leaving keeps the edits.
    set({ editing, slideUndo: [], slideRedo: [] });
  },

  saveSlideEdit: (slide, markup) => {
    const save = async () => {
      const { deck } = get();
      const base = deck?.slides.find((s) => s.id === slide)?.hash;
      if (!deck || !base) return;
      try {
        const { deck: next, previous } = await api.updateSlide(deck.id, slide, markup, base);
        if (get().deck?.id !== deck.id) return;
        const after = next.slides.find((s) => s.id === slide)?.hash ?? "";
        get().setDeck(next);
        set((s) => ({ slideUndo: [...s.slideUndo, { slide, markup: previous, after }].slice(-UNDO_KEPT), slideRedo: [] }));
      } catch (error) {
        set((s) => ({ error: errorMessage(error), editReload: s.editReload + 1 }));
      }
    };
    editQueue = editQueue.then(save);
    return editQueue;
  },

  undoSlideEdit: () => {
    editQueue = editQueue.then(() => stepSlideHistory("slideUndo", "slideRedo")).then(() => undefined);
    return editQueue;
  },

  redoSlideEdit: () => {
    editQueue = editQueue.then(() => stepSlideHistory("slideRedo", "slideUndo")).then(() => undefined);
    return editQueue;
  },

  discardSlideEdits: () => {
    const discard = async () => {
      while (get().slideUndo.length > 0) {
        if (!(await stepSlideHistory("slideUndo", "slideRedo"))) break;
      }
      set({ editing: false, slideUndo: [], slideRedo: [] });
    };
    editQueue = editQueue.then(discard);
    return editQueue;
  },

  refreshTemplates: async () => {
    try {
      const templates = await api.listTemplates();
      set({ templates: Array.isArray(templates) ? templates : [] });
    } catch (error) {
      set({ templates: [], error: errorMessage(error) });
    }
  },

  applyStyle: async (id) => {
    const { deck } = get();
    const template = findTemplate(id);
    if (!deck || !template) return;
    try {
      if (deck.slides.length === 0) {
        get().setDeck(await api.applyTemplate(deck.id, id));
        return;
      }
      const path = await api.stageTemplate(deck.id, id);
      promptAgent(stylePrompt(template, path));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  addLayoutSlide: async (id, slide) => {
    const { deck, selected } = get();
    const template = findTemplate(id);
    if (!deck || !template) return;
    try {
      if (deck.template === id) {
        const created = await api.addTemplateSlide(deck.id, id, slide, selected);
        get().setDeck(created.deck);
        get().select(created.slide);
        return;
      }
      const path = await api.stageTemplate(deck.id, id);
      promptAgent(addLayoutPrompt(template, slide, path, selected));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  changeLayout: async (id, slide) => {
    const { deck, selected } = get();
    const template = findTemplate(id);
    if (!deck || !template || !selected || selectedSlide()?.locked) return;
    try {
      const path = await api.stageTemplate(deck.id, id);
      promptAgent(changeLayoutPrompt(template, slide, path));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  saveAsTemplate: async (name) => {
    const { deck } = get();
    if (!deck) return null;
    try {
      const created = await api.createTemplate(deck.id, name);
      await get().refreshTemplates();
      return created;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  tidyLayout: async (overflow = []) => {
    const { deck } = get();
    if (!deck || selectedSlide()?.locked) return;
    // Let any edit still being saved land first, so the screenshot shows the final version.
    await editQueue;
    const screenshot = await captureSlide(deck.id);
    if (get().deck?.id !== deck.id) return;
    get().setEditing(false);
    promptAgent(tidyPrompt(overflow), { screenshot });
  },

  resizeSlides: async (size) => {
    const { deck, running } = get();
    if (!deck || running) return;
    const from = deck.size ?? DEFAULT_SIZE;
    if (sameSize(from, size)) return;
    try {
      const resized = await api.setSlideSize(deck.id, size);
      if (get().deck?.id !== deck.id) return;
      get().setDeck(resized);
      if (resized.slides.length > 0) promptAgent(resizePrompt(from, resized.size ?? size));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  send: async (text, { includeSlide, attachments, screenshot }) => {
    const { workspace, openedFile, deck, selected, running, selection } = get();
    if (!workspace || running) return;
    // Typed as a message, the command still compacts rather than reaching the agent as text.
    if (text.trim() === COMPACT_COMMAND) return get().compact();
    const slide = deck && includeSlide ? selected : null;
    const strokes = slide ? (get().sketches[slide] ?? []) : [];
    // Marks go out once, while they are on show; they stay on the slide as a review.
    const unsent = !!slide && get().reviewVisible && strokes !== get().sketchesSent[slide];
    const bounds = unsent && deck ? inkBounds(strokes, pixelsOf(deck)) : null;
    let user: UserMessage = {
      id: newId(),
      role: "user",
      text,
      slide,
      attachments,
      sketch: bounds ? { image: null, bounds } : null,
      ...(screenshot && { screenshot }),
      createdAt: Date.now(),
    };
    const assistant = newReply(selection.provider);
    set((s) => ({ messages: [...s.messages, user, assistant], running: true }));
    // Let any edit still being saved land first, so the agent sees the final version.
    await editQueue;
    if (deck && slide && user.sketch) {
      // Screenshot the slide with the ink on it.
      const image = await captureSlide(deck.id);
      const captured: UserMessage = { ...user, sketch: { ...user.sketch, image } };
      user = captured;
      set((s) => ({ messages: s.messages.map((m) => (m.id === captured.id ? captured : m)) }));
      set((s) => ({ sketchesSent: { ...s.sketchesSent, [slide]: strokes } }));
    }
    const template = deck ? await stageDeckTemplate(deck) : null;
    if (get().workspace?.path !== workspace.path) return;
    await startTurn(workspace.path, assistant.id, buildPrompt(deck, openedFile, user, template), false);
  },

  compact: async () => {
    const { workspace, running, selection } = get();
    if (!workspace || running) return;
    const user: UserMessage = {
      id: newId(),
      role: "user",
      text: COMPACT_COMMAND,
      slide: null,
      attachments: [],
      command: "compact",
      createdAt: Date.now(),
    };
    const assistant = newReply(selection.provider);
    set((s) => ({ messages: [...s.messages, user, assistant], running: true }));
    await startTurn(workspace.path, assistant.id, COMPACT_COMMAND, true);
  },

  interrupt: () => {
    const { workspace } = get();
    if (workspace) {
      updateLastAssistant((m) => ({ ...m, parts: expireApprovals(m.parts) }));
      void api.interruptAgent(workspace.path);
    }
  },

  resetChat: async () => {
    const { workspace, running } = get();
    if (!workspace || running) return;
    await api.resetChat(workspace.path);
    set({ messages: [], running: false });
  },
}));

export const COMPACT_COMMAND = "/compact";

function newReply(provider: Provider): AssistantMessage {
  return {
    id: newId(),
    role: "assistant",
    parts: [],
    status: "streaming",
    thinking: true,
    error: null,
    costUsd: null,
    durationMs: null,
    provider,
    createdAt: Date.now(),
  };
}

/** Hands `prompt` to the selected agent; a failure to start lands on reply `replyId`. */
async function startTurn(deckId: string, replyId: string, prompt: string, compact: boolean) {
  const { selection, providers, permissionMode } = useApp.getState();
  try {
    const { provider, model, contextWindow } = selection;
    const info = providers?.find((p) => p.id === provider)?.models.find((m) => m.id === model);
    const effort = requestEffort(info, selection.effort);
    await api.sendMessage(deckId, prompt, { provider, model, effort, contextWindow, ...(provider === "codex" ? { permissionMode } : {}) }, compact);
  } catch (error) {
    updateAssistant(replyId, (m) => ({
      ...m,
      status: "error",
      thinking: false,
      error: errorMessage(error),
    }));
    useApp.setState({ running: false });
    persistChat();
  }
}

/**
 * Restores the newest entry of one slide edit history (undo or redo) and records how to
 * reverse that in the other. False when there was nothing to restore or it was refused.
 */
async function stepSlideHistory(from: "slideUndo" | "slideRedo", to: "slideUndo" | "slideRedo"): Promise<boolean> {
  const { deck, [from]: history } = useApp.getState();
  const last = history.at(-1);
  if (!deck || !last) return false;
  useApp.setState({ [from]: history.slice(0, -1) });
  const current = deck.slides.find((s) => s.id === last.slide)?.hash;
  if (current !== last.after) {
    useApp.setState({ error: `The slide changed since that edit, so it cannot be ${from === "slideUndo" ? "undone" : "redone"}.` });
    return false;
  }
  try {
    const { deck: next, previous } = await api.updateSlide(deck.id, last.slide, last.markup, current);
    if (useApp.getState().deck?.id !== deck.id) return false;
    const after = next.slides.find((s) => s.id === last.slide)?.hash ?? "";
    useApp.getState().setDeck(next);
    useApp.getState().select(last.slide);
    useApp.setState((s) => ({ [to]: [...s[to], { slide: last.slide, markup: previous, after }].slice(-UNDO_KEPT) }));
    return true;
  } catch (error) {
    useApp.setState({ error: errorMessage(error) });
    return false;
  }
}

async function confirmDiscardEdits(): Promise<boolean> {
  const name = basename(useApp.getState().deck?.id ?? "") || "the deck";
  const message = `You have unsaved changes to ${name}. Discard them?`;
  try {
    return await ask(message, { title: "Unsaved changes", kind: "warning", okLabel: "Discard" });
  } catch {
    return window.confirm(message);
  }
}

function findTemplate(id: string): TemplateSummary | undefined {
  return useApp.getState().templates?.find((t) => t.id === id);
}

/** Hands the composer a prepared message, showing the chat if it is hidden. */
function promptAgent(text: string, options?: { screenshot?: string | null }) {
  const { sidebarOpen, sidebarTab, setSidebarTab, fillComposer } = useApp.getState();
  if (!sidebarOpen || sidebarTab !== "chat") setSidebarTab("chat");
  fillComposer(text, options);
}

function loadSidebarTab(): SidebarTab {
  const saved = localStorage.getItem(SIDEBAR_TAB_KEY);
  return isSidebarTab(saved) ? saved : "chat";
}

/** `absolute` relative to the workspace folder, `/`-separated; null when outside it. */
export function relativePath(workspace: WorkspaceInfo | null, absolute: string): string | null {
  if (!workspace) return null;
  const root = workspace.path.replaceAll("\\", "/").replace(/\/$/, "");
  const path = absolute.replaceAll("\\", "/");
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

/** Reopens `path` the next time its workspace opens. */
function rememberFile(path: string) {
  const { workspace } = useApp.getState();
  if (workspace) localStorage.setItem(LAST_FILE_KEY + workspace.path, path);
}

/** Shows the workspace file `path` in the viewer its kind calls for: a deck in the editor. */
async function openFileAt(path: string, file: OpenedFile) {
  const { closeDeck, openDeck } = useApp.getState();
  if (file.kind === "deck") return openDeck(file.absolute);
  if (!(await closeDeck())) return;
  rememberFile(path);
  useApp.setState((s) => ({ openedFile: file, fileRev: s.fileRev + 1 }));
}

async function loadWorkspaceChat(path: string) {
  const [chat, running] = await Promise.all([api.loadChat(path), api.agentRunning(path)]);
  if (useApp.getState().workspace?.path !== path) return;
  const messages = Array.isArray(chat) ? (chat as ChatMessage[]) : [];
  useApp.setState({ messages: running ? messages : messages.map(settleInterrupted), running });
}

async function loadDeckState(deck: Deck) {
  savedReview = reviewKey(deck.review ?? {});
  useApp.setState({
    deck,
    selected: deck.slides[0]?.id ?? null,
    assetsRev: 0,
    presenting: false,
    lint: null,
    composerFill: null,
    sketches: deck.review ?? {},
    sketchesSent: {},
    imageExport: null,
    editing: false,
    slideUndo: [],
    slideRedo: [],
  });
}

const REVIEW_SAVE_DELAY = 400;
let reviewSave: { deckId: string; timer: ReturnType<typeof setTimeout> } | null = null;
/** Review saves still on their way to disk. */
let reviewSaving = 0;
/** The review marks as the deck file holds them, as far as the app knows (see `reviewKey`). */
let savedReview = reviewKey({});

/** Compares review marks independent of slide order; slides without marks don't count. */
function reviewKey(review: Record<string, Stroke[]>): string {
  return JSON.stringify(
    Object.entries(review)
      .filter(([, strokes]) => strokes.length > 0)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/**
 * Takes on review marks changed outside the app's own saves (the agent clearing them, an
 * edit in the HTML view), unless the user's latest marks are still being saved.
 */
function adoptReview(deck: Deck) {
  const review = deck.review ?? {};
  const key = reviewKey(review);
  if (reviewSave || reviewSaving > 0 || key === savedReview) return;
  savedReview = key;
  if (key !== reviewKey(useApp.getState().sketches)) useApp.setState({ sketches: review, sketchesSent: {} });
}

/** Saves the review marks to the deck file once drawing pauses. */
function scheduleReviewSave() {
  const deck = useApp.getState().deck;
  if (!deck) return;
  if (reviewSave && reviewSave.deckId !== deck.id) void flushReviewSave();
  if (reviewSave) clearTimeout(reviewSave.timer);
  reviewSave = { deckId: deck.id, timer: setTimeout(() => void flushReviewSave(), REVIEW_SAVE_DELAY) };
}

/** Saves review marks still waiting for drawing to pause, right away. */
export async function flushReviewSave() {
  if (!reviewSave) return;
  const { deckId, timer } = reviewSave;
  clearTimeout(timer);
  reviewSave = null;
  const { deck, sketches } = useApp.getState();
  if (deck?.id !== deckId) return;
  const review = Object.fromEntries(Object.entries(sketches).filter(([, strokes]) => strokes.length > 0));
  // Drawing and undoing back to where the file is leaves nothing to save.
  if (reviewKey(review) === savedReview) return;
  reviewSaving++;
  try {
    await api.saveReview(deckId, review);
    savedReview = reviewKey(review);
  } catch (error) {
    useApp.setState({ error: `Could not save the review marks: ${errorMessage(error)}` });
  } finally {
    reviewSaving--;
  }
}

/** Marks the slide on the stage to screenshot when sending a sketch. */
export const SKETCH_TARGET_ATTR = "data-sketch-target";

/** Screenshot of the slide on the stage, ink included; null when it cannot be taken. */
async function captureSlide(deckId: string): Promise<string | null> {
  const target = document.querySelector(`[${SKETCH_TARGET_ATTR}]`);
  if (!target) return null;
  const { x, y, width, height } = target.getBoundingClientRect();
  try {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    return await api.captureSketch(deckId, { x, y, width, height }, viewport);
  } catch (error) {
    // The marked area still tells the agent where to look.
    console.warn("slide screenshot failed:", errorMessage(error));
    return null;
  }
}

/** Chat instructions asking the agent to fix `issues` in the deck file `file` and verify with its lint tool. */
export function lintFixPrompt(issues: LintIssue[], file = "deck.html"): string {
  const lines = issues.map(
    (i) => `- line ${i.line} ${i.severity} [${i.rule}]${i.slide ? ` (slide \`${i.slide}\`)` : ""}: ${i.message}`,
  );
  return [
    `${file} does not pass the HTML lint. Fix these issues without changing how the slides look:`,
    "",
    ...lines,
    "",
    "Then run the lint_deck tool to verify, and repeat until it reports no issues.",
  ].join("\n");
}

/** A transcript saved mid-turn (app quit) cannot resume streaming. */
function settleInterrupted(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant") return message;
  return { ...message, ...(message.status === "streaming" ? { status: "interrupted" as const, thinking: false, compacting: false } : {}), parts: expireApprovals(message.parts) };
}

/** The slide shown on the stage, if any. */
function selectedSlide(): Slide | undefined {
  const { deck, selected } = useApp.getState();
  return deck?.slides.find((s) => s.id === selected);
}

/**
 * A copy of the deck's template for the agent to take layouts from; null when the deck has
 * none or it is gone (there are just no layouts to read then).
 */
async function stageDeckTemplate(deck: Deck): Promise<string | null> {
  if (!deck.template) return null;
  try {
    return await api.stageTemplate(deck.id, deck.template);
  } catch {
    return null;
  }
}

function buildPrompt(deck: Deck | null, openedFile: OpenedFile | null, message: UserMessage, template: string | null = null): string {
  const file = openedFile?.path ?? (deck ? relativePath(useApp.getState().workspace, deck.id) ?? basename(deck.id) : null);
  const kind = deck ? "deck" : openedFile?.kind === "webpage" ? "web page" : openedFile?.kind;
  const context: string[] = [file ? `Open file: ${file} (${kind})` : "No file open"];
  if (deck && message.slide) {
    const index = deck.slides.findIndex((s) => s.id === message.slide);
    context.push(
      `Current slide: <section id="${message.slide}"> in ${file} (slide ${index + 1} of ${deck.slides.length})`,
    );
    if (deck.slides[index]?.locked) {
      context.push("The current slide is locked (data-locked): do not change it.");
    }
  } else if (deck && deck.slides.length === 0) {
    context.push("The deck has no slides yet.");
  }
  if (message.attachments.length > 0) {
    context.push(`Attached files: ${message.attachments.join(", ")}`);
  }
  if (deck && message.sketch) {
    const { image, bounds } = message.sketch;
    if (image) {
      context.push(`Sketch: ${image} (screenshot of the current slide with the user's marks drawn on top)`);
    }
    const size = pixelsOf(deck);
    context.push(
      `Marked area: x ${bounds.left}–${bounds.right}, y ${bounds.top}–${bounds.bottom} of the ${size.width}×${size.height} slide`,
    );
  }
  if (message.screenshot) {
    context.push(`Screenshot: ${message.screenshot} (screenshot of the slide with the user's hand edits)`);
  }
  if (template) {
    context.push(`Deck template: ${template} (copy of the deck's template, for its layouts)`);
  }
  if (context.length === 0) return message.text;
  return `[context]\n${context.join("\n")}\n[/context]\n\n${message.text}`;
}

function updateAssistant(id: string, update: (m: AssistantMessage) => AssistantMessage) {
  useApp.setState((s) => ({
    messages: s.messages.map((m) => (m.id === id && m.role === "assistant" ? update(m) : m)),
  }));
}

function updateLastAssistant(update: (m: AssistantMessage) => AssistantMessage) {
  const last = useApp.getState().messages.findLast((m) => m.role === "assistant");
  if (last) updateAssistant(last.id, update);
}

function replyProvider(message: AssistantMessage): Provider {
  return message.provider ?? useApp.getState().selection.provider;
}

function persistChat() {
  const { workspace, messages } = useApp.getState();
  if (workspace) void api.saveChat(workspace.path, messages);
}

function expireApprovals(parts: ChatPart[]): ChatPart[] {
  return parts.map((p) => p.kind === "approval" && p.status === "pending" ? { ...p, status: "expired" } : p);
}

function applyAgentEvent(event: AgentEvent) {
  switch (event.type) {
    case "openFile":
      void useApp.getState().openPath(event.path);
      return;
    case "approvalRequested":
      return updateLastAssistant((m) => ({ ...m, thinking: false, parts: [...m.parts, { kind: "approval", approval: event.approval, status: "pending" }] }));
    case "approvalResolved":
      return updateLastAssistant((m) => ({ ...m, parts: m.parts.map((p) => p.kind === "approval" && p.approval.id === event.id ? { ...p, status: "resolved" } : p) }));
    case "approvalReview":
      return updateLastAssistant((m) => {
        const part: ChatPart = { kind: "approvalReview", id: event.id, status: event.status, detail: event.detail };
        const existing = m.parts.some((p) => p.kind === "approvalReview" && p.id === event.id);
        return { ...m, thinking: false, parts: existing ? m.parts.map((p) => p.kind === "approvalReview" && p.id === event.id ? part : p) : [...m.parts, part] };
      });
    case "started":
      return;
    case "thinking":
      return updateLastAssistant((m) => ({ ...m, thinking: true }));
    case "textStart":
      return updateLastAssistant((m) => ({
        ...m,
        thinking: false,
        parts: [...m.parts, { kind: "text", text: "" }],
      }));
    case "textDelta":
      return updateLastAssistant((m) => {
        const parts = [...m.parts];
        const last = parts.at(-1);
        if (last?.kind === "text") parts[parts.length - 1] = { ...last, text: last.text + event.text };
        else parts.push({ kind: "text", text: event.text });
        return { ...m, thinking: false, parts };
      });
    case "toolUse":
      return updateLastAssistant((m) => ({
        ...m,
        thinking: false,
        parts: [
          ...m.parts.filter((p) => p.kind !== "text" || p.text.trim() !== ""),
          { kind: "tool", id: event.id, name: event.name, input: event.input, status: "running" },
        ],
      }));
    case "toolResult":
      return updateLastAssistant((m) => ({
        ...m,
        parts: m.parts.map((p) =>
          p.kind === "tool" && p.id === event.id
            ? { ...p, status: event.isError ? "error" : "done" }
            : p,
        ),
      }));
    case "result":
      return updateLastAssistant((m) => {
        const hasText = m.parts.some((p) => p.kind === "text" && p.text.trim() !== "");
        const parts: ChatPart[] =
          !hasText && !event.isError && event.text
            ? [...m.parts, { kind: "text", text: event.text }]
            : m.parts;
        return {
          ...m,
          parts,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
          error: event.isError ? (event.text ?? "The agent reported an error.") : m.error,
        };
      });
    case "error":
      return updateLastAssistant((m) => ({ ...m, error: event.message }));
    case "usage":
      return updateLastAssistant((m) => {
        const provider = replyProvider(m);
        return { ...m, context: mergeContext(latestContext(useApp.getState().messages, provider), provider, event) };
      });
    case "compacting":
      return updateLastAssistant((m) => ({ ...m, thinking: false, compacting: true }));
    case "compacted":
      return updateLastAssistant((m) => {
        const provider = replyProvider(m);
        const window = latestContext(useApp.getState().messages, provider)?.window ?? null;
        // The new size is only known once the agent reports usage again.
        return { ...m, compacting: false, compacted: true, context: { provider, tokens: null, window } };
      });
    case "finished":
      updateLastAssistant((m) => ({
        ...m,
        thinking: false,
        compacting: false,
        status: event.interrupted ? "interrupted" : m.error ? "error" : "done",
        parts: expireApprovals(m.parts).map((p) =>
          p.kind === "tool" && p.status === "running" ? { ...p, status: "done" } : p,
        ),
      }));
      useApp.setState({ running: false });
      persistChat();
      return;
  }
}

let reloadTimer: ReturnType<typeof setTimeout> | undefined;

/** Follows changes in the open workspace: the file tree, the open deck, the open page. */
function applyWorkspaceChanged(paths: string[]) {
  const { openedFile, deck } = useApp.getState();
  useApp.setState((s) => ({ workspaceChange: { paths, rev: (s.workspaceChange?.rev ?? 0) + 1 } }));
  if (!openedFile) return;
  if (deck) {
    // The deck's own files, relative to its folder.
    const folder = dirname(openedFile.path);
    const inFolder = folder ? paths.filter((p) => p.startsWith(`${folder}/`)).map((p) => p.slice(folder.length + 1)) : paths;
    return applyDeckChanged(inFolder, basename(openedFile.path));
  }
  if (paths.includes(openedFile.path)) useApp.setState((s) => ({ fileRev: s.fileRev + 1 }));
}

/** `paths` are relative to the deck's folder; `file` is the deck file's name. */
function applyDeckChanged(paths: string[], file: string) {
  if (paths.some((p) => p.startsWith("assets/"))) {
    useApp.setState((s) => ({ assetsRev: s.assetsRev + 1 }));
  }
  if (!paths.includes(file)) return;
  // Edits arrive in bursts while the agent works; reload once they settle.
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    const { deck } = useApp.getState();
    if (!deck) return;
    try {
      const next = await api.loadDeck(deck.id);
      const before = new Map(deck.slides.map((s) => [s.id, s.hash]));
      const changed = next.slides.find((s) => before.get(s.id) !== s.hash);
      useApp.getState().setDeck(next);
      adoptReview(next);
      // Follow the agent to the slide it is working on.
      if (changed && useApp.getState().running) useApp.setState({ selected: changed.id });
    } catch {
      // The deck file is mid-write; the next change event retries.
    }
  }, 120);
}

export async function initEventBridge() {
  // Listing Codex models starts its app server; don't hold up the rest of the bridge.
  void useApp.getState().refreshProviders();
  await listen<AgentEventEnvelope>("agent-event", ({ payload }) => {
    if (payload.workspace === useApp.getState().workspace?.path) applyAgentEvent(payload.event);
  });
  await listen<WorkspaceChanged>("workspace-changed", ({ payload }) => {
    if (payload.root === useApp.getState().workspace?.path) applyWorkspaceChanged(payload.paths);
  });
}
