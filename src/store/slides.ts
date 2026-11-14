import { api, type Deck, type RailEdit, type Slide } from "../lib/api";
import { formatKeys } from "../lib/keys";
import {
  applyOrder,
  railItems,
  sectionBlocks,
  sectionKey,
  stepRows,
  stepSection,
  withoutSection,
  withoutSlides,
  withSlidesMarked,
} from "../lib/sections";
import { shareDeck } from "../lib/share";
import { loadJson, saveJson } from "../lib/storage";
import { plural } from "../lib/utils";
import { queueEdit } from "./editQueue";
import { showErrorIn, showInfoIn, showSuccessIn } from "./errors";
import { refreshHistory, undoNewest } from "./history";
import type { AppState, AppStore, Slice } from "./types";
import type { ToastAction } from "./ui";

/** The open deck, the slide selected in it, and the slide rail's picks and changes to the slides. */
export interface SlidesSlice {
  deck: Deck | null;
  /** Id of the selected slide. */
  selected: string | null;
  /** Bumped whenever the user picks a slide, so views can reveal it even if unchanged. */
  revealRev: number;
  /** The slides picked in the rail when there are several; empty when it is just `selected`. */
  railSelected: string[];
  /**
   * Where a range of picked slides starts: ⇧-click and ⇧ with the arrows pick from it to the slide
   * they go to. Null while it is the selected slide (see `rangeAnchor`).
   */
  railAnchor: string | null;
  /** Every slide shows as a grid in the place of the stage (see ../components/SlideOverview.tsx). */
  overview: boolean;
  /** The layouts to add a slide on are open (the slide list's "+", ⇧⌘N, "New slide…" in a menu). */
  addingSlide: boolean;
  /**
   * The rail's folded sections, each named by its first slide's id, which moves with the section.
   * Remembered per deck between launches (see `railStateOf`).
   */
  collapsedSections: string[];
  /** Bumped to play the animations of the slide on the stage again (see `replaySlide`). */
  replayRev: number;

