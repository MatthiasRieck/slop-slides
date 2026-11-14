import { api, type Deck } from "../lib/api";
import {
  type AgentInsert,
  combineElements,
  DEFAULT_EDIT_STYLES,
  type EditElement,
  type EditStyle,
  type EditTool,
  type ToolFamily,
} from "../lib/editTools";
import { memoizeLast } from "../lib/memo";
import { parseRecentColors, withRecentColor } from "../lib/palette";
import { withSlideBackground } from "../lib/slideBackground";
import { loadFlag, loadJson, loadText, saveFlag, saveJson, trySaveText } from "../lib/storage";
import { captureSlide } from "./capture";
import { promptAgent } from "./composer";
import { editsSaved, queueEdit } from "./editQueue";
import { showErrorIn } from "./errors";
import { refreshHistory } from "./history";
import { TIDY_ELEMENT_PROMPT, tidyPrompt } from "./prompts";
import { selectedSlide } from "./slides";
import type { AppState, AppStore, Slice } from "./types";

/**
 * What the deck is open for; the top bar's tabs pick it (see components/ModeTabs.tsx). View
 * changes nothing in the deck but its review (marks and comments); Edit changes the slides, their
 * order and their timing. A slide's narration and notes and the deck's HTML are not modes: they
 * are tabs of the sidebar, beside the slide. Nor is playing the deck: its timeline opens under
 * the slide in View and in Edit (see `timelineOpen`).
 */
export type DeckMode = "view" | "edit" | "git";

/** The deck's mode, and editing slides on the stage: the edits saved, and asking the agent about them. */
export interface EditingSlice {
  /**
   * Edit mode: the slides, their order and their timing can be changed. The stage lets the user
   * edit text and move elements on the slide unless it is locked (see `editingSlide`).
   */
  editing: boolean;
  /** The mode shown over the rendered slide when not editing; see `deckMode`. */
  slideMode: "view" | "git";
  /** Bumped when a slide edit could not be saved, so the stage reloads the slide from disk. */
  editReload: number;
  /** The edit toolbar's tool: select, or what a drag on the slide adds. */
  editTool: EditTool;
  /**
   * The tool stays in hand after it added something (a double-click on its button), for adding
   * several of a kind; picking Select, or any tool with a single click, lets go of it.
   */
  editToolKept: boolean;
  /** What new text boxes, shapes and drawings look like; restyling one updates its family's. */
  editStyles: Record<ToolFamily, EditStyle>;
  /** Where the deck's history was when edit mode started, and its slides' hashes then. */
  editBase: { version: string; hashes: Record<string, string> } | null;
  /** The slides edited on the stage since edit mode started. */
  editedSlides: string[];
  /**
   * The hash each slide got when the stage's editor last saved it. The editor already shows such
   * a version, so the stage keeps it running instead of loading the slide again.
   */
  editSaved: Record<string, string>;
  /** Dragging and resizing snap to the guides; remembered between slides and launches. */
  editSnap: boolean;
  /** The colors picked last in the edit toolbar's color wells, the latest first; remembered between launches. */
  recentColors: string[];
  /**
   * The look copied from an element (⌥⌘C), as the slide editor reported it, to paste onto others
   * on any slide. The editor reads it back, so the app only keeps it.
   */
  copiedStyle: unknown;
  /**
   * A popover of the edit toolbar to open, asked for from outside it (⌘K, the context menu), with
   * a counter so the same one can be asked for again.
   */
  editPanelAsk: { panel: EditPanel; rev: number } | null;

