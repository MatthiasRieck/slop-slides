import { type RefObject, useEffect, useRef, useState } from "react";

import { zoomBox } from "../../lib/ink";
import { useApp } from "../../store";
import { fromFrameIn } from "./frames";

/** The pasteboard's view: pan in slide pixels and zoom, relative to the slide centered at full size. */
export interface PasteboardView {
  slide: string;
  x: number;
  y: number;
  k: number;
}

/** Puts what lies on the slide (`scale` CSS px per slide px) where the view has it. */
export function inkBox(view: PasteboardView | null, scale: number) {
  return view && scale ? zoomBox(view.x * scale, view.y * scale, view.k) : zoomBox(0, 0, 1);
}

/**
 * Follows how the pasteboard in the stage's preview (src-tauri/assets/pasteboard.js) is panned
 * and zoomed, and puts that view back whenever the slide reloads, in view and in edit mode.
 * Each slide starts centered at full size.
 */
export function usePasteboard(areaRef: RefObject<HTMLDivElement | null>) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [view, setView] = useState<PasteboardView | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type !== "slop:view" || !fromFrameIn(areaRef.current, event.source)) return;
      if (data.slide === useApp.getState().selected && [data.x, data.y, data.k].every(Number.isFinite)) {
        setView({ slide: data.slide, x: data.x, y: data.y, k: data.k });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [areaRef]);

  const current = useApp((s) => s.selected);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different slide starts centered
  useEffect(() => {
    setView(null);
  }, [current]);

  const shown = view?.slide === current ? view : null;
  return {
    /** The view of the current slide, if it has moved; null when centered at full size. */
    current: shown,
    view: shown && !(shown.x === 0 && shown.y === 0 && shown.k === 1) ? shown : null,
    resetView: () => frame.current?.contentWindow?.postMessage({ type: "slop:camera", home: true }, "*"),
    onFrameReady: (loaded: HTMLIFrameElement) => {
      frame.current = loaded;
      if (view && view.slide === useApp.getState().selected) {
        loaded.contentWindow?.postMessage({ type: "slop:camera", x: view.x, y: view.y, k: view.k }, "*");
      }
    },
  };
}