  /**
   * Shows `deck` as the open deck's new state. What did not change in it stays the very objects
   * it was (see `shareDeck`), and a deck that changed nothing leaves the store untouched.
   */
  setDeck: (deck: Deck) => void;
  select: (slide: string | null) => void;
  /** Goes `delta` slides on from the selected one, through every slide, also while a search is on. */
  selectRelative: (delta: number) => void;
  /** Goes to the first or the last slide. */
  selectEdge: (edge: "first" | "last") => void;
  /** Picks every slide the rail lists, keeping the selected one on the stage. */
  selectAllSlides: () => void;
  /** Picks `slides` in the rail, with the first of them on the stage unless one of them already is. */
  pickSlides: (slides: string[]) => void;
  /**
   * A click on a slide in the rail with a modifier: `toggle` (⌘) adds or removes the slide,
   * `range` (⇧) picks everything from the selected slide to it, which stays on the stage.
   */
  extendRailSelection: (slide: string, how: "toggle" | "range") => void;
  /**
   * ⇧ with a key that goes to `slide`: picks everything from where the range started to it, and
   * shows it on the stage.
   */
  extendRailTo: (slide: string) => void;
  /** ⇧ with an arrow: the picked range ends `delta` listed slides further on. */
  extendRailBy: (delta: number) => void;
  /** Back to just the selected slide. */
  clearRailSelection: () => void;
  /** Shows every slide as a grid in the place of the stage, or the stage again. */
  setOverview: (overview: boolean) => void;
  /** Leaves the grid of all slides for `slide` on the stage. */
  openSlide: (slide: string) => void;
  /** Opens or closes the layouts to add a slide on. They do not open during a show. */
  setAddingSlide: (open: boolean) => void;
  /** Folds the rail's section that starts with slide `first` to its header, or opens it again. */
  toggleSection: (first: string, collapsed?: boolean) => void;
  /** Folds every section whose first slide is in `firsts`, or opens all of them (and any other). */
  setSectionsCollapsed: (firsts: string[], collapsed: boolean) => void;
  /** Adds a blank slide after `after` (the selected one unless given) and selects it. */
  addSlide: (after?: string | null) => Promise<void>;
  /**
   * Deletes `slides`, leaving locked ones alone, and selects a slide next to them if need be.
   * They go from the rail right away, and come back should the deck file refuse the change.
   * Says how many went, with a way to take it back; `verb` is what happened to them ("Deleted").
   */
  deleteSlides: (slides: string[], verb?: string) => Promise<void>;
  /** Starts a section named "New section" at `slide`; resolves to its index, null when it failed. */
  startSection: (slide: string) => Promise<number | null>;
  renameSection: (index: number, title: string) => Promise<void>;
  /** Takes section `index` out of the rail, leaving its slides where they are; it can be taken back. */
  removeSection: (index: number) => Promise<void>;
  /**
   * Deletes section `index` together with its slides, as one change that can be taken back. With
   * a locked slide in it nothing goes, and it says why.
   */
  deleteSectionSlides: (index: number) => Promise<void>;
  /** Moves section `index`, with its slides, before the section above it (-1) or after the one below (1). */
  moveSection: (index: number, delta: -1 | 1) => Promise<void>;
  /** Runs a change to the deck file as one the slide list can undo; null when it failed. */
  editRail: (change: (id: string) => Promise<RailEdit>) => Promise<RailEdit | null>;
  /** Hides or shows `slides`, as one change, which shows right away. */
  setSlidesHidden: (slides: string[], hidden: boolean) => Promise<void>;
  /** Locks or unlocks `slides`, as one change, which shows right away. */
  setSlidesLocked: (slides: string[], locked: boolean) => Promise<void>;
  /** Copies `slides`, each right after itself, and selects the copies. */
  duplicateSlides: (slides: string[]) => Promise<void>;
  /** Puts the rail's rows (see `sectionKey`) into `order`, showing it right away. */
  reorderRail: (order: string[]) => Promise<void>;
  /** Moves the picked slides one rail row up (-1) or down (1), section markers included. */
  moveSlides: (delta: -1 | 1) => Promise<void>;
  /**
   * Puts the picked slides (see `railSelection`) on the system clipboard, in deck order, to paste
   * into this deck or another one, and says how many. Resolves to whether they were copied.
   */
  copySlides: () => Promise<boolean>;
  /** Copies the picked slides, then deletes those of them that are not locked. */
  cutSlides: () => Promise<void>;
  /**
   * Inserts the slides on the system clipboard (copied here or in another window) after the
   * selected one, in their order, and picks them. Their images come along; styles from the other
   * deck's CSS do not. Resolves to whether there were slides to paste; with `explain`, an empty
   * clipboard is said, as a menu's choice that did nothing would look broken.
   */
  pasteSlides: (explain?: boolean) => Promise<boolean>;
  /** Plays the animations of the slide on the stage from their start, turning them on if the stage showed final states. */
  replaySlide: () => void;
}

/** The rail's picks when no deck is open. */
export const NO_RAIL_STATE = {
  railSelected: [],
  railAnchor: null,
  collapsedSections: [],
  overview: false,
  addingSlide: false,
};

/** Where the folded sections of every deck are remembered, by the deck file's path. */
const COLLAPSED_KEY = "slopslide.collapsedSections";

/** How many decks' folds are remembered; the ones opened longest ago go first. */
const REMEMBERED_DECKS = 50;

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Every deck's folded sections as remembered, most recently changed last. */
function loadCollapsed(): Record<string, string[]> {
  return loadJson(COLLAPSED_KEY, {}, (saved) =>
    Object.fromEntries(Object.entries(saved as Record<string, unknown>).filter(([, firsts]) => isStrings(firsts))),
  ) as Record<string, string[]>;
}

/** Remembers which sections of deck `id` are folded. Losing it only opens them on the next launch. */
function saveCollapsed(id: string, firsts: string[]) {
  const { [id]: _, ...rest } = loadCollapsed();
  const kept = Object.entries(firsts.length > 0 ? { ...rest, [id]: firsts } : rest).slice(-REMEMBERED_DECKS);
  try {
    saveJson(COLLAPSED_KEY, Object.fromEntries(kept));
  } catch {
    // Only the remembered folds are lost.
  }
}

