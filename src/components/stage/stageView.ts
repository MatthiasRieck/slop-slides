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
