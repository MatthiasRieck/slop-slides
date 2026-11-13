import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { zoomBox } from "../../lib/ink";
import { isMod, keepsKey } from "../../lib/keys";
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

/** How much one press of a zoom button or key zooms; the pasteboard's own keys step the same. */
export const ZOOM_STEP = 1.25;

/** The zoom levels the zoom menu offers, as the slide's own pixels to the screen's: 1 is 100%. */
export const ZOOM_LEVELS = [0.5, 1, 2];

/**
 * What the keys ask of the view: ⌘+ (or ⌘=, the same key unshifted) zooms in, ⌘- out, and ⌘0
 * or a plain 0 goes back to the whole slide. Null for any other key.
 */
export function zoomKey(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
): "in" | "out" | "fit" | null {
  if (event.altKey) return null;
  if (!isMod(event)) return event.key === "0" && !event.metaKey && !event.ctrlKey ? "fit" : null;
  if (event.key === "=" || event.key === "+") return "in";
  if (event.key === "-" || event.key === "_") return "out";
  return event.key === "0" ? "fit" : null;
}

/**
 * Follows how the pasteboard in the stage's preview (src-tauri/assets/pasteboard.js) is panned
 * and zoomed, and puts that view back whenever the slide reloads, in view and in edit mode.
 * Each slide starts centered at full size. The zoom buttons under the slide and the zoom keys
 * pressed in the app (see `zoomKey`; the preview has the same keys for when the focus is in it)
 * zoom around the middle of the view.
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

  const send = useCallback((camera: object) => {
    frame.current?.contentWindow?.postMessage({ type: "slop:camera", ...camera }, "*");
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || keepsKey(event) || useApp.getState().presenting) return;
      const zoom = zoomKey(event);
      if (!zoom) return;
      event.preventDefault();
      send(zoom === "fit" ? { home: true } : { zoomBy: zoom === "in" ? ZOOM_STEP : 1 / ZOOM_STEP });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [send]);

  const shown = view?.slide === current ? view : null;
  return {
    /** The view of the current slide, if it has moved; null when centered at full size. */
    current: shown,
    view: shown && !(shown.x === 0 && shown.y === 0 && shown.k === 1) ? shown : null,
    /** Back to the whole slide, centered: the view every slide starts with. */
    resetView: () => send({ home: true }),
    /** Zooms by `factor` around the middle of the view. */
    zoomBy: (factor: number) => send({ zoomBy: factor }),
    /** Zooms to `k` times the size the slide fits the stage at, around the middle of the view. */
    zoomTo: (k: number) => send({ zoomTo: k }),
    onFrameReady: (loaded: HTMLIFrameElement) => {
      frame.current = loaded;
      if (view && view.slide === useApp.getState().selected) {
        loaded.contentWindow?.postMessage({ type: "slop:camera", x: view.x, y: view.y, k: view.k }, "*");
      }
    },
  };
}
