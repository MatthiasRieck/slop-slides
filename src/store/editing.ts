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
import { withRecentColor } from "../lib/palette";
import { loadFlag, saveFlag } from "../lib/storage";
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
export type DeckMode = "view" | "edit" | "settings" | "git";

/** The deck's mode, and editing slides on the stage: the edits saved, and asking the agent about them. */
export interface EditingSlice {
  /**
   * Edit mode: the slides, their order and their timing can be changed. The stage lets the user
   * edit text and move elements on the slide unless it is locked (see `editingSlide`).
   */
  editing: boolean;
  /** The mode shown over the rendered slide when not editing; see `deckMode`. */
  slideMode: "view" | "settings" | "git";
  /** Bumped when a slide edit could not be saved, so the stage reloads the slide from disk. */
  editReload: number;
  /** The edit toolbar's tool: select, or what a drag on the slide adds. */
  editTool: EditTool;
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
  /** The colors picked last in the edit toolbar's color wells, the latest first. */
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
  setEditTool: (tool: EditTool) => void;
  setEditStyle: (family: ToolFamily, changes: EditStyle) => void;
  /** Saves `markup` as the new version of `slide`, after any edits still being saved. */
  saveSlideEdit: (slide: string, markup: string) => Promise<void>;
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
   * Screenshots the slide, leaves edit mode, and puts a prompt in the composer asking the agent
   * to rebuild the slide's layout around the user's hand edits, with the screenshot attached.
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
}

/** The popovers of the edit toolbar that can be asked for from outside it. */
export type EditPanel = "link" | "background";

/** Where `editSnap` is remembered. */
const SNAP_KEY = "slopslides.editSnap";

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

/** The slides edited since edit mode started that are not as they were then any more. */
export function editedSlidesOf(state: Pick<AppState, "deck" | "editBase" | "editedSlides">): string[] {
  const { deck, editBase, editedSlides } = state;
  if (!deck || !editBase) return [];
  return editedSlides.filter((id) => {
    const hash = deck.slides.find((s) => s.id === id)?.hash;
    return hash !== undefined && hash !== editBase.hashes[id];
  });
}

/** Shows the deck a slide edit saved, and counts the slide as edited in this session. */
function showEdited(app: AppStore, slide: string, next: Deck, fromEditor = false) {
  const hash = next.slides.find((s) => s.id === slide)?.hash;
  // Before the deck, so the stage never sees the new version without knowing whose it is.
  if (fromEditor && hash) app.setState((s) => ({ editSaved: { ...s.editSaved, [slide]: hash } }));
  app.getState().setDeck(next);
  app.setState((s) => ({ editedSlides: s.editedSlides.includes(slide) ? s.editedSlides : [...s.editedSlides, slide] }));
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
  editStyles: DEFAULT_EDIT_STYLES,
  editBase: null,
  editedSlides: [],
  editSaved: {},
  editSnap: loadFlag(SNAP_KEY, true),
  recentColors: [],
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

  noteColor: (color) => set((s) => ({ recentColors: withRecentColor(s.recentColors, color) })),

  setCopiedStyle: (copiedStyle) => set({ copiedStyle }),

  askForEditPanel: (panel) => set((s) => ({ editPanelAsk: { panel, rev: (s.editPanelAsk?.rev ?? 0) + 1 } })),

  setEditing: (editing) => {
    if (editing === get().editing) return;
    // Each edit session starts with the select tool; leaving keeps the edits.
    set({ editing, editTool: "select", ...NO_EDIT_STATE });
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
    get().setEditing(mode === "edit");
    set({ slideMode: mode === "edit" ? "view" : mode });
  },

  setEditTool: (editTool) => set({ editTool }),

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

  saveSlideEdit: (slide, markup) =>
    queueEdit(async () => {
      const { deck } = get();
      const base = deck?.slides.find((s) => s.id === slide)?.hash;
      if (!deck || !base) return;
      try {
        const next = await api.updateSlide(deck.id, slide, markup, base);
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
    get().setEditing(false);
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
});