  /** Turns snapping to the guides on or off. */
  setEditSnap: (on: boolean) => void;
  /** Counts `color` as picked last in a color well. */
  noteColor: (color: string) => void;
  setCopiedStyle: (style: unknown) => void;
  /** Asks the edit toolbar to open one of its popovers. */
  askForEditPanel: (panel: EditPanel) => void;
  /** Enters or leaves edit mode, keeping the edits made so far. */
  setEditing: (editing: boolean) => void;
  /** Switches the deck to a mode, leaving the one it is in. */
  setMode: (mode: DeckMode) => void;
  /** Picks the edit toolbar's tool; with `keep`, it stays in hand after adding something. */
  setEditTool: (tool: EditTool, keep?: boolean) => void;
  setEditStyle: (family: ToolFamily, changes: EditStyle) => void;
  /**
   * Saves `markup` as the new version of `slide`, after any edits still being saved. `group` is
   * the editor's name for a run of small edits (arrow-key nudges of the same elements), whose
   * saves the deck's history keeps as one step to undo.
   */
  saveSlideEdit: (slide: string, markup: string, group?: string) => Promise<void>;
  /**
   * Saves `slide` of the open deck as `change` makes its markup in the file, after any edits still
   * being saved; false (with the error shown) when `change` throws or the save fails.
   */
  changeSlideMarkup: (slide: string, change: (markup: string) => string) => Promise<boolean>;
  /**
   * Puts the slides edited since entering edit mode back as they were then, staying in it. With
   * `slide`, only that slide.
   */
  discardSlideEdits: (slide?: string) => Promise<void>;
  /**
   * Screenshots the slide and puts a prompt in the composer asking the agent to rebuild the
   * slide's layout around the user's hand edits, with the screenshot attached. The mode stays.
   * `overflow` lists elements the slide editor found running past the slide or cut off.
   */
  tidyLayout: (overflow?: string[]) => Promise<void>;
  /** Readies the composer for a question about `element`, with a screenshot of the slide showing it selected. */
  askAboutElement: (element: EditElement) => Promise<void>;
  /** Like `askAboutElement`, about all of `elements` together. */
  askAboutElements: (elements: EditElement[]) => Promise<void>;
  /**
   * Starts a request to the agent for something the edit tools do not draw (a table, a chart, an
   * icon): the composer gets the start of the request, with a screenshot of the slide, for the
   * user to finish and send.
   */
  askForInsert: (kind: AgentInsert) => Promise<void>;
  /** Like `tidyLayout`, but has the agent give only `element` a place in the layout. */
  tidyElement: (element: EditElement) => Promise<void>;
  /**
   * Gives every slide of the deck that is not locked `color` as its own background (null: the
   * deck's own again), as one step to undo. Resolves to how many slides it changed.
   */
  applyBackgroundToAll: (color: string | null) => Promise<number>;
}

/**
 * The popovers of the edit toolbar that can be asked for from outside it, and the one picker it
 * opens for the selection: the file to put in the selected image.
 */
export type EditPanel = "link" | "background" | "position" | "replace-image";

/** Where the mode decks were last in, View or Edit, is remembered. */
const MODE_KEY = "slopslide.deckMode";

/** The mode a deck opens in: the one decks were last in, View or Edit; Edit until one was picked. */
export function lastDeckMode(): "view" | "edit" {
  return loadText(MODE_KEY) === "view" ? "view" : "edit";
}

/** Where `editSnap` is remembered. */
const SNAP_KEY = "slopslides.editSnap";
/** Where `recentColors` are remembered. */
const RECENT_COLORS_KEY = "slopslides.recentColors";

/** How each request to the agent from the Insert section starts; the user says the rest. */
export const INSERT_PROMPTS: Record<AgentInsert, string> = {
  table: "Add a table to this slide: ",
  chart: "Add a chart to this slide: ",
  icon: "Add an icon to this slide: ",
};

/** No edit session's edits. */
export const NO_EDIT_STATE = { editBase: null, editedSlides: [], editSaved: {} as Record<string, string> };

/** The mode of the deck: editing has its own state, the rest is `slideMode`. */
export function deckMode(state: Pick<AppState, "editing" | "slideMode">): DeckMode {
  return state.editing ? "edit" : state.slideMode;
}

/** Whether the stage edits the selected slide: in edit mode, and the slide is not locked. */
export function editingSlide(state: Pick<AppState, "editing" | "deck" | "selected">): boolean {
  return state.editing && !selectedSlide(state)?.locked;
}

const NO_SLIDES: string[] = [];

