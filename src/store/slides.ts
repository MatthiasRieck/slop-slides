import { api, type Deck, type RailEdit, type Slide } from "../lib/api";
import { applyOrder, railItems, stepRows } from "../lib/sections";
import { queueEdit } from "./editQueue";
import { showErrorIn } from "./errors";
import { refreshHistory } from "./history";
import type { AppState, AppStore, Slice } from "./types";

/** The open deck, the slide selected in it, and the slide rail's picks and changes to the slides. */
export interface SlidesSlice {
  deck: Deck | null;
  /** Id of the selected slide. */
  selected: string | null;
  /** Bumped whenever the user picks a slide, so views can reveal it even if unchanged. */
  revealRev: number;
  /** The slides picked in the rail when there are several; empty when it is just `selected`. */
  railSelected: string[];
  /** The rail's folded sections, each named by its first slide's id, which moves with the section. */
  collapsedSections: string[];
  /** Slides being saved as images into `dir`, one at a time; null when not exporting. */
  imageExport: { dir: string; slides: string[] } | null;

  setDeck: (deck: Deck) => void;
  select: (slide: string | null) => void;
  selectRelative: (delta: number) => void;
  /**
   * A click on a slide in the rail with a modifier: `toggle` (⌘) adds or removes the slide,
   * `range` (⇧) picks everything from the selected slide to it, which stays on the stage.
   */
  extendRailSelection: (slide: string, how: "toggle" | "range") => void;
  /** Back to just the selected slide. */
  clearRailSelection: () => void;
  /** Folds the rail's section that starts with slide `first` to its header, or opens it again. */
  toggleSection: (first: string, collapsed?: boolean) => void;
  /** Deletes `slides`, leaving locked ones alone, and selects a slide next to them if need be. */
  deleteSlides: (slides: string[]) => Promise<void>;
  /** Runs a change to the deck file as one the slide list can undo; null when it failed. */
  editRail: (change: (id: string) => Promise<RailEdit>) => Promise<RailEdit | null>;
  setSlidesHidden: (slides: string[], hidden: boolean) => Promise<void>;
  /** Copies `slides`, each right after itself, and selects the copies. */
  duplicateSlides: (slides: string[]) => Promise<void>;
  /** Puts the rail's rows (see `sectionKey`) into `order`, showing it right away. */
  reorderRail: (order: string[]) => Promise<void>;
  /** Moves the picked slides one rail row up (-1) or down (1), section markers included. */
  moveSlides: (delta: -1 | 1) => Promise<void>;
  /** Puts the selected slide on the system clipboard, to paste into this deck or another one. */
  copySlide: () => Promise<void>;
  /**
   * Inserts the slide on the system clipboard (copied here or in another window) after the
   * selected one and selects it. Its images come along; styles from the other deck's CSS do not.
   * Resolves to whether there was a slide to paste.
   */
  pasteSlide: () => Promise<boolean>;
  startImageExport: (dir: string) => void;
  endImageExport: () => void;
}

/** The rail's picks when no deck is open. */
export const NO_RAIL_STATE = { railSelected: [], collapsedSections: [] };

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
    const index = deck.slides.findIndex((s) => s.id === selected);
    const next = Math.min(deck.slides.length - 1, Math.max(0, index + delta));
    set((s) => ({ selected: deck.slides[next]?.id ?? null, railSelected: [], revealRev: s.revealRev + 1 }));
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

  toggleSection: (first, collapsed) =>
    set((s) => {
      const now = s.collapsedSections.includes(first);
      if ((collapsed ?? !now) === now) return {};
      return {
        collapsedSections: now ? s.collapsedSections.filter((id) => id !== first) : [...s.collapsedSections, first],
      };
    }),

  editRail: (change) => editRail(app, change),

  deleteSlides: async (slides) => {
    const { deck } = get();
    const doomed = new Set(deck?.slides.filter((s) => slides.includes(s.id) && !s.locked).map((s) => s.id));
    if (!deck || doomed.size === 0) return;
    await editRail(app, async (id) => {
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
  },

  setSlidesHidden: async (slides, hidden) => {
    if (slides.length > 0) await editRail(app, (id) => api.setSlidesHidden(id, slides, hidden));
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

  copySlide: async () => {
    const { deck, selected } = get();
    if (!deck || !selected) return;
    try {
      await api.copySlide(deck.id, selected);
    } catch (error) {
      showErrorIn(app, error);
    }
  },

  pasteSlide: async () => {
    const { deck, selected } = get();
    if (!deck) return false;
    try {
      const created = await api.pasteSlide(deck.id, selected);
      if (!created) return false;
      if (get().deck?.id === deck.id) {
        get().setDeck(created.deck);
        get().select(created.slide);
      }
      return true;
    } catch (error) {
      showErrorIn(app, error);
      return false;
    }
  },

  startImageExport: (dir) => {
    const { deck } = get();
    if (deck && deck.slides.length > 0) set({ imageExport: { dir, slides: deck.slides.map((s) => s.id) } });
  },

  endImageExport: () => set({ imageExport: null }),
});
