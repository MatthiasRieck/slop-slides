import { Captions, Loader2, Mic, RotateCcw, ScrollText, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Deck, Slide } from "../lib/api";
import { type Pixels, pixelsOf } from "../lib/slideSize";
import { cn } from "../lib/utils";
import { RecordingStatus, useNarrationRecorder } from "./NarrationRecorder";
import { type Budget, formatElapsed, loadBudget, plannedBudget, remaining, saveBudget } from "./presenter/time";
import { ScriptMarkdown } from "./ScriptMarkdown";
import { SlideFrame, useSlideVersion } from "./SlideFrame";
import { FollowedScript, TeleprompterNotice, useTeleprompter } from "./Teleprompter";

/**
 * The presenter's side of the show: time since the show started (against the total time the
 * presenter set, if any), the time on this slide (against the time per slide), the speaker
 * notes of the slide on screen and the next slide to be shown. Beside the slide it is a narrow
 * column; in a window of its own (`window`, on a second screen) it also shows the slide itself.
 * The teleprompter listens to the presenter and follows them through the slide's narration, or
 * its notes when it has none, fading what was said (see src/lib/teleprompter.ts). The record
 * buttons take down what the presenter says over each slide, as its narration's text or its
 * narration audio (see `useNarrationRecorder`), while they go through the slides. All of them
 * listen on the one microphone, so one at a time.
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
  const times = plannedBudget(budget, shown, slide);
  const update = (change: Partial<Budget>) => {
    const next = { ...budget, ...change };
    setBudget(next);
    saveBudget(next);
  };
  const teleprompter = useTeleprompter();
  const following = teleprompter.phase === "following";
  const recorder = useNarrationRecorder(deck.id, id);
  const recording = recorder.phase === "recording";
  const recordingText = recording && recorder.mode === "text";
  const script =
    following || (recording && !recordingText)
      ? slide?.narration || slide?.notes
      : recordingText
        ? slide?.narration
        : slide?.notes;
  const busyRecording =
    recorder.phase === "starting" || recorder.phase === "downloading" || recorder.phase === "saving";
  const notesClass = cn(
    "min-h-0 flex-1 overflow-y-auto rounded-lg bg-foreground/5 p-3 leading-relaxed",
    props.window ? "text-2xl" : "text-base",
  );
  return (
    <aside
      aria-label="Presenter view"
      className={cn(
        "dark flex shrink-0 flex-col gap-3 bg-background p-3 text-foreground",
        props.window ? "size-full p-5" : "w-96 max-w-[40%] border-l border-foreground/10",
      )}
    >
      <div className="flex items-center gap-1">
        <ElapsedTime startedAt={startedAt} budget={times} slideStartedAt={slideStartedAt} />
        <span className="ml-2 text-xs text-foreground/60 tabular-nums">
          {slide && !slide.hidden ? `Slide ${shown.indexOf(slide) + 1} of ${shown.length}` : "Hidden slide"}
        </span>
        <span className="flex-1" />
        <PanelButton
          label={following ? "Stop the teleprompter" : "Teleprompter: follow what you say through the script"}
          active={following}
          disabled={recording || busyRecording}
          onClick={() => void teleprompter.toggle()}
        >
          {teleprompter.phase === "starting" || teleprompter.phase === "downloading" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <ScrollText />
          )}
        </PanelButton>
        <PanelButton
          label={
            recordingText
              ? "Stop recording the text"
              : "Record the narration as text: what you say is added to each slide"
          }
          active={recordingText}
          disabled={teleprompter.phase !== "off" || !slide || (recording && !recordingText)}
          onClick={() => void recorder.toggle("text")}
        >
          {busyRecording && recorder.mode === "text" ? (
            <Loader2 className="animate-spin" />
          ) : recordingText ? (
            <Square className="fill-current" />
          ) : (
            <Captions />
          )}
        </PanelButton>
        <PanelButton
          label={
            recording && !recordingText
              ? "Stop recording the audio"
              : "Record the narration as audio: your voice is added to each slide"
          }
          active={recording && !recordingText}
          disabled={teleprompter.phase !== "off" || !slide || recordingText}
          onClick={() => void recorder.toggle("audio")}
        >
          {busyRecording && recorder.mode === "audio" ? (
            <Loader2 className="animate-spin" />
          ) : recording && !recordingText ? (
            <Square className="fill-current" />
          ) : (
            <Mic />
          )}
        </PanelButton>
        <PanelButton label="Restart the timer" onClick={props.onRestart}>
          <RotateCcw />
        </PanelButton>
        {props.onClose && (
          <PanelButton label="Close presenter view (N)" onClick={props.onClose}>
            <X />
          </PanelButton>
        )}
      </div>
      <div className="flex shrink-0 gap-3 text-xs text-foreground/60">
        <BudgetInput label="Total time" value={budget.total} onChange={(total) => update({ total })} />
        <BudgetInput label="Per slide" value={budget.perSlide} onChange={(perSlide) => update({ perSlide })} />
      </div>
      {props.window && slide && (
        <div className="flex min-h-0 flex-[2] gap-3">
          <div className="flex min-h-0 min-w-0 flex-[2] flex-col gap-1">
            <span className="text-xs text-foreground/60">Now</span>
            <FittedSlide deck={deck} slide={slide} />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs text-foreground/60">Next</span>
            {next ? (
              <FittedSlide deck={deck} slide={next} />
            ) : (
              <p className="rounded-lg bg-foreground/5 p-3 text-sm text-foreground/40">The end of the show.</p>
            )}
          </div>
        </div>
      )}
      <TeleprompterNotice teleprompter={teleprompter} />
      <TeleprompterNotice
        teleprompter={recorder}
        purpose="What you say is transcribed on this computer with Whisper."
      />
      <RecordingStatus recorder={recorder} locked={!!slide?.locked} />
      {following && script ? (
        <FollowedScript key={`${id}:${script}`} text={script} className={notesClass} />
      ) : (
        <div data-testid="presenter-notes" className={notesClass}>
          {script ? (
            <ScriptMarkdown text={script} />
          ) : (
            <span className="text-foreground/40">
              {recordingText ? "What you say over this slide shows up here." : "No notes for this slide."}
            </span>
          )}
        </div>
      )}
      {!props.window && (
        <div className="flex shrink-0 flex-col gap-1">
          <span className="text-xs text-foreground/60">Next</span>
          {next ? (
            <SlidePreview deck={deck} slide={next} />
          ) : (
            <p className="rounded-lg bg-foreground/5 p-3 text-sm text-foreground/40">The end of the show.</p>
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
        className="w-14 rounded-md border border-foreground/15 bg-foreground/5 px-1.5 py-0.5 text-foreground tabular-nums outline-none focus:border-foreground/40"
      />
    </label>
  );
}

/** How wide a slide of `size` can be to fit in its container (a size container) both ways. */
export function fitWidth(size: Pixels): string {
  return `min(100cqw, ${(100 * size.width) / size.height}cqh)`;
}

