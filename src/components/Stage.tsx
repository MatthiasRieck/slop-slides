import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useApp } from "../store";
import { SlideFrame, useSlideVersion } from "./SlideFrame";
import type { Slide } from "../lib/api";

/** The current slide, fit to the available space with letterboxing. */
export function Stage() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const areaRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width: w, height: h } = entry.contentRect;
      setWidth(Math.max(0, Math.min(w, (h * 16) / 9)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useSlideKeyboard();

  if (!deck) return null;
  const index = deck.slides.findIndex((s) => s.id === selected);
  const slide = deck.slides[index];

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center p-8">
        {slide ? (
          <div
            style={{ width }}
            className="overflow-hidden rounded-lg shadow-[0_20px_50px_-24px_rgb(0_0_0/0.45)] ring-1 ring-border"
          >
            <CurrentSlide deckId={deck.id} slide={slide} />
          </div>
        ) : (
          <EmptyStage />
        )}
      </div>
      {deck.slides.length > 0 && (
        <div className="flex h-10 shrink-0 items-center justify-center gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => useApp.getState().selectRelative(-1)}
            disabled={index <= 0}
            className="rounded-md p-1 hover:bg-accent hover:text-foreground disabled:opacity-30"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="tabular-nums">
            {index + 1} / {deck.slides.length}
          </span>
          <button
            type="button"
            onClick={() => useApp.getState().selectRelative(1)}
            disabled={index >= deck.slides.length - 1}
            className="rounded-md p-1 hover:bg-accent hover:text-foreground disabled:opacity-30"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function CurrentSlide({ deckId, slide }: { deckId: string; slide: Slide }) {
  return <SlideFrame deckId={deckId} slideId={slide.id} version={useSlideVersion(slide)} />;
}

function EmptyStage() {
  return (
    <div className="flex max-w-sm flex-col items-center gap-3 text-center">
      <div className="rounded-full bg-accent p-3 text-muted-foreground">
        <Sparkles className="size-5" />
      </div>
      <h2 className="text-base font-medium">Start with a conversation</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Tell the agent what the presentation is about, who it is for, and how long it should be.
        Slides appear here as they are written.
      </p>
    </div>
  );
}

/** Arrow keys / PageUp / PageDown move between slides unless the user is typing. */
function useSlideKeyboard() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      if (useApp.getState().presenting) return;
      if (["ArrowDown", "ArrowRight", "PageDown"].includes(event.key)) {
        event.preventDefault();
        useApp.getState().selectRelative(1);
      } else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(event.key)) {
        event.preventDefault();
        useApp.getState().selectRelative(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
