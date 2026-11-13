import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useContentSize } from "../hooks/useContentSize";
import { api, type Deck, type Slide } from "../lib/api";
import { type Pixels, pixelsOf } from "../lib/slideSize";
import { showError, useApp } from "../store";
import { Dialog } from "./Dialog";
import { SlideFrame, useSlideVersion } from "./SlideFrame";

/** Wait after a slide loads before capturing it, for web fonts and images to paint. */
export const SETTLE_MS = 400;

const NO_AREA = { width: 0, height: 0 };

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
  const area = useContentSize(areaRef) ?? NO_AREA;
  const canvas = pixelsOf(deck);
  // The slide as large as the window allows, in its own shape.
  const width = Math.max(0, Math.min(area.width, (area.height * canvas.width) / canvas.height));
  const stopped = useRef(false);
  const captured = useRef(-1);
  const total = slides.length;
  const slide = deck.slides.find((s) => s.id === slides[index]);

  const cancel = () => {
    stopped.current = true;
    useApp.getState().endImageExport();
  };

  useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: advance only when the slide disappears
  useEffect(() => {
    if (!slide) next();
  }, [slide]);

  const capture = async () => {
    if (captured.current === index || !slideRef.current) return;
    captured.current = index;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    if (stopped.current || !slideRef.current) return;
    const { x, y, width: w, height: h } = slideRef.current.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    try {
      await api.exportSlideImage(dir, index, total, { x, y, width: w, height: h }, viewport, canvas.width);
    } catch (error) {
      showError(error, `Could not save slide ${index + 1} as an image: `);
      useApp.getState().endImageExport();
      return;
    }
    if (!stopped.current) next();
  };

  return (
    // Escape cancels, as the button does.
    <Dialog
      label="Saving slide images"
      onClose={cancel}
      className="dark fixed inset-0 flex flex-col bg-background text-foreground outline-none"
    >
      <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center p-6">
        {slide && (
          <div ref={slideRef} style={{ width }}>
            <ExportSlide
              key={`${index}:${slide.id}`}
              deckId={deck.id}
              slide={slide}
              size={canvas}
              onReady={() => void capture()}
            />
          </div>
        )}
      </div>
      <div className="flex h-12 shrink-0 items-center justify-center gap-3 text-sm text-foreground/80">
        <Loader2 className="size-4 shrink-0 animate-spin will-change-transform" />
        <span className="tabular-nums" style={{ minWidth: `${14 + 2 * String(total).length}ch` }}>
          Saving slide {Math.min(index + 1, total)} of {total}…
        </span>
        <button
          type="button"
          onClick={cancel}
          className="rounded-md border border-foreground/20 px-2.5 py-1 text-xs font-medium hover:bg-foreground/10"
        >
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

function ExportSlide({
  deckId,
  slide,
  size,
  onReady,
}: {
  deckId: string;
  slide: Slide;
  size: Pixels;
  onReady: () => void;
}) {
  return (
    <SlideFrame
      deckId={deckId}
      slideId={slide.id}
      version={useSlideVersion(slide)}
      size={size}
      thumbnail
      onFrameReady={onReady}
    />
  );
}