/** A slide as large as the room it is given allows, keeping its shape: it never overflows. */
function FittedSlide({ deck, slide }: { deck: Deck; slide: Slide }) {
  return (
    <div className="min-h-0 flex-1" style={{ containerType: "size" }}>
      <div data-testid="fitted-slide" style={{ width: fitWidth(pixelsOf({ size: deck.size })) }}>
        <SlidePreview deck={deck} slide={slide} />
      </div>
    </div>
  );
}

function SlidePreview({ deck, slide }: { deck: Deck; slide: Slide }) {
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
          className={cn("text-sm tabular-nums", total.over ? "text-destructive" : "text-foreground/70")}
        >
          {total.over ? `${total.text} over` : `${total.text} left`}
        </span>
      )}
      <span data-testid="slide-time" className="text-sm text-foreground/70 tabular-nums">
        <span className="mr-1 text-foreground/40">slide</span>
        <span className={slide?.over ? "text-destructive" : undefined}>{formatElapsed(onSlide)}</span>
        {slide && <span className="text-foreground/40"> / {formatElapsed(props.budget.perSlide * 60_000)}</span>}
      </span>
    </div>
  );
}

function PanelButton(props: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      // Keep keyboard focus where it was, so Space still advances the slide.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded-lg hover:bg-foreground/10 disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4",
        props.active ? "bg-destructive/15 text-destructive" : "text-foreground/70 hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}
