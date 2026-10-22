import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { api, errorMessage, type RemoteCaptureRequest } from "../lib/api";
import type { Stroke } from "../lib/ink";
import { useApp } from "../store";
import { AnnotationLayer, type Annotations } from "./PresenterTools";
import { SETTLE_MS } from "./SlideImageExport";
import { SlideFrame } from "./SlideFrame";

/** Longest wait for a slide to load before the device is told the screenshot failed. */
export const LOAD_TIMEOUT_MS = 10_000;

/**
 * In the window: screenshots slides for devices. A phone or tablet cannot screenshot a slide
 * with its marks (the slide is a cross-origin frame), so the window briefly shows the slide
 * with the marks on top, takes the native screenshot (src-tauri/src/capture.rs) and hands the
 * device the image path (see src-tauri/src/remote.rs).
 */
export function RemoteCapture() {
  const request = useApp((s) => s.remoteCaptures[0]);
  if (!request) return null;
  return <CaptureRun key={request.request} request={request} />;
}

function CaptureRun({ request }: { request: RemoteCaptureRequest }) {
  const areaRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const answered = useRef(false);
  const started = useRef(false);

  const answer = (result: { path: string } | { error: string }) => {
    if (answered.current) return;
    answered.current = true;
    void api
      .remoteCaptureDone(request.request, result)
      .catch(() => {})
      .finally(() => useApp.getState().endRemoteCapture(request.request));
  };

  useLayoutEffect(() => {
    const el = areaRef.current!;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width: w, height: h } = entry.contentRect;
      setWidth(Math.max(0, Math.min(w, (h * 16) / 9)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => answer({ error: "The slide did not load in time." }), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const capture = async () => {
    if (started.current) return;
    started.current = true;
    // Let web fonts and images paint, as for slide images.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    if (answered.current || !slideRef.current) return;
    const { x, y, width: w, height: h } = slideRef.current.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    try {
      answer({ path: await api.captureSketch(request.deckId, { x, y, width: w, height: h }, viewport) });
    } catch (error) {
      answer({ error: errorMessage(error) });
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Taking a screenshot for another device"
      className="fixed inset-0 z-[70] flex flex-col bg-neutral-950 text-white"
    >
      <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div ref={slideRef} style={{ width }} className="relative">
          <SlideFrame
            deckId={request.deckId}
            slideId={request.slide}
            version={request.request}
            thumbnail
            onFrameReady={() => void capture()}
          />
          <AnnotationLayer annotations={staticInk(request.strokes)} />
        </div>
      </div>
      <div className="flex h-12 shrink-0 items-center justify-center text-sm text-white/80">
        Taking a screenshot of the slide for another device…
      </div>
    </div>
  );
}

/** Draws `strokes` and takes no input. */
function staticInk(strokes: Stroke[]): Annotations {
  const none = () => {};
  return {
    tool: "pointer",
    setTool: none,
    colors: { pen: "", highlighter: "" },
    setColor: none,
    strokes,
    addStroke: none,
    erase: none,
    undo: none,
    clear: none,
    handleKey: () => false,
    peek: 0,
  };
}
