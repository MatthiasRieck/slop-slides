import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { api, errorMessage, type Deck, type Slide } from "../lib/api";
import { useApp } from "../store";
import { SlideFrame, useSlideVersion } from "./SlideFrame";

/** Wait after a slide loads before capturing it, for web fonts and images to paint. */
export const SETTLE_MS = 400;

/**
 * Saves every slide as a PNG. Each slide is shown in turn, as large as the window allows,
 * in its final animation state, and screenshotted natively (see src-tauri/src/capture.rs).
 * Covers the editor while it works; when done, reveals the folder.
 */
export function SlideImageExport() {
  const job = useApp((s) => s.imageExport);
  const deck = useApp((s) => s.deck);
  if (!job || !deck) return null;
  return <ExportRun key={job.dir} dir={job.dir} slides={job.slides} deck={deck} />;
}

function ExportRun({ dir, slides, deck }: { dir: string; slides: string[]; deck: Deck }) {
  const [index, setIndex] = useState(0);
  const areaRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const stopped = useRef(false);
  const captured = useRef(-1);
  const total = slides.length;
  const slide = deck.slides.find((s) => s.id === slides[index]);

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

  const cancel = () => {
    stopped.current = true;
    useApp.getState().endImageExport();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    };
    stopped.current = false;
    window.addEventListener("keydown", onKey);
    return () => {
      stopped.current = true;
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const next = () => {
    if (index + 1 < total) {
      setIndex(index + 1);
      return;
    }
    useApp.getState().endImageExport();
    void revealItemInDir(dir).catch(() => {});
  };

  // A slide deleted since the export started has nothing to show.
  useEffect(() => {
    if (!slide) next();
  }, [slide]); // eslint-disable-line react-hooks/exhaustive-deps

  const capture = async () => {
    if (captured.current === index || !slideRef.current) return;
    captured.current = index;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    if (stopped.current || !slideRef.current) return;
    const { x, y, width: w, height: h } = slideRef.current.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    try {
      await api.exportSlideImage(dir, index, total, { x, y, width: w, height: h }, viewport);
    } catch (error) {
      useApp.getState().setError(`Could not save slide ${index + 1} as an image: ${errorMessage(error)}`);
      useApp.getState().endImageExport();
      return;
    }
    if (!stopped.current) next();
  };

  return (
    <div
      role="dialog"
      aria-label="Saving slide images"
      className="fixed inset-0 z-50 flex flex-col bg-neutral-950 text-white"
    >
      <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center p-6">
        {slide && (
          <div ref={slideRef} style={{ width }}>
            <ExportSlide key={`${index}:${slide.id}`} deckId={deck.id} slide={slide} onReady={() => void capture()} />
          </div>
        )}
      </div>
      <div className="flex h-12 shrink-0 items-center justify-center gap-3 text-sm text-white/80">
        <Loader2 className="size-4 shrink-0 animate-spin will-change-transform" />
        <span className="tabular-nums" style={{ minWidth: `${14 + 2 * String(total).length}ch` }}>
          Saving slide {Math.min(index + 1, total)} of {total}…
        </span>
        <button
          type="button"
          onClick={cancel}
          className="rounded-md border border-white/20 px-2.5 py-1 text-xs font-medium hover:bg-white/10"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ExportSlide({ deckId, slide, onReady }: { deckId: string; slide: Slide; onReady: () => void }) {
  return <SlideFrame deckId={deckId} slideId={slide.id} version={useSlideVersion(slide)} thumbnail onFrameReady={onReady} />;
}
