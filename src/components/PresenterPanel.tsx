import { RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Deck, Slide } from "../lib/api";
import { pixelsOf } from "../lib/slideSize";
import { cn } from "../lib/utils";
import { SlideFrame, useSlideVersion } from "./SlideFrame";

/** Time since the show started, like `4:07` or `1:04:07`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  const clock = `${minutes % 60}:${pad(seconds % 60)}`;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${minutes % 60 < 10 ? "0" : ""}${clock}` : clock;
}

const BUDGET_KEY = "slopslide.presenterBudget";

/** The times the presenter sets for themselves, in minutes; 0 is none. */
export interface Budget {
  total: number;
  perSlide: number;
}

export function loadBudget(): Budget {
  try {
    const saved = JSON.parse(localStorage.getItem(BUDGET_KEY) ?? "{}");
    const minutes = (value: unknown) => (typeof value === "number" && value > 0 && value < 1000 ? value : 0);
    return { total: minutes(saved.total), perSlide: minutes(saved.perSlide) };
  } catch {
    return { total: 0, perSlide: 0 };
  }
}

/** Time left of `minutes` after `elapsedMs`, like `12:30`, or `+1:05` once over; and whether it's over. */
export function remaining(elapsedMs: number, minutes: number): { text: string; over: boolean } {
  const left = minutes * 60_000 - elapsedMs;
  const over = left < 0;
  // Counts seconds up (rounding the other way) once over, so the display never sticks at 0:00.
  const text = formatElapsed(over ? -left : Math.ceil(left / 1000) * 1000);
  return { text: over ? `+${text}` : text, over };
}

/**
 * The presenter's side of the show: time since the show started (against the total time the
 * presenter set, if any), the time on this slide (against the time per slide), the speaker
 * notes of the slide on screen and the next slide to be shown. Beside the slide it is a narrow
 * column; in a window of its own (`window`, on a second screen) it also shows the slide itself.
 */
export function PresenterPanel(props: {
  deck: Deck;
  /** The slide on screen. */
  slide: string | null;
  startedAt: number;
  onRestart: () => void;
  onClose?: () => void;
  window?: boolean;
}) {
  const { deck, slide: id, startedAt } = props;
  const shown = deck.slides.filter((s) => !s.hidden);
  const index = deck.slides.findIndex((s) => s.id === id);
  const slide = deck.slides[index];
  const next = deck.slides.slice(index + 1).find((s) => !s.hidden);
  const [budget, setBudget] = useState(loadBudget);
  const [slideStartedAt, setSlideStartedAt] = useState(() => Date.now());
  // Each slide's time starts when it comes on screen, and starts over with the show's timer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` and `startedAt` are the triggers.
  useEffect(() => setSlideStartedAt(Date.now()), [id, startedAt]);
  const update = (change: Partial<Budget>) => {
    const next = { ...budget, ...change };
    setBudget(next);
    localStorage.setItem(BUDGET_KEY, JSON.stringify(next));
  };
  return (
    <aside
      aria-label="Presenter view"
      className={cn(
        "flex shrink-0 flex-col gap-3 bg-neutral-950 p-3 text-white",
        props.window ? "size-full p-5" : "w-96 max-w-[40%] border-l border-white/10",
      )}
    >
      <div className="flex items-center gap-1">
        <ElapsedTime startedAt={startedAt} budget={budget} slideStartedAt={slideStartedAt} />
        <span className="ml-2 text-xs text-white/60 tabular-nums">
          {slide && !slide.hidden ? `Slide ${shown.indexOf(slide) + 1} of ${shown.length}` : "Hidden slide"}
        </span>
        <span className="flex-1" />
        <PanelButton label="Restart the timer" onClick={props.onRestart}>
          <RotateCcw />
        </PanelButton>
        {props.onClose && (
          <PanelButton label="Close presenter view (N)" onClick={props.onClose}>
            <X />
          </PanelButton>
        )}
      </div>
      <div className="flex shrink-0 gap-3 text-xs text-white/60">
        <BudgetInput label="Total time" value={budget.total} onChange={(total) => update({ total })} />
        <BudgetInput label="Per slide" value={budget.perSlide} onChange={(perSlide) => update({ perSlide })} />
      </div>
      {props.window && slide && (
        <div className="flex min-h-0 flex-[2] items-start gap-3">
          <div className="flex min-h-0 min-w-0 flex-[2] flex-col gap-1">
            <span className="text-xs text-white/60">Now</span>
            <NextSlide deck={deck} slide={slide} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs text-white/60">Next</span>
            {next ? (
              <NextSlide deck={deck} slide={next} />
            ) : (
              <p className="rounded-lg bg-white/5 p-3 text-sm text-white/40">The end of the show.</p>
            )}
          </div>
        </div>
      )}
      <div
        data-testid="presenter-notes"
        className={cn(
          "min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white/5 p-3 leading-relaxed",
          props.window ? "text-2xl" : "text-base",
        )}
      >
        {slide?.notes || <span className="text-white/40">No notes for this slide.</span>}
      </div>
      {!props.window && (
        <div className="flex shrink-0 flex-col gap-1">
          <span className="text-xs text-white/60">Next</span>
          {next ? (
            <NextSlide deck={deck} slide={next} />
          ) : (
            <p className="rounded-lg bg-white/5 p-3 text-sm text-white/40">The end of the show.</p>
          )}
        </div>
      )}
    </aside>
  );
}

function BudgetInput(props: { label: string; value: number; onChange: (minutes: number) => void }) {
  return (
    <label className="flex items-center gap-1.5">
      {props.label}
      <input
        type="number"
        min={0}
        step={0.5}
        placeholder="min"
        aria-label={`${props.label} in minutes`}
        value={props.value || ""}
        onChange={(event) => props.onChange(Math.max(0, Number(event.target.value) || 0))}
        // Typing here must not move the slides.
        onKeyDown={(event) => event.stopPropagation()}
        className="w-14 rounded-md border border-white/15 bg-white/5 px-1.5 py-0.5 text-white tabular-nums outline-none focus:border-white/40"
      />
    </label>
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

function ElapsedTime(props: { startedAt: number; slideStartedAt: number; budget: Budget }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = now - props.startedAt;
  const onSlide = now - props.slideStartedAt;
  const total = props.budget.total > 0 ? remaining(elapsed, props.budget.total) : null;
  const slide = props.budget.perSlide > 0 ? remaining(onSlide, props.budget.perSlide) : null;
  return (
    <div className="flex items-baseline gap-3">
      <span role="timer" aria-label="Elapsed time" className="text-2xl font-medium tabular-nums">
        {formatElapsed(elapsed)}
      </span>
      {total && (
        <span
          data-testid="total-left"
          className={cn("text-sm tabular-nums", total.over ? "text-red-400" : "text-white/70")}
        >
          {total.over ? `${total.text} over` : `${total.text} left`}
        </span>
      )}
      <span data-testid="slide-time" className="text-sm text-white/70 tabular-nums">
        <span className="mr-1 text-white/40">slide</span>
        <span className={slide?.over ? "text-red-400" : undefined}>{formatElapsed(onSlide)}</span>
        {slide && <span className="text-white/40"> / {formatElapsed(props.budget.perSlide * 60_000)}</span>}
      </span>
    </div>
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
