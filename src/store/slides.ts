import { api, type Deck, type RailEdit, type Slide } from "../lib/api";
import { applyOrder, railItems, stepRows } from "../lib/sections";
import { loadJson, saveJson } from "../lib/storage";
import { plural } from "../lib/utils";
import { queueEdit } from "./editQueue";
import { showErrorIn, showSuccessIn } from "./errors";
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
   * The rail's folded sections, each named by its first slide's id, which moves with the section.
   * Remembered per deck between launches (see `railStateOf`).
   */
  collapsedSections: string[];
  /** Bumped to play the animations of the slide on the stage again (see `replaySlide`). */
  replayRev: number;
  /** Slides being saved as images into `dir`, one at a time; null when not exporting. */
  imageExport: { dir: string; slides: string[] } | null;

  setDeck: (deck: Deck) => void;
  select: (slide: string | null) => void;
  /**
   * Goes `delta` slides on from the selected one. While a search lists only the slides it found,
   * those are the ones it steps through, as they are the ones the rail shows.
   */
  selectRelative: (delta: number) => void;
  /** Goes to the first or the last slide (of those a search found, while one is on). */
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
  /** Back to just the selected slide. */
  clearRailSelection: () => void;
  /** Folds the rail's section that starts with slide `first` to its header, or opens it again. */
  toggleSection: (first: string, collapsed?: boolean) => void;
  /** Folds every section whose first slide is in `firsts`, or opens all of them (and any other). */
  setSectionsCollapsed: (firsts: string[], collapsed: boolean) => void;
  /** Adds a blank slide after `after` (the selected one unless given) and selects it. */
  addSlide: (after?: string | null) => Promise<void>;
  /**
   * Deletes `slides`, leaving locked ones alone, and selects a slide next to them if need be.
   * Says how many went, with a way to take it back; `verb` is what happened to them ("Deleted").
   */
  deleteSlides: (slides: string[], verb?: string) => Promise<void>;
  /** Starts a section named "New section" at `slide`; resolves to its index, null when it failed. */
  startSection: (slide: string) => Promise<number | null>;
  renameSection: (index: number, title: string) => Promise<void>;
  /** Takes section `index` out of the rail, leaving its slides where they are; it can be taken back. */
  removeSection: (index: number) => Promise<void>;
  /** Runs a change to the deck file as one the slide list can undo; null when it failed. */
  editRail: (change: (id: string) => Promise<RailEdit>) => Promise<RailEdit | null>;
  setSlidesHidden: (slides: string[], hidden: boolean) => Promise<void>;
  /** Locks or unlocks `slides`, as one change. */
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
   * deck's CSS do not. Resolves to whether there were slides to paste.
   */
  pasteSlides: () => Promise<boolean>;
  /** Plays the animations of the slide on the stage from their start, turning them on if the stage showed final states. */
  replaySlide: () => void;
  startImageExport: (dir: string) => void;
  endImageExport: () => void;
}

/** The rail's picks when no deck is open. */
export const NO_RAIL_STATE = { railSelected: [], collapsedSections: [] };

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

/** The rail's picks as deck `id` opens: nothing picked, its sections folded as they were left. */
export function railStateOf(id: string) {
  return { railSelected: [], collapsedSections: loadCollapsed()[id] ?? [] };
}

/** The slides the rail lists, in deck order: all of them, or while a search is on only those it found. */
export function listedSlides(state: Pick<AppState, "deck" | "search">): string[] {
  const ids = (state.deck?.slides ?? []).map((s) => s.id);
  const { matches } = state.search;
  if (!matches) return ids;
  const found = new Set(matches.map((m) => m.slide));
  return ids.filter((id) => found.has(id));
}

/** How the deck's history labels the rail's changes that a toast offers to take back (see src-tauri/src/commands/deck.rs). */
const DELETE_SLIDES_LABEL = "Delete slides";
const DELETE_SECTION_LABEL = "Delete section";

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

/** The slide shown on the stage, if any. */
export function selectedSlide(state: Pick<AppState, "deck" | "selected">): Slide | undefined {
  return state.deck?.slides.find((s) => s.id === state.selected);
}

