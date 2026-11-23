import { type RefObject, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { DarkScope } from "@/lib/darkScope";
import { useContentSize } from "../hooks/useContentSize";
import { api, type Deck, type Slide } from "../lib/api";
import { type Pixels, pixelsOf } from "../lib/slideSize";
import { basename, plural } from "../lib/utils";
import { showError, useApp } from "../store";
import { showSaved } from "./exportSaved";
import { SlideFrame, useSlideVersion } from "./SlideFrame";

/** Wait after a slide loads before capturing it, for web fonts and images to paint. */
export const SETTLE_MS = 400;

const NO_AREA = { width: 0, height: 0 };

/**
 * Saves every slide as a PNG. Each slide is shown in turn, as large as the window allows,
 * in its final animation state, and screenshotted natively (see src-tauri/src/capture.rs).
 * Covers the editor while it works; when done, says so, with a way to the folder.
 */
export function SlideImageExport() {
  const job = useApp((s) => s.imageExport);
  const deck = useApp((s) => s.deck);
  if (!job || !deck) return null;
  return <ExportRun key={job.dir} dir={job.dir} slides={job.slides} deck={deck} />;
}

/** The cover over the whole window an export runs in. Closing it (Escape, Cancel) ends the export. */
function ExportRun(props: { dir: string; slides: string[]; deck: Deck }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <DarkScope>
      <Dialog
        open
        disablePointerDismissal
        onOpenChange={(open) => {
          // Escape cancels, as the button does.
          if (!open) useApp.getState().endImageExport();
        }}
      >
        {/* Always dark, and there at once: nothing of it may still be moving when a slide is captured. */}
        <DialogContent
          aria-label="Saving slide images"
          showCloseButton={false}
          initialFocus={cancelRef}
          className="inset-0 top-0 left-0 flex h-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 text-foreground ring-0 sm:max-w-none data-closed:animate-none data-open:animate-none"
        >
          <ExportStage {...props} cancelRef={cancelRef} />
        </DialogContent>
      </Dialog>
    </DarkScope>
  );
}

/** What the cover shows: the slide being saved, and under it how far the export is. */
function ExportStage({
  dir,
  slides,
  deck,
  cancelRef,
}: {
  dir: string;
  slides: string[];
  deck: Deck;
  cancelRef: RefObject<HTMLButtonElement | null>;
}) {
  const [index, setIndex] = useState(0);
  const areaRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  const area = useContentSize(areaRef) ?? NO_AREA;
  const canvas = pixelsOf(deck);
  // The slide as large as the window allows, in its own shape.
  const width = Math.max(0, Math.min(area.width, (area.height * canvas.width) / canvas.height));
  const stopped = useRef(false);
  const captured = useRef(-1);
  // How many images are saved so far: a slide deleted meanwhile has none.
  const saved = useRef(0);
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
    showSaved(dir, `Saved ${plural(saved.current, "slide image")} in ${basename(dir)}`);
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
    saved.current += 1;
    if (!stopped.current) next();
  };

  return (
    <>
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
        <Spinner aria-hidden="true" className="shrink-0 will-change-transform" />
        <span className="tabular-nums" style={{ minWidth: `${14 + 2 * String(total).length}ch` }}>
          Saving slide {Math.min(index + 1, total)} of {total}…
        </span>
        {/* How many slides are through: the one on show is still being saved. */}
        <Progress aria-label="Slide images saved" value={index} max={total} className="w-32" />
        <Button ref={cancelRef} variant="outline" size="xs" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </>
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
