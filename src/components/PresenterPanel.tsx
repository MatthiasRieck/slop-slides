import { RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { Deck, Slide } from "../lib/api";
import { pixelsOf } from "../lib/slideSize";
import { SlideFrame, useSlideVersion } from "./SlideFrame";

/** Time since the show started, like `4:07` or `1:04:07`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  const clock = `${minutes % 60}:${pad(seconds % 60)}`;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${minutes % 60 < 10 ? "0" : ""}${clock}` : clock;
}

/**
 * The presenter's side of the show, next to the slide: time since the show started, the speaker
 * notes of the slide on screen and the next slide to be shown.
 */
export function PresenterPanel(props: {
  deck: Deck;
  /** The slide on screen. */
  slide: string | null;
  startedAt: number;
  onRestart: () => void;
  onClose: () => void;
}) {
  const { deck, slide: id, startedAt } = props;
  const shown = deck.slides.filter((s) => !s.hidden);
  const index = deck.slides.findIndex((s) => s.id === id);
  const slide = deck.slides[index];
  const next = deck.slides.slice(index + 1).find((s) => !s.hidden);
  return (
    <aside
      aria-label="Presenter view"
      className="flex w-96 max-w-[40%] shrink-0 flex-col gap-3 border-l border-white/10 bg-neutral-950 p-3 text-white"
    >
      <div className="flex items-center gap-1">
        <ElapsedTime startedAt={startedAt} />
        <span className="ml-2 text-xs text-white/60 tabular-nums">
          {slide && !slide.hidden ? `Slide ${shown.indexOf(slide) + 1} of ${shown.length}` : "Hidden slide"}
        </span>
        <span className="flex-1" />
        <PanelButton label="Restart the timer" onClick={props.onRestart}>
          <RotateCcw />
        </PanelButton>
        <PanelButton label="Close presenter view (N)" onClick={props.onClose}>
          <X />
        </PanelButton>
      </div>
      <div
        data-testid="presenter-notes"
        className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white/5 p-3 text-base leading-relaxed"
      >
        {slide?.notes || <span className="text-white/40">No notes for this slide.</span>}
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        <span className="text-xs text-white/60">Next</span>
        {next ? (
          <NextSlide deck={deck} slide={next} />
        ) : (
          <p className="rounded-lg bg-white/5 p-3 text-sm text-white/40">The end of the show.</p>
        )}
      </div>
    </aside>
  );
}

function NextSlide({ deck, slide }: { deck: Deck; slide: Slide }) {
  const version = useSlideVersion(slide);
  return (
    <SlideFrame
      deckId={deck.id}
      slideId={slide.id}
      version={version}
      size={pixelsOf({ size: deck.size })}
      thumbnail
      className="overflow-hidden rounded-lg"
    />
  );
}

function ElapsedTime({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span role="timer" aria-label="Elapsed time" className="text-2xl font-medium tabular-nums">
      {formatElapsed(now - startedAt)}
    </span>
  );
}

function PanelButton(props: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      // Keep keyboard focus where it was, so Space still advances the slide.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
      className="flex size-7 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white [&_svg]:size-4"
    >
      {props.children}
    </button>
  );
}
