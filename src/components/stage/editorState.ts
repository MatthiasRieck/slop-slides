import { create } from "zustand";

import type { EditGeometry, EditLayer } from "../../lib/arrange";
import { sameColors, sameFonts, sameGeometry, sameLayers, sameSelection, sameTexts } from "../../lib/editReports";
import type { DeckColor, EditMenuTarget, EditSelection, FontChoice } from "../../lib/editTools";
import { editingSlide, useApp } from "../../store";

/** What the slide editor reports about the slide it is at work on. */
export interface SlideReport {
  /** What is selected, as the toolbar shows it. */
  selection: EditSelection | null;
  /** Where the selection is, for the arrange controls. */
  geometry: EditGeometry | null;
  /** What is on the slide, the top-most first, for the Layers panel. */
  layers: EditLayer[];
  /** What runs past the slide or is cut off. */
  overflow: string[];
}

/** The menu a right-click in the editor opened, in the app's pixels; `at` is the same point in the preview's. */
export type EditorMenu = EditMenuTarget & { x: number; y: number; at: { x: number; y: number } };

/** How the editor's handles change a size: the box, or its contents with it. */
export type SizeMode = "resize" | "stretch";

interface EditorState {
  /** The slide `report` is about; null before the editor has said anything. */
  slide: string | null;
  report: SlideReport;
  /** The fonts the deck's styles use, for the toolbar's font list. */
  fonts: FontChoice[];
  /** The colors in the deck's CSS variables. */
  colors: DeckColor[];
  /** The current slide's background color. */
  background: string | null;
  menu: EditorMenu | null;
  sizeMode: SizeMode;
  /** Resizes keep the aspect ratio. */
  keepRatio: boolean;
}

const NO_REPORT: SlideReport = { selection: null, geometry: null, layers: [], overflow: [] };

const NOTHING: EditorState = {
  slide: null,
  report: NO_REPORT,
  fonts: [],
  colors: [],
  background: null,
  menu: null,
  sizeMode: "resize",
  keepRatio: false,
};

/**
 * What the slide editor in the stage's preview (src-tauri/assets/editor/) says about itself, and
 * how the app has set it up. It is a store of its own, outside the stage's state: the editor
 * reports on every keystroke and every frame of a drag, and each control of the toolbar reads
 * only what it shows (see `useSlideReport`), so a report renders that control and nothing else,
 * and one that says what the last one said (see ../../lib/editReports.ts) renders nothing.
 */
export const useEditorState = create<EditorState>(() => NOTHING);

const SAME: { [K in keyof SlideReport]: (a: SlideReport[K], b: SlideReport[K]) => boolean } = {
  selection: sameSelection,
  geometry: sameGeometry,
  layers: sameLayers,
  overflow: sameTexts,
};

/** Takes what the editor reports about `slide`; what it said about another slide is forgotten. */
export function reportFromEditor<K extends keyof SlideReport>(slide: string, about: K, value: SlideReport[K]) {
  useEditorState.setState((s) => {
    const was = s.slide === slide ? s.report : NO_REPORT;
    if (was === s.report && SAME[about](was[about], value)) return s;
    return { slide, report: { ...was, [about]: value } };
  });
}

/** Takes what the editor reports about the deck's look: its fonts, its colors, the slide's background. */
export function reportDeckLook(look: { fonts?: FontChoice[]; colors?: DeckColor[]; background?: string | null }) {
  useEditorState.setState((s) => {
    const fonts = look.fonts && !sameFonts(s.fonts, look.fonts) ? look.fonts : s.fonts;
    const colors = look.colors && !sameColors(s.colors, look.colors) ? look.colors : s.colors;
    const background = look.background === undefined ? s.background : look.background;
    return fonts === s.fonts && colors === s.colors && background === s.background ? s : { fonts, colors, background };
  });
}

/** A fresh editor has nothing selected and no menu open; it reports a selection it restores itself. */
export function editorRestarted() {
  useEditorState.setState((s) => {
    const { selection, geometry } = s.report;
    if (!selection && !geometry && !s.menu) return s;
    return { report: { ...s.report, selection: null, geometry: null }, menu: null };
  });
}

/** Opens the editor's context menu, or with null, closes it. */
export function setEditorMenu(menu: EditorMenu | null) {
  useEditorState.setState((s) => (s.menu === menu ? s : { menu }));
}

/** Forgets everything the editor said, as when the stage goes away. */
export function resetEditorState() {
  useEditorState.setState(NOTHING);
}

/** The slide the editor is at work on, as the app has it: the selected one in edit mode, unless it is locked. */
const editedSlide = (app: Parameters<typeof editingSlide>[0]) => (editingSlide(app) ? app.selected : null);

const reportOn = (state: EditorState, slide: string | null) =>
  slide !== null && state.slide === slide ? state.report : NO_REPORT;

/** What the editor last reported about the slide it is at work on; nothing while it is not, or about another slide. */
export function slideReport(): SlideReport {
  return reportOn(useEditorState.getState(), editedSlide(useApp.getState()));
}

/**
 * Something of what the editor reports about the slide it is at work on (see `slideReport`).
 * The caller renders again only when what `pick` gives changes, so it should pick just what it
 * shows: a count, a flag, or one of the report's own values.
 */
export function useSlideReport<T>(pick: (report: SlideReport) => T): T {
  const slide = useApp(editedSlide);
  return useEditorState((s) => pick(reportOn(s, slide)));
}

/** The editor's context menu, while the editor is at work. */
export function useEditorMenu(): EditorMenu | null {
  const editing = useApp(editingSlide);
  return useEditorState((s) => (editing ? s.menu : null));
}