/** The rail as deck `id` opens: nothing picked, the stage showing, its sections folded as they were left. */
export function railStateOf(id: string) {
  return { ...NO_RAIL_STATE, collapsedSections: loadCollapsed()[id] ?? [] };
}

/**
 * The slides the rail lists, in deck order: all of them, also while a search is on. A search
 * marks and counts what it finds (see ./search.ts); it does not take slides off the list.
 */
export function listedSlides(state: Pick<AppState, "deck" | "search">): string[] {
  return (state.deck?.slides ?? []).map((s) => s.id);
}

/** How the deck's history labels the rail's changes that a toast offers to take back (see src-tauri/src/commands/deck.rs). */
const DELETE_SLIDES_LABEL = "Delete slides";
const DELETE_SECTION_LABEL = "Delete section";
const DELETE_SECTION_SLIDES_LABEL = "Delete section and slides";

/** The Undo of a toast about the change labelled `label`; `what` names it if it can no longer be undone. */
const undoAction = (app: AppStore, label: string, what: string): ToastAction => ({
  label: "Undo",
  run: () => void undoNewest(app, label, what),
});

/** The slides the rail's actions apply to, in deck order. */
export function railSelection(state: Pick<AppState, "deck" | "selected" | "railSelected">): string[] {
  const picked = state.railSelected.length > 0 ? state.railSelected : state.selected ? [state.selected] : [];
  return (state.deck?.slides ?? []).map((s) => s.id).filter((id) => picked.includes(id));
}

/**
 * Where a range of picked slides starts: the slide ⇧ was first held on, as long as it is still
 * listed, else the selected one.
 */
export function rangeAnchor(state: Pick<AppState, "deck" | "search" | "selected" | "railAnchor">): string | null {
  const { railAnchor, selected } = state;
  return railAnchor !== null && listedSlides(state).includes(railAnchor) ? railAnchor : selected;
}

/**
 * Where the picked range ends, which is what ⇧ with an arrow moves: the end of the picked slides
 * that is not where the range started. A ⇧-click leaves the slide on the stage where it was, so
 * this need not be the selected slide.
 */
export function rangeFocus(state: Pick<AppState, "deck" | "search" | "selected" | "railSelected" | "railAnchor">) {
  const picked = railSelection(state);
  const anchor = rangeAnchor(state);
  if (picked.length > 1 && anchor === picked[0]) return picked.at(-1)!;
  if (picked.length > 1 && anchor === picked.at(-1)) return picked[0]!;
  return state.selected;
}

/** The slide shown on the stage, if any. */
export function selectedSlide(state: Pick<AppState, "deck" | "selected">): Slide | undefined {
  return state.deck?.slides.find((s) => s.id === state.selected);
}

/** No slides picked. The same list every time, so that picking none again changes nothing. */
const unpicked = (state: Pick<AppState, "railSelected">) => (state.railSelected.length === 0 ? state.railSelected : []);

/** A change to the open deck that is shown before the backend has made it (see `editAhead`). */
type Prediction = { deck: string; predict: (deck: Deck) => Deck };

/**
 * The changes shown ahead, oldest first. Until the backend has answered one, every deck it sends
 * (a slide edit saved before it, the deck file read again) still lacks it, so each is shown with
 * these applied: a deleted slide does not come back for a moment.
 */
const ahead: Prediction[] = [];

/** Shows the deck the backend sent, with the changes shown ahead of it; see `putDeck`. */
function showDeck(app: AppStore, incoming: Deck): boolean {
  return putDeck(
    app,
    ahead.reduce((deck, shown) => (shown.deck === deck.id ? shown.predict(deck) : deck), incoming),
  );
}

/**
 * Makes `next` the open deck, keeping what did not change as the objects they were, the
 * selection on a slide that is still there and the picks that are. Resolves to whether anything
 * changed: a deck that is the one shown already does not touch the store.
 */
