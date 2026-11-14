import { useCallback, useEffect, useRef } from "react";

import { zoomBox } from "../../lib/ink";
import { isMod, keepsKey } from "../../lib/keys";
import { perFrame } from "../../lib/perFrame";
import { useApp } from "../../store";
import type { FrameMessages } from "./messages";
import { type PasteboardView, useStageView } from "./stageView";

export type { PasteboardView };

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
 *
 * The view is kept in `useStageView`, once per animation frame however often the pasteboard
 * reports it, for what moves with the slide to read. What this gives back never changes.
 */
export function usePasteboard(messages: FrameMessages) {
  const frame = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const show = perFrame<PasteboardView>((view) => useStageView.setState({ view }));
    const forget = () => {
      show.cancel();
      if (useStageView.getState().view) useStageView.setState({ view: null });
    };
    const offMessages = messages.on({
      "slop:view": (data) => {
        if (data.slide !== useApp.getState().selected || ![data.x, data.y, data.k].every(Number.isFinite)) return;
        show.push({ slide: data.slide, x: data.x, y: data.y, k: data.k });
      },
    });
    // A different slide starts centered.
    const offSlide = useApp.subscribe((now, before) => {
      if (now.selected !== before.selected) forget();
    });
    return () => {
      offMessages();
      offSlide();
      forget();
    };
  }, [messages]);

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

  return {
    /** Back to the whole slide, centered: the view every slide starts with. */
    resetView: useCallback(() => send({ home: true }), [send]),
    /** Zooms by `factor` around the middle of the view. */
    zoomBy: useCallback((factor: number) => send({ zoomBy: factor }), [send]),
    /** Zooms to `k` times the size the slide fits the stage at, around the middle of the view. */
    zoomTo: useCallback((k: number) => send({ zoomTo: k }), [send]),
    onFrameReady: useCallback((loaded: HTMLIFrameElement) => {
      frame.current = loaded;
      const { view } = useStageView.getState();
      if (view && view.slide === useApp.getState().selected) {
        loaded.contentWindow?.postMessage({ type: "slop:camera", x: view.x, y: view.y, k: view.k }, "*");
      }
    }, []),
  };
}