/** Those of `edited` whose slide in `slides` is not as `hashes` has it. */
const changedSince = memoizeLast((slides: Deck["slides"], hashes: Record<string, string>, edited: string[]) => {
  const now = new Map(slides.map((slide) => [slide.id, slide.hash]));
  return edited.filter((id) => now.has(id) && now.get(id) !== hashes[id]);
});

/**
 * The slides edited since edit mode started that are not as they were then any more. The same
 * list until the deck's slides or the session's edits change: it is asked for on every update
 * of the store.
 */
export function editedSlidesOf(state: Pick<AppState, "deck" | "editBase" | "editedSlides">): string[] {
  const { deck, editBase, editedSlides } = state;
  if (!deck || !editBase || editedSlides.length === 0) return NO_SLIDES;
  return changedSince(deck.slides, editBase.hashes, editedSlides);
}

/**
 * Shows the deck a slide edit saved, and counts the slide as edited in this session. What the
 * session notes of the edit goes into the store in one update, and only when there is something
 * new to note: every update asks everything that reads the store, and a drag saves many times.
 */
function showEdited(app: AppStore, slide: string, next: Deck, fromEditor = false) {
  const hash = next.slides.find((s) => s.id === slide)?.hash;
  const { editSaved, editedSlides } = app.getState();
  const saved = fromEditor && hash && editSaved[slide] !== hash ? { ...editSaved, [slide]: hash } : editSaved;
  const edited = editedSlides.includes(slide) ? editedSlides : [...editedSlides, slide];
  // Before the deck, so the stage never sees the new version without knowing whose it is.
  if (saved !== editSaved || edited !== editedSlides) app.setState({ editSaved: saved, editedSlides: edited });
  app.getState().setDeck(next);
}

/** Hands the composer `text` about `element`, with a screenshot once any edit still being saved has landed. */
async function promptAboutElement(app: AppStore, text: string, element: EditElement, { leaveEditing = false } = {}) {
  const { deck } = app.getState();
  if (!deck || selectedSlide(app.getState())?.locked) return;
  await editsSaved();
  const screenshot = await captureSlide(deck.id);
  if (app.getState().deck?.id !== deck.id) return;
  if (leaveEditing) app.getState().setEditing(false);
  promptAgent(app, text, { screenshot, element });
}