function putDeck(app: AppStore, next: Deck): boolean {
  const { deck: before, selected, railSelected, editSaved } = app.getState();
  const deck = shareDeck(before, next);
  if (deck === before) return false;
  if (deck.slides === before?.slides) {
    app.setState({ deck });
    return true;
  }
  const ids = new Set(deck.slides.map((s) => s.id));
  app.setState({
    deck,
    selected: selected !== null && ids.has(selected) ? selected : (deck.slides[0]?.id ?? null),
    railSelected: railSelected.every((id) => ids.has(id)) ? railSelected : railSelected.filter((id) => ids.has(id)),
    editSaved: savesStillShown(editSaved, deck.slides),
  });
  return true;
}

/**
 * Of what the stage's editor saved of each slide (see `editSaved`), what the slide still is: any
 * other change to a slide (an undo, the agent's) is not what the editor shows, even should the
 * slide come back to a version the editor once saved. The same object when nothing goes.
 */
function savesStillShown(saved: Record<string, string>, slides: Deck["slides"]): Record<string, string> {
  const gone = slides.filter((slide) => slide.id in saved && saved[slide.id] !== slide.hash);
  if (gone.length === 0) return saved;
  const kept = { ...saved };
  for (const slide of gone) delete kept[slide.id];
  return kept;
}

/**
 * Shows a change to the open deck right away, as `predict` says the deck will be, then makes it
 * after the edits queued before it and shows the deck the backend answers with (`deckOf` its
 * answer). One that fails is reported and the deck read from its file again, which takes what
 * was shown ahead back. Resolves to the backend's answer, null when it failed. The deck's
 * history is asked once, when the change is made: what was shown ahead is not in it yet.
 */
function editAhead<T>(
  app: AppStore,
  predict: (deck: Deck) => Deck,
  change: (id: string) => Promise<T>,
  deckOf: (answer: T) => Deck,
): Promise<T | null> {
  const { deck } = app.getState();
  if (!deck) return Promise.resolve(null);
  const shown: Prediction = { deck: deck.id, predict };
  putDeck(app, predict(deck));
  ahead.push(shown);
  const open = () => app.getState().deck?.id === deck.id;
  return queueEdit(async () => {
    try {
      const answer = await change(deck.id);
      ahead.splice(ahead.indexOf(shown), 1);
      if (open()) {
        showDeck(app, deckOf(answer));
        void refreshHistory(app);
      }
      return answer;
    } catch (error) {
      ahead.splice(ahead.indexOf(shown), 1);
      showErrorIn(app, error);
      if (!open()) return null;
      // What was shown ahead did not happen: back to the deck as its file has it, or, should
      // that not be readable either, as it was before the change.
      const saved = await api.loadDeck(deck.id).catch(() => deck);
      if (open()) showDeck(app, saved);
      return null;
    }
  });
}

/**
 * Takes the selection off the slides `doomed`, which are about to be deleted: the stage goes on to
 * the next slide that stays, else the one before, and none is picked. What it returns puts the
 * stage back on its slide, for when the slides were not deleted after all, unless the user went
 * on since.
 */
function leaveSlides(app: AppStore, doomed: ReadonlySet<string>): () => void {
  const { deck, selected, select } = app.getState();
  if (!deck) return () => {};
  const leaving = selected !== null && doomed.has(selected);
  const here = deck.slides.findIndex((s) => s.id === selected);
  const left = (s: Slide) => !doomed.has(s.id);
  const neighbor = deck.slides.slice(here + 1).find(left) ?? deck.slides.slice(0, here).findLast(left);
  if (leaving) select(neighbor?.id ?? null);
  app.setState((s) => ({ railSelected: unpicked(s), railAnchor: null }));
  return () => {
    const now = app.getState();
    if (leaving && now.selected === (neighbor?.id ?? null) && now.deck?.slides.some((s) => s.id === selected)) {
      now.select(selected);
    }
  };
}

/**
 * Queues a rail change after the edits before it and shows its deck. The change is one more in
 * the deck's history even when it leaves the slides as the app has them, so the history is asked.
 */
export function editRail(app: AppStore, change: (id: string) => Promise<RailEdit>): Promise<RailEdit | null> {
  return queueEdit(async () => {
    const { deck } = app.getState();
    if (!deck) return null;
    try {
      const edit = await change(deck.id);
      if (app.getState().deck?.id !== deck.id) return edit;
      showDeck(app, edit.deck);
      void refreshHistory(app);
      return edit;
    } catch (error) {
      showErrorIn(app, error);
      return null;
    }
  });
}

