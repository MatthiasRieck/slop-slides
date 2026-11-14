import { useCallback, useEffect, useRef } from "react";

import { isMod, keepsKey } from "../../lib/keys";
import { perFrame } from "../../lib/perFrame";
import { editingSlide, useApp } from "../../store";
import { slideReport } from "./editorState";
import type { FrameMessages } from "./messages";
import { type PasteboardView, useStageView } from "./stageView";

export type { PasteboardView };

/** How much one press of a zoom button or key zooms; the pasteboard's own keys step the same. */
export const ZOOM_STEP = 1.25;

/** The zoom levels the zoom menu offers, as the slide's own pixels to the screen's: 1 is 100%. */
export const ZOOM_LEVELS = [0.5, 1, 2];

/** What a zoom key asks of the view. */
export type ZoomKey = "in" | "out" | "fit" | "actual" | "selection";

/**
 * What the keys ask of the view: ⌘+ (or ⌘=, the same key unshifted) zooms in, ⌘- out, and ⌘0
 * or a plain 0 goes back to the whole slide; ⇧0 shows the slide at its real size (100%) and ⇧2
 * zooms to what is selected in Edit, both by their place on the keyboard, whatever they type
 * (⌘1 to ⌘3 are the modes). Null for any other key.
 */
export function zoomKey(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): ZoomKey | null {
  if (event.altKey) return null;
  if (!event.metaKey && !event.ctrlKey && event.shiftKey) {
    // Where Shift types the digit itself, it is the digit.
    if (event.key === "0" || event.key === "2") return event.key === "0" ? "fit" : null;
    if (event.code === "Digit0" || (!event.code && event.key === ")")) return "actual";
    if (event.code === "Digit2" || (!event.code && event.key === "@")) return "selection";
    return null;
  }
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
 * zoom around the middle of the view, or to the selection's box. The preview is also told how far the stage scales it down to
 * fit (`slop:fit`), so what it draws over the slide keeps its size on screen.
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

  // The handles and guides the preview draws are sized for the screen, whatever the stage scales it by.
  useEffect(
    () =>
      useStageView.subscribe((now, before) => {
        if (now.fitScale !== before.fitScale) postFit(frame.current, now.fitScale);
      }),
    [],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || keepsKey(event) || useApp.getState().presenting) return;
      const zoom = zoomKey(event);
      if (!zoom) return;
      if (zoom === "selection") {
        // The selection's box on the slide, as the editor reported it; nothing to zoom to without one.
        const { geometry } = slideReport();
        if (!editingSlide(useApp.getState()) || !geometry) return;
        event.preventDefault();
        send({ box: { x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h } });
        return;
      }
      event.preventDefault();
      if (zoom === "fit") send({ home: true });
      else if (zoom === "actual") send({ actual: true });
      else send({ zoomBy: zoom === "in" ? ZOOM_STEP : 1 / ZOOM_STEP });
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
    /** The preview has loaded, or (`warmed`) one loaded ahead is shown, panned however it was when last shown. */
    onFrameReady: useCallback((loaded: HTMLIFrameElement, warmed = false) => {
      frame.current = loaded;
      const { view, fitScale } = useStageView.getState();
      postFit(loaded, fitScale);
      if (view && view.slide === useApp.getState().selected) {
        loaded.contentWindow?.postMessage({ type: "slop:camera", x: view.x, y: view.y, k: view.k }, "*");
      } else if (warmed) {
        loaded.contentWindow?.postMessage({ type: "slop:camera", home: true }, "*");
      }
    }, []),
  };
}

/** Tells a preview how many screen pixels one of its own takes, once the stage knows. */
function postFit(frame: HTMLIFrameElement | null, scale: number) {
  if (scale > 0) frame?.contentWindow?.postMessage({ type: "slop:fit", scale }, "*");
}