export const createEditingSlice: Slice<EditingSlice> = (set, get, app) => ({
  editing: false,
  slideMode: "view",
  editReload: 0,
  editTool: "select",
  editToolKept: false,
  editStyles: DEFAULT_EDIT_STYLES,
  editBase: null,
  editedSlides: [],
  editSaved: {},
  editSnap: loadFlag(SNAP_KEY, true),
  recentColors: loadJson(RECENT_COLORS_KEY, [], parseRecentColors),
  copiedStyle: null,
  editPanelAsk: null,

  setEditSnap: (editSnap) => {
    set({ editSnap });
    try {
      saveFlag(SNAP_KEY, editSnap);
    } catch {
      // Only the remembered choice is lost.
    }
  },

  noteColor: (color) => {
    const recentColors = withRecentColor(get().recentColors, color);
    set({ recentColors });
    try {
      saveJson(RECENT_COLORS_KEY, recentColors);
    } catch {
      // Only the remembered colors are lost.
    }
  },

  setCopiedStyle: (copiedStyle) => set({ copiedStyle }),

  askForEditPanel: (panel) => set((s) => ({ editPanelAsk: { panel, rev: (s.editPanelAsk?.rev ?? 0) + 1 } })),

  setEditing: (editing) => {
    if (editing === get().editing) return;
    // Each edit session starts with the select tool; leaving keeps the edits.
    set({ editing, editTool: "select", editToolKept: false, ...NO_EDIT_STATE });
    if (!editing) return;
    // Where discarding the session's edits goes back to, after any change still being saved.
    void queueEdit(async () => {
      await refreshHistory(app);
      const { deck, history, editing } = get();
      if (!deck || !editing || !history?.current) return;
      set({
        editBase: { version: history.current, hashes: Object.fromEntries(deck.slides.map((s) => [s.id, s.hash])) },
      });
    });
  },

  setMode: (mode) => {
    // The next deck opens the way this one is worked on.
    if (mode === "view" || mode === "edit") trySaveText(MODE_KEY, mode);
    get().setEditing(mode === "edit");
    set({ slideMode: mode === "edit" ? "view" : mode });
  },

  setEditTool: (editTool, keep = false) => set({ editTool, editToolKept: keep && editTool !== "select" }),

  setEditStyle: (family, changes) =>
    set((s) => ({ editStyles: { ...s.editStyles, [family]: { ...s.editStyles[family], ...changes } } })),

  changeSlideMarkup: (slide, change) =>
    queueEdit(async () => {
      const { deck } = get();
      if (!deck) return false;
      try {
        const source = await api.slideSource(deck.id, slide);
        const next = await api.updateSlide(deck.id, slide, change(source.markup), source.hash);
        if (get().deck?.id === deck.id) showEdited(app, slide, next);
        return true;
      } catch (error) {
        showErrorIn(app, error);
        return false;
      }
    }),

  saveSlideEdit: (slide, markup, group) =>
    queueEdit(async () => {
      const { deck } = get();
      const base = deck?.slides.find((s) => s.id === slide)?.hash;
      if (!deck || !base) return;
      try {
        const next = await api.updateSlide(deck.id, slide, markup, base, group);
        if (get().deck?.id === deck.id) showEdited(app, slide, next, true);
      } catch (error) {
        showErrorIn(app, error);
        set((s) => ({ editReload: s.editReload + 1 }));
      }
    }),

  discardSlideEdits: (slide) =>
    queueEdit(async () => {
      const { deck, editBase } = get();
      const slides = slide === undefined ? editedSlidesOf(get()) : [slide];
      if (!deck || !editBase || slides.length === 0) return;
      try {
        const next = await api.restoreSlides(deck.id, editBase.version, slides);
        if (get().deck?.id !== deck.id) return;
        get().setDeck(next);
        set((s) => ({
          editedSlides: s.editedSlides.filter((id) => !slides.includes(id)),
          editReload: s.editReload + 1,
        }));
      } catch (error) {
        showErrorIn(app, error);
      }
    }),

  tidyLayout: async (overflow = []) => {
    const { deck } = get();
    if (!deck || selectedSlide(get())?.locked) return;
    // Let any edit still being saved land first, so the screenshot shows the final version.
    await editsSaved();
    const screenshot = await captureSlide(deck.id);
    if (get().deck?.id !== deck.id) return;
    promptAgent(app, tidyPrompt(overflow), { screenshot });
  },

  askAboutElement: (element) => promptAboutElement(app, "", element),

  askAboutElements: async (elements) => {
    const element = combineElements(elements);
    if (element) await promptAboutElement(app, "", element);
  },

  askForInsert: async (kind) => {
    const { deck } = get();
    if (!deck || selectedSlide(get())?.locked) return;
    await editsSaved();
    const screenshot = await captureSlide(deck.id);
    if (get().deck?.id !== deck.id) return;
    promptAgent(app, INSERT_PROMPTS[kind], { screenshot });
  },

  tidyElement: async (element) => {
    await promptAboutElement(app, TIDY_ELEMENT_PROMPT, element, { leaveEditing: true });
  },

  applyBackgroundToAll: (color) =>
    queueEdit(async () => {
      const { deck } = get();
      if (!deck) return 0;
      // One name for all the saves, so the deck's history keeps them as one step.
      const group = `background:${Date.now()}`;
      let changed = 0;
      try {
        for (const slide of deck.slides) {
          if (slide.locked) continue;
          const source = await api.slideSource(deck.id, slide.id);
          const markup = withSlideBackground(source.markup, color);
          if (markup === source.markup) continue;
          const next = await api.updateSlide(deck.id, slide.id, markup, source.hash, group);
          if (get().deck?.id !== deck.id) return changed;
          showEdited(app, slide.id, next);
          changed += 1;
        }
      } catch (error) {
        showErrorIn(app, error);
      }
      return changed;
    }),
});
