import { create } from "zustand";

import { parseSvg, replaceSvgInSlide } from "./lib/svgEdit";
import { useApp } from "./store";
import { confirmDiscard } from "./store/confirm";

/** What the slide editor hands over to open a drawing (see "slop:edit-open-svg" in assets/editor/). */
export interface SvgOpen {
  deckId: string;
  slide: string;
  /** Child-index path from the slide to the drawing. */
  path: number[] | null;
  markup: string;
  /** Its size on the slide, in slide pixels. */
  size: { w: number; h: number };
  /** Its text color, for `currentColor`. */
  color: string | null;
  /** The deck's CSS variables as the drawing sees them. */
  vars: Record<string, string>;
  /** The deck's style rules, but its web fonts. */
  css: string;
  /** The deck's @font-face rules and imports of web font stylesheets, which work only in the app's document. */
  fonts: string;
  /** The elements it sits in on the slide, outermost first, so the deck's rules match it. */
  ancestors: SvgAncestor[];
}

/** An element a drawing sits in on its slide. */
export interface SvgAncestor {
  tag: string;
  attrs: Record<string, string>;
}

/** At most this much of the deck's CSS, and this many elements around it, go with a drawing. */
const MAX_CSS = 2 * 1024 * 1024;
const MAX_ANCESTORS = 64;

/** The elements around a drawing from an "slop:edit-open-svg" message, without anything malformed or active. */
function parseAncestors(value: unknown): SvgAncestor[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_ANCESTORS).flatMap((item) => {
    const { tag, attrs } = (item ?? {}) as { tag?: unknown; attrs?: unknown };
    if (typeof tag !== "string" || !/^[a-z][a-z\d-]*$/i.test(tag)) return [];
    const kept = Object.entries(attrs && typeof attrs === "object" ? attrs : {}).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && /^[a-z_:][\w:.-]*$/i.test(entry[0]) && !/^on|(^|:)href$|^src$/i.test(entry[0]),
    );
    return [{ tag: tag.toLowerCase(), attrs: Object.fromEntries(kept) }];
  });
}

/** The drawing a "slop:edit-open-svg" message from the slide editor hands over in deck `deckId`; null when malformed. */
export function parseSvgOpen(data: Record<string, unknown>, deckId: string | undefined): SvgOpen | null {
  const { slide, path, markup, width, height, color, vars, css, fonts, ancestors } = data;
  if (!deckId || typeof slide !== "string" || typeof markup !== "string") return null;
  const size = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 100);
  const strings = Object.entries(vars && typeof vars === "object" ? vars : {}).filter(
    (entry): entry is [string, string] => entry[0].startsWith("--") && typeof entry[1] === "string",
  );
  return {
    deckId,
    slide,
    path: Array.isArray(path) && path.every((i) => Number.isInteger(i) && i >= 0) ? (path as number[]) : null,
    markup,
    size: { w: size(width), h: size(height) },
    color: typeof color === "string" && color ? color : null,
    vars: Object.fromEntries(strings),
    css: typeof css === "string" && css.length <= MAX_CSS ? css : "",
    fonts: typeof fonts === "string" && fonts.length <= MAX_CSS ? fonts : "",
    ancestors: parseAncestors(ancestors),
  };
}

/** A drawing open in the SVG editor, edited in memory until it is accepted or discarded. */
export interface SvgEdit extends Omit<SvgOpen, "markup"> {
  /** The drawing as it is on the slide (as it was accepted last). */
  original: string;
  /** The drawing as edited. */
  draft: string;
  /** Earlier drafts, newest last, for undo; and the undone ones, for redo. */
  past: string[];
  future: string[];
  /** An accept is being saved. */
  saving: boolean;
}

/** How many steps undo goes back. */
const MAX_UNDO = 200;

interface SvgEditorState {
  edit: SvgEdit | null;
  /**
   * Opens a drawing in the SVG editor tab; one with changes not accepted yet asks before it is
   * left. False when it stays.
   */
  open: (drawing: SvgOpen) => Promise<boolean>;
  /** Makes `draft` the drawing as edited. `record` false folds it into the last step (a drag). */
  change: (draft: string, record?: boolean) => void;
  undo: () => void;
  redo: () => void;
  /** Goes back to the drawing as it is on the slide; undo brings the changes back. */
  discard: () => void;
  /** Saves the edited drawing into its slide; it stays open to edit on. */
  accept: () => Promise<boolean>;
  /** Closes the SVG editor's tab, asking first when there are changes not accepted. */
  close: () => Promise<boolean>;
}

export const isDirty = (edit: SvgEdit | null) => !!edit && edit.draft !== edit.original;

const confirmLeave = () => confirmDiscard("The drawing has changes you have not accepted. Discard them?");

export const useSvgEditor = create<SvgEditorState>((set, get) => ({
  edit: null,

  open: async (drawing) => {
    if (!parseSvg(drawing.markup)) {
      useApp.getState().setError("The selection is not an SVG drawing.");
      return false;
    }
    const current = get().edit;
    const same =
      current?.deckId === drawing.deckId &&
      current.slide === drawing.slide &&
      current.original === drawing.markup &&
      String(current.path) === String(drawing.path);
    if (!same && isDirty(current) && !(await confirmLeave())) {
      useApp.getState().setSidebarTab("svg");
      return false;
    }
    if (!same) {
      const { markup, ...where } = drawing;
      set({ edit: { ...where, original: markup, draft: markup, past: [], future: [], saving: false } });
    }
    useApp.getState().setSidebarTab("svg");
    return true;
  },

  change: (draft, record = true) => {
    const edit = get().edit;
    if (!edit || draft === edit.draft) return;
    const past = record ? [...edit.past, edit.draft].slice(-MAX_UNDO) : edit.past;
    set({ edit: { ...edit, draft, past, future: [] } });
  },

  undo: () => {
    const edit = get().edit;
    const previous = edit?.past.at(-1);
    if (!edit || previous === undefined) return;
    set({ edit: { ...edit, draft: previous, past: edit.past.slice(0, -1), future: [edit.draft, ...edit.future] } });
  },

  redo: () => {
    const edit = get().edit;
    const next = edit?.future[0];
    if (!edit || next === undefined) return;
    set({ edit: { ...edit, draft: next, past: [...edit.past, edit.draft], future: edit.future.slice(1) } });
  },

  discard: () => {
    const edit = get().edit;
    if (isDirty(edit)) get().change(edit!.original);
  },

  accept: async () => {
    const edit = get().edit;
    const { deck } = useApp.getState();
    if (!edit || !isDirty(edit) || edit.saving) return false;
    if (deck?.id !== edit.deckId) {
      useApp.getState().setError("Open the deck the drawing is in to save it.");
      return false;
    }
    if (!parseSvg(edit.draft)) {
      useApp.getState().setError("The markup is not one <svg> drawing; fix it before accepting.");
      return false;
    }
    const { original, draft, path, slide } = edit;
    set({ edit: { ...edit, saving: true } });
    const saved = await useApp
      .getState()
      .changeSlideMarkup(slide, (markup) => replaceSvgInSlide(markup, path, original, draft));
    const now = get().edit;
    if (now) set({ edit: { ...now, saving: false, original: saved ? draft : now.original } });
    return saved;
  },

  close: async () => {
    if (isDirty(get().edit) && !(await confirmLeave())) return false;
    set({ edit: null });
    useApp.getState().setSidebarMaximized(false);
    useApp.getState().closeSidebarTab("svg");
    return true;
  },
}));
