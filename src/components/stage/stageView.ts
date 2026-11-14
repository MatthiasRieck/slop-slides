import { create } from "zustand";

import { useApp } from "../../store";

/** The pasteboard's view: pan in slide pixels and zoom, relative to the slide centered at full size. */
export interface PasteboardView {
  slide: string;
  x: number;
  y: number;
  k: number;
}

interface StageView {
  /** How the pasteboard last said it is panned and zoomed, and for which slide; null until it has. */
  view: PasteboardView | null;
  /** How many screen pixels one of the slide's takes when the whole slide fits the stage; 0 until it is laid out. */
  fitScale: number;
}

/**
 * How the stage shows its slide: the size it fits at, and how the pasteboard in its preview is
 * panned and zoomed (see `usePasteboard`, which keeps it). It is a store of its own because the
 * view changes with every frame of a pan or a zoom, and only what moves with it reads it: the box
 * the ink lies in, and the zoom level under the slide. The stage around them does not render.
 */
export const useStageView = create<StageView>(() => ({ view: null, fitScale: 0 }));

/**
 * Something of the pasteboard's view of the slide shown, null while it has not moved since the
 * slide was. The caller renders again only when what `pick` gives changes.
 */
export function useShownView<T>(pick: (view: PasteboardView | null) => T): T {
  const slide = useApp((s) => s.selected);
  return useStageView((s) => pick(s.view?.slide === slide ? s.view : null));
}

/** Whether a view is anything but the whole slide in the middle, at the size it fits at. */
export function isMoved(view: PasteboardView): boolean {
  return !(view.x === 0 && view.y === 0 && view.k === 1);
}

interface OverflowPaths {
  /** The slide the paths are of; null until the editor has reported any. */
  slide: string | null;
  /** For each thing the editor found running past the slide, in its order, where the element is: child indexes from the slide down. */
  paths: (number[] | null)[];
}

/**
 * Where the elements are that the slide editor found running past the slide or cut off, beside
 * what it says of them (see `overflow` in ./editorState.ts): the list under the slide selects
 * one with it. A store of its own, read only when a row of that list is pressed.
 */
export const useOverflowPaths = create<OverflowPaths>(() => ({ slide: null, paths: [] }));

const isPath = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((index) => Number.isInteger(index) && index >= 0);

/** Takes the places the editor reported with what overflows on `slide`; what is no place is null. */
export function reportOverflowPaths(slide: string, paths: unknown) {
  useOverflowPaths.setState({ slide, paths: Array.isArray(paths) ? paths.map((p) => (isPath(p) ? p : null)) : [] });
}

/** Where the `index`th overflowing element of `slide` is, if the editor said. */
export function overflowPath(slide: string | null, index: number): number[] | null {
  const known = useOverflowPaths.getState();
  return known.slide === slide ? (known.paths[index] ?? null) : null;
}