export const createSlidesSlice: Slice<SlidesSlice> = (set, get, app) => ({
  deck: null,
  selected: null,
  revealRev: 0,
  ...NO_RAIL_STATE,
  replayRev: 0,

  setDeck: (deck) => {
    // Only a deck that changed can have a history that did.
    if (showDeck(app, deck)) void refreshHistory(app);
  },

  select: (slide) =>
    set((s) => ({ selected: slide, railSelected: unpicked(s), railAnchor: null, revealRev: s.revealRev + 1 })),

  selectRelative: (delta) => {
    const { deck, selected } = get();
    if (!deck || deck.slides.length === 0) return;
    const ids = listedSlides(get());
    const at = ids.indexOf(selected ?? "");
    const next = ids[Math.min(ids.length - 1, Math.max(0, at + delta))];
    set((s) => ({ selected: next ?? null, railSelected: unpicked(s), railAnchor: null, revealRev: s.revealRev + 1 }));
  },

  selectEdge: (edge) => {
    const ids = listedSlides(get());
    const slide = edge === "first" ? ids[0] : ids.at(-1);
    if (slide !== undefined) get().select(slide);
  },

  selectAllSlides: () => get().pickSlides(listedSlides(get())),

  pickSlides: (slides) => {
    if (slides.length === 0) return;
    set((s) => {
      const selected = s.selected && slides.includes(s.selected) ? s.selected : slides[0]!;
      return {
        selected,
        railSelected: slides.length > 1 ? slides : [],
        railAnchor: null,
        revealRev: selected === s.selected ? s.revealRev : s.revealRev + 1,
      };
    });
  },

  extendRailSelection: (slide, how) => {
    const { deck } = get();
    if (!deck) return;
    const picked = railSelection(get());
    if (how === "range") {
      const ids = deck.slides.map((s) => s.id);
      const anchor = rangeAnchor(get()) ?? slide;
      const [from, to] = [ids.indexOf(anchor), ids.indexOf(slide)].sort((a, b) => a - b) as [number, number];
      const range = ids.slice(from, to + 1);
      set({ railSelected: range.length > 1 ? range : [], railAnchor: anchor });
    } else if (!picked.includes(slide)) {
      // The slide added is where a range picked next starts.
      set((s) => ({
        railSelected: [...picked, slide],
        selected: slide,
        railAnchor: null,
        revealRev: s.revealRev + 1,
      }));
    } else if (picked.length > 1) {
      const rest = picked.filter((id) => id !== slide);
      set((s) => ({
        railSelected: rest.length > 1 ? rest : [],
        selected: rest.includes(s.selected ?? "") ? s.selected : (rest.at(-1) ?? null),
        railAnchor: null,
      }));
    }
  },

  extendRailTo: (slide) => {
    const ids = listedSlides(get());
    const anchor = rangeAnchor(get());
    if (!ids.includes(slide)) return;
    // With nothing to start from (no slide on the stage), the range is the slide.
    const start = anchor !== null && ids.includes(anchor) ? anchor : slide;
    const [from, to] = [ids.indexOf(start), ids.indexOf(slide)].sort((a, b) => a - b) as [number, number];
    const range = ids.slice(from, to + 1);
    set((s) => ({
      selected: slide,
      railSelected: range.length > 1 ? range : unpicked(s),
      railAnchor: start,
      revealRev: s.revealRev + 1,
    }));
  },

  extendRailBy: (delta) => {
    const ids = listedSlides(get());
    if (ids.length === 0) return;
    const at = ids.indexOf(rangeFocus(get()) ?? "");
    // The slide shown is not one of those listed: the range starts at the listed end that way.
    const to = at < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, at + delta));
    get().extendRailTo(ids[to]!);
  },

  clearRailSelection: () => set({ railSelected: [], railAnchor: null }),

  setOverview: (overview) => {
    if (get().deck && get().overview !== overview) set({ overview });
  },

  openSlide: (slide) => {
    get().select(slide);
    get().setOverview(false);
  },

  setAddingSlide: (open) => {
    const addingSlide = open && !!get().deck && !get().presenting;
    if (get().addingSlide !== addingSlide) set({ addingSlide });
  },

  toggleSection: (first, collapsed) => {
    const { deck, collapsedSections } = get();
    const now = collapsedSections.includes(first);
    if ((collapsed ?? !now) === now) return;
    const next = now ? collapsedSections.filter((id) => id !== first) : [...collapsedSections, first];
    set({ collapsedSections: next });
    if (deck) saveCollapsed(deck.id, next);
  },

  setSectionsCollapsed: (firsts, collapsed) => {
    const { deck, collapsedSections } = get();
    const next = collapsed ? [...new Set([...collapsedSections, ...firsts])] : [];
    if (next.length === collapsedSections.length) return;
    set({ collapsedSections: next });
    if (deck) saveCollapsed(deck.id, next);
  },

  editRail: (change) => editRail(app, change),

  addSlide: async (after) => {
    const { deck } = get();
    if (!deck) return;
    try {
      const created = await api.addSlide(deck.id, after === undefined ? get().selected : after);
      if (get().deck?.id !== deck.id) return;
      get().setDeck(created.deck);
      get().select(created.slide);
    } catch (error) {
      showErrorIn(app, error);
    }
  },

  deleteSlides: async (slides, verb = "Deleted") => {
    const { deck } = get();
    const doomed = new Set(deck?.slides.filter((s) => slides.includes(s.id) && !s.locked).map((s) => s.id));
    if (!deck || doomed.size === 0) return;
    const comeBack = leaveSlides(app, doomed);
    const edit = await editAhead(
      app,
      (shown) => withoutSlides(shown, doomed),
      (id) => api.deleteSlides(id, [...doomed]),
      (answer) => answer.deck,
    );
    if (!edit) return comeBack();
    // The deck file drops the slides' review marks with them; forget them here too.
    for (const slide of doomed) get().clearSketch(slide);
    const text = `${verb} ${plural(doomed.size, "slide")}`;
    showSuccessIn(app, text, undoAction(app, DELETE_SLIDES_LABEL, "delete"));
  },

  startSection: async (slide) => {
    const { deck } = get();
    const before = deck?.slides.findIndex((s) => s.id === slide) ?? -1;
    if (!deck || before < 0) return null;
    try {
      const next = await api.addSection(deck.id, slide, "New section");
      if (get().deck?.id !== deck.id) return null;
      get().setDeck(next);
      return next.sections.filter((s) => s.before === before).at(-1)?.index ?? null;
    } catch (error) {
      showErrorIn(app, error);
      return null;
    }
  },

  renameSection: async (index, title) => {
    const { deck } = get();
    if (!deck) return;
    try {
      const next = await api.renameSection(deck.id, index, title);
      if (get().deck?.id === deck.id) get().setDeck(next);
    } catch (error) {
      showErrorIn(app, error);
    }
  },

  removeSection: async (index) => {
    const { deck } = get();
    const section = deck?.sections.find((s) => s.index === index);
    if (!deck || !section) return;
    try {
      const next = await api.deleteSection(deck.id, index);
      if (get().deck?.id !== deck.id) return;
      get().setDeck(next);
      const name = section.title ? `the section “${section.title}”` : "the section";
      showSuccessIn(app, `Removed ${name}; its slides stay`, undoAction(app, DELETE_SECTION_LABEL, "removal"));
    } catch (error) {
      showErrorIn(app, error);
    }
  },

  deleteSectionSlides: async (index) => {
    const { deck } = get();
    const section = deck?.sections.find((s) => s.index === index);
    if (!deck || !section) return;
    const rows = sectionBlocks(railItems(deck)).find((block) => block.key === sectionKey(index))?.rows ?? [];
    const slides = deck.slides.filter((s) => rows.includes(s.id));
    if (slides.length === 0) return get().removeSection(index);
    if (slides.some((s) => s.locked)) {
      showInfoIn(app, "This section holds a locked slide. Unlock it to delete the section with its slides.");
      return;
    }
    const doomed = new Set(slides.map((s) => s.id));
    const comeBack = leaveSlides(app, doomed);
    const edit = await editAhead(
      app,
      (shown) => withoutSection(withoutSlides(shown, doomed), index),
      (id) => api.deleteSectionSlides(id, index, [...doomed]),
      (answer) => answer.deck,
    );
    if (!edit) return comeBack();
    for (const slide of doomed) get().clearSketch(slide);
    const name = section.title ? `the section “${section.title}”` : "the section";
    showSuccessIn(
      app,
      `Deleted ${name} and its ${plural(doomed.size, "slide")}`,
      undoAction(app, DELETE_SECTION_SLIDES_LABEL, "delete"),
    );
  },

  moveSection: async (index, delta) => {
    const { deck } = get();
    if (!deck) return;
    const order = stepSection(railItems(deck), sectionKey(index), delta);
    if (order) await get().reorderRail(order);
  },

  setSlidesHidden: async (slides, hidden) => {
    if (slides.length === 0) return;
    await editAhead(
      app,
      (shown) => withSlidesMarked(shown, slides, { hidden }),
      (id) => api.setSlidesHidden(id, slides, hidden),
      (answer) => answer.deck,
    );
  },

  setSlidesLocked: async (slides, locked) => {
    if (slides.length === 0) return;
    await editAhead(
      app,
      (shown) => withSlidesMarked(shown, slides, { locked }),
      (id) => api.setSlidesLocked(id, slides, locked),
      (answer) => answer,
    );
  },

  duplicateSlides: async (slides) => {
    if (slides.length === 0) return;
    const edit = await editRail(app, (id) => api.duplicateSlides(id, slides));
    if (!edit) return;
    get().select(edit.created.at(-1) ?? null);
    if (edit.created.length > 1) set({ railSelected: edit.created });
  },

  reorderRail: async (order) => {
    const rows = new Set(order);
    // An order only says where the rows it names go: a deck with other rows is left as it is.
    const complete = (shown: Deck) => {
      const items = railItems(shown);
      return items.length === rows.size && items.every((item) => rows.has(item.key));
    };
    await editAhead(
      app,
      (shown) => (complete(shown) ? applyOrder(shown, order) : shown),
      (id) => api.reorderSlides(id, order),
      (answer) => answer.deck,
    );
  },

  moveSlides: async (delta) => {
    const { deck } = get();
    if (!deck) return;
    const keys = railItems(deck).map((item) => item.key);
    const order = stepRows(keys, railSelection(get()), delta);
    if (order.some((key, i) => key !== keys[i])) await get().reorderRail(order);
  },

  copySlides: async () => {
    const { deck } = get();
    const slides = railSelection(get());
    if (!deck || slides.length === 0) return false;
    try {
      await api.copySlides(deck.id, slides);
      showSuccessIn(app, `${plural(slides.length, "slide")} copied`);
      return true;
    } catch (error) {
      showErrorIn(app, error);
      return false;
    }
  },

  cutSlides: async () => {
    const { deck } = get();
    const picked = railSelection(get());
    const free = (deck?.slides ?? []).filter((s) => picked.includes(s.id) && !s.locked).map((s) => s.id);
    if (!deck || free.length === 0) return;
    try {
      // Only what goes is taken along: a locked slide stays, so it is not on the clipboard either.
      await api.copySlides(deck.id, free);
    } catch (error) {
      showErrorIn(app, error);
      return;
    }
    await get().deleteSlides(free, "Cut");
  },

  pasteSlides: async (explain = false) => {
    const { deck, selected } = get();
    if (!deck) return false;
    try {
      const pasted = await api.pasteSlides(deck.id, selected);
      if (!pasted) {
        if (explain) {
          showInfoIn(app, `There are no slides to paste. Copy some first (${formatKeys("mod+c")} in the slide list).`);
        }
        return false;
      }
      if (get().deck?.id === deck.id) {
        get().setDeck(pasted.deck);
        get().select(pasted.created.at(-1) ?? null);
        if (pasted.created.length > 1) set({ railSelected: pasted.created });
      }
      return true;
    } catch (error) {
      showErrorIn(app, error);
      return false;
    }
  },

  replaySlide: () => {
    if (get().finalState) get().setFinalState(false);
    set((s) => ({ replayRev: s.replayRev + 1 }));
  },
});