/** Queues a rail change after the edits before it and shows its deck. */
export function editRail(app: AppStore, change: (id: string) => Promise<RailEdit>): Promise<RailEdit | null> {
  return queueEdit(async () => {
    const { deck } = app.getState();
    if (!deck) return null;
    try {
      const edit = await change(deck.id);
      if (app.getState().deck?.id !== deck.id) return edit;
      app.getState().setDeck(edit.deck);
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
  railSelected: [],
  collapsedSections: [],
  replayRev: 0,
  imageExport: null,

  setDeck: (deck) => {
    const { selected, railSelected } = get();
    const stillThere = deck.slides.some((s) => s.id === selected);
    set({
      deck,
      selected: stillThere ? selected : (deck.slides[0]?.id ?? null),
      railSelected: railSelected.filter((id) => deck.slides.some((s) => s.id === id)),
    });
    void refreshHistory(app);
  },

  select: (slide) => set((s) => ({ selected: slide, railSelected: [], revealRev: s.revealRev + 1 })),

  selectRelative: (delta) => {
    const { deck, selected } = get();
    if (!deck || deck.slides.length === 0) return;
    const all = deck.slides.map((s) => s.id);
    const listed = listedSlides(get());
    // A search that found nothing lists no slide to step through; the keys then go through them all.
    const ids = listed.length > 0 ? listed : all;
    const at = ids.indexOf(selected ?? "");
    let next = ids[Math.min(ids.length - 1, Math.max(0, at + delta))];
    // The slide shown is not one of those listed: on to the nearest listed one that way, if any.
    if (at < 0) {
      const here = all.indexOf(selected ?? "");
      next = delta > 0 ? ids.find((id) => all.indexOf(id) > here) : ids.findLast((id) => all.indexOf(id) < here);
      if (next === undefined) return;
    }
    set((s) => ({ selected: next ?? null, railSelected: [], revealRev: s.revealRev + 1 }));
  },

  selectEdge: (edge) => {
    const listed = listedSlides(get());
    const ids = listed.length > 0 ? listed : (get().deck?.slides ?? []).map((s) => s.id);
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
        revealRev: selected === s.selected ? s.revealRev : s.revealRev + 1,
      };
    });
  },

  extendRailSelection: (slide, how) => {
    const { deck, selected, search } = get();
    if (!deck) return;
    const picked = railSelection(get());
    if (how === "range") {
      const ids = deck.slides.map((s) => s.id);
      const [from, to] = [ids.indexOf(selected ?? slide), ids.indexOf(slide)].sort((a, b) => a - b) as [number, number];
      // A search only shows some slides; those are the ones to pick.
      const shown = search.matches && new Set(search.matches.map((m) => m.slide));
      const range = ids.slice(from, to + 1).filter((id) => !shown || shown.has(id));
      set({ railSelected: range.length > 1 ? range : [] });
    } else if (!picked.includes(slide)) {
      set((s) => ({ railSelected: [...picked, slide], selected: slide, revealRev: s.revealRev + 1 }));
    } else if (picked.length > 1) {
      const rest = picked.filter((id) => id !== slide);
      set((s) => ({
        railSelected: rest.length > 1 ? rest : [],
        selected: rest.includes(s.selected ?? "") ? s.selected : (rest.at(-1) ?? null),
      }));
    }
  },

  clearRailSelection: () => set({ railSelected: [] }),

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
    const edit = await editRail(app, async (id) => {
      const edit = await api.deleteSlides(id, [...doomed]);
      // The deck file drops the slides' review marks with them; forget them here too.
      for (const slide of doomed) get().clearSketch(slide);
      const { selected } = get();
      const here = deck.slides.findIndex((s) => s.id === selected);
      if (selected && doomed.has(selected)) {
        const left = (s: Slide) => !doomed.has(s.id);
        const neighbor = deck.slides.slice(here + 1).find(left) ?? deck.slides.slice(0, here).findLast(left);
        get().select(neighbor?.id ?? null);
      }
      return edit;
    });
    set({ railSelected: [] });
    if (!edit) return;
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

  setSlidesHidden: async (slides, hidden) => {
    if (slides.length > 0) await editRail(app, (id) => api.setSlidesHidden(id, slides, hidden));
  },

  setSlidesLocked: async (slides, locked) => {
    const { deck } = get();
    if (!deck || slides.length === 0) return;
    try {
      const next = await api.setSlidesLocked(deck.id, slides, locked);
      if (get().deck?.id === deck.id) get().setDeck(next);
    } catch (error) {
      showErrorIn(app, error);
    }
  },

  duplicateSlides: async (slides) => {
    if (slides.length === 0) return;
    const edit = await editRail(app, (id) => api.duplicateSlides(id, slides));
    if (!edit) return;
    get().select(edit.created.at(-1) ?? null);
    if (edit.created.length > 1) set({ railSelected: edit.created });
  },

  reorderRail: async (order) => {
    const { deck } = get();
    if (!deck) return;
    get().setDeck(applyOrder(deck, order));
    const edit = await editRail(app, (id) => api.reorderSlides(id, order));
    if (edit) return;
    try {
      if (get().deck?.id === deck.id) get().setDeck(await api.loadDeck(deck.id));
    } catch (error) {
      showErrorIn(app, error);
    }
  },

  moveSlides: async (delta) => {
    const { deck, search } = get();
    if (!deck || search.matches) return;
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

  pasteSlides: async () => {
    const { deck, selected } = get();
    if (!deck) return false;
    try {
      const pasted = await api.pasteSlides(deck.id, selected);
      if (!pasted) return false;
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

  startImageExport: (dir) => {
    const { deck } = get();
    if (deck && deck.slides.length > 0) set({ imageExport: { dir, slides: deck.slides.map((s) => s.id) } });
  },

  endImageExport: () => set({ imageExport: null }),
});
