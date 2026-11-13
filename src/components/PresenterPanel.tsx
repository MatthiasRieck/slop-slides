import {
  AArrowDown,
  AArrowUp,
  Captions,
  ChevronLeft,
  ChevronRight,
  Keyboard,
  Loader2,
  Mic,
  Pause,
  Play,
  RotateCcw,
  ScrollText,
  Settings2,
  Square,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { Deck, Slide } from "../lib/api";
import { type Pixels, pixelsOf } from "../lib/slideSize";
import { cn } from "../lib/utils";
import { RecordingStatus } from "./NarrationRecorder";
import { Popover } from "./Popover";
import { loadNotesSize, NOTE_SIZES, saveNotesSize, stepNotesSize } from "./presenter/notesSize";
import {
  type Budget,
  budgetSources,
  formatClock,
  formatElapsed,
  loadBudget,
  plannedBudget,
  remaining,
  saveBudget,
  watchTime,
} from "./presenter/time";
import type { ShowSession } from "./presenter/useShowSession";
import type { ShowTimer } from "./presenter/useShowTimer";
import { ScriptMarkdown } from "./ScriptMarkdown";
import { SlideFrame, useSlideVersion } from "./SlideFrame";
import { FollowedScript, TeleprompterNotice } from "./Teleprompter";

/** What operates the show from the presenter view's own window, where the show's bar is on another screen. */
export interface ShowRemote {
  previous: () => void;
  playing: boolean;
  togglePlay: () => void;
  end: () => void;
}

/**
 * The presenter's side of the show: time since the show started (against the total time the
 * presenter set, if any), the time on this slide (against the time per slide), the time of day,
 * the speaker notes of the slide on screen and the next slide to be shown, which a press goes to.
 * Beside the slide it is a narrow column; in a window of its own (`window`, on a second screen)
 * it also shows the slide itself, names its buttons, and has a row that operates the show
 * (`remote`).
 *
 * The teleprompter listens to the presenter and follows them through the slide's narration, or
 * its notes when it has none, fading what was said (see src/lib/teleprompter.ts). The record
 * buttons take down what the presenter says over each slide, as its narration's text or its
 * narration audio (see `useNarrationRecorder`), while they go through the slides. All of them
 * listen on the one microphone, so one at a time. Red is for recording alone; the teleprompter
 * shows in the primary color. The clocks and the microphone belong to the show (`session`), so
 * they go on while this panel is closed.
 */
export function PresenterPanel(props: {
  deck: Deck;
  /** The slide on screen. */
  slide: string | null;
  session: ShowSession;
  /** Moves the show on to the next slide. */
  onNext: () => void;
  /** Lists the show's keys. */
  onShowKeys?: () => void;
  onClose?: () => void;
  window?: boolean;
  remote?: ShowRemote;
}) {
  const { deck, slide: id, session } = props;
  const { timer, teleprompter, recorder } = session;
  const place = props.window ? "window" : "panel";
  const shown = deck.slides.filter((s) => !s.hidden);
  const index = deck.slides.findIndex((s) => s.id === id);
  const slide = deck.slides[index];
  const next = deck.slides.slice(index + 1).find((s) => !s.hidden);
  const [budget, setBudget] = useState(loadBudget);
  const [notesSize, setNotesSize] = useState(() => loadNotesSize(place));
  const times = plannedBudget(budget, shown, slide);
  const update = (change: Partial<Budget>) => {
    const next = { ...budget, ...change };
    setBudget(next);
    saveBudget(next);
  };
  const resize = (by: 1 | -1) => {
    const size = stepNotesSize(notesSize, by);
    setNotesSize(size);
    saveNotesSize(place, size);
  };
  const following = teleprompter.phase === "following";
  const recording = recorder.phase === "recording";
  const recordingText = recording && recorder.mode === "text";
  const recordingAudio = recording && !recordingText;
  const script =
    following || recordingAudio ? slide?.narration || slide?.notes : recordingText ? slide?.narration : slide?.notes;
  const busyRecording =
    recorder.phase === "starting" || recorder.phase === "downloading" || recorder.phase === "saving";
  const prompting = teleprompter.phase !== "off";
  const notesClass = cn(
    "min-h-0 flex-1 overflow-y-auto rounded-lg bg-foreground/5 p-3 leading-relaxed",
    NOTE_SIZES[notesSize],
  );
  /** Why a record button cannot be pressed now, if it cannot. */
  const recordBlocked = (other: boolean) =>
    prompting
      ? "Stop the teleprompter first"
      : !slide
        ? "No slide is on screen"
        : other
          ? "Stop the other recording first"
          : undefined;
  return (
    <aside
      aria-label="Presenter view"
      className={cn(
        "dark flex shrink-0 flex-col gap-3 bg-background p-3 text-foreground",
        props.window ? "size-full p-5" : "w-96 max-w-[40%] border-l border-foreground/10",
      )}
    >
      <div className="flex items-baseline gap-3">
        <ElapsedTime timer={timer} budget={times} />
        <span className="flex-1" />
        <span className="text-xs text-foreground/60 tabular-nums">
          {slide && !slide.hidden ? `Slide ${shown.indexOf(slide) + 1} of ${shown.length}` : "Hidden slide"}
        </span>
        <WallClock />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <PanelButton
          label={following ? "Stop the teleprompter" : "Teleprompter: follow what you say through the script"}
          text={props.window ? "Teleprompter" : undefined}
          active={following}
          tone="primary"
          disabledReason={recording || busyRecording ? "Stop recording first" : undefined}
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
          text={props.window ? (recordingText ? "Stop" : "Record text") : undefined}
          active={recordingText}
          tone="recording"
          disabledReason={recordBlocked(recordingAudio)}
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
            recordingAudio
              ? "Stop recording the audio"
              : "Record the narration as audio: your voice is added to each slide"
          }
          text={props.window ? (recordingAudio ? "Stop" : "Record audio") : undefined}
          active={recordingAudio}
          tone="recording"
          disabledReason={recordBlocked(recordingText)}
          onClick={() => void recorder.toggle("audio")}
        >
          {busyRecording && recorder.mode === "audio" ? (
            <Loader2 className="animate-spin" />
          ) : recordingAudio ? (
            <Square className="fill-current" />
          ) : (
            <Mic />
          )}
        </PanelButton>
        <span className="flex-1" />
        <PanelButton label={timer.paused ? "Resume the timer" : "Pause the timer"} onClick={timer.toggle}>
          {timer.paused ? <Play /> : <Pause />}
        </PanelButton>
        <PanelButton label="Restart the timer" onClick={timer.restart}>
          <RotateCcw />
        </PanelButton>
        <TimerSettings budget={budget} sources={budgetSources(budget, shown, slide)} onChange={update} />
        <PanelButton
          label="Smaller notes"
          disabledReason={notesSize === 0 ? "The notes are as small as they get" : undefined}
          onClick={() => resize(-1)}
        >
          <AArrowDown />
        </PanelButton>
        <PanelButton
          label="Larger notes"
          disabledReason={notesSize === NOTE_SIZES.length - 1 ? "The notes are as large as they get" : undefined}
          onClick={() => resize(1)}
        >
          <AArrowUp />
        </PanelButton>
        {props.onShowKeys && (
          <PanelButton label="Keys while presenting (?)" onClick={props.onShowKeys}>
            <Keyboard />
          </PanelButton>
        )}
        {props.onClose && (
          <PanelButton label="Close presenter view (N)" onClick={props.onClose}>
            <X />
          </PanelButton>
        )}
      </div>
      {props.remote && <RemoteRow remote={props.remote} onNext={props.onNext} />}
      {props.window && slide && (
        <div className="flex min-h-0 flex-[2] gap-3">
          <div className="flex min-h-0 min-w-0 flex-[2] flex-col gap-1">
            <span className="text-xs text-foreground/60">Now</span>
            <FittedSlide deck={deck} slide={slide} />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs text-foreground/60">Next</span>
            {next ? <FittedSlide deck={deck} slide={next} onPress={props.onNext} /> : <TheEnd />}
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
            <NextSlide onPress={props.onNext}>
              <SlidePreview deck={deck} slide={next} />
            </NextSlide>
          ) : (
            <TheEnd />
          )}
        </div>
      )}
    </aside>
  );
}

function TheEnd() {
  return <p className="rounded-lg bg-foreground/5 p-3 text-sm text-foreground/40">The end of the show.</p>;
}

/** The next slide's picture as a button: pressing it moves the show on to it. */
function NextSlide(props: { onPress: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label="Go to the next slide"
      title="Go to the next slide (→)"
      // Keep keyboard focus where it was, so Space still advances the slide.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onPress}
      className="block w-full rounded-lg text-left ring-foreground/40 hover:ring-2 focus-visible:ring-2"
    >
      {props.children}
    </button>
  );
}

/** Previous, Next, Play and End show, with their names: the show's bar is on the audience's screen. */
function RemoteRow({ remote, onNext }: { remote: ShowRemote; onNext: () => void }) {
  return (
    <div role="toolbar" aria-label="Show controls" className="flex shrink-0 flex-wrap items-center gap-1.5">
      <RemoteButton label="Previous" title="Previous slide (←)" onClick={remote.previous}>
        <ChevronLeft />
      </RemoteButton>
      <RemoteButton label="Next" title="Next slide (→)" onClick={onNext}>
        <ChevronRight />
      </RemoteButton>
      <RemoteButton
        label={remote.playing ? "Pause" : "Play"}
        title={remote.playing ? "Pause" : "Play: speak each slide's narration and move on by itself"}
        onClick={remote.togglePlay}
      >
        {remote.playing ? <Pause /> : <Play />}
      </RemoteButton>
      <span className="flex-1" />
      <RemoteButton label="End show" title="End show (Esc)" onClick={remote.end}>
        <X />
      </RemoteButton>
    </div>
  );
}

function RemoteButton(props: { label: string; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={props.title}
      // Keep keyboard focus where it was, so Space still advances the slide.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
      className="flex h-8 items-center gap-1.5 rounded-lg border border-foreground/15 px-3 text-sm text-foreground/80 hover:bg-foreground/10 hover:text-foreground [&_svg]:size-4"
    >
      {props.children}
      {props.label}
    </button>
  );
}

/**
 * The times the presenter counts down against, behind a button: they are set once, not watched.
 * An empty field says what is counted down instead, when the slides' own times are.
 */
function TimerSettings(props: {
  budget: Budget;
  sources: { total: string | null; perSlide: string | null };
  onChange: (change: Partial<Budget>) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const { budget, sources } = props;
  return (
    <>
      <PanelButton ref={anchor} label="Timer settings" expanded={open} onClick={() => setOpen((o) => !o)}>
        <Settings2 />
      </PanelButton>
      {open && (
        <Popover
          anchor={anchor}
          placement="below"
          align="end"
          width={260}
          label="Timer settings"
          onClose={() => setOpen(false)}
        >
          <div className="flex flex-col gap-2 p-3 text-xs">
            <BudgetInput
              label="Total time"
              value={budget.total}
              source={sources.total}
              onChange={(total) => props.onChange({ total })}
            />
            <BudgetInput
              label="Per slide"
              value={budget.perSlide}
              source={budget.perSlide ? null : sources.perSlide}
              onChange={(perSlide) => props.onChange({ perSlide })}
            />
            <p className="text-foreground/60">
              {budget.perSlide && sources.perSlide
                ? `In minutes. This slide counts down its own time instead: ${sources.perSlide}.`
                : "In minutes. A time planned on a slide (Narration tab) comes before the time per slide; the total of the planned times is counted down when no total is set."}
            </p>
          </div>
        </Popover>
      )}
    </>
  );
}

function BudgetInput(props: {
  label: string;
  value: number;
  /** What is counted down while the field is empty, if anything. */
  source: string | null;
  onChange: (minutes: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      {props.label}
      <input
        type="number"
        min={0}
        step={0.5}
        placeholder={props.source ?? "min"}
        title={props.source ?? undefined}
        aria-label={`${props.label} in minutes`}
        value={props.value || ""}
        onChange={(event) => props.onChange(Math.max(0, Number(event.target.value) || 0))}
        // Typing here must not move the slides.
        onKeyDown={(event) => event.key !== "Escape" && event.stopPropagation()}
        className="w-40 rounded-md border border-foreground/15 bg-foreground/5 px-1.5 py-0.5 text-foreground tabular-nums outline-none focus:border-foreground/40"
      />
    </label>
  );
}

/** How wide a slide of `size` can be to fit in its container (a size container) both ways. */
export function fitWidth(size: Pixels): string {
  return `min(100cqw, ${(100 * size.width) / size.height}cqh)`;
}

/** A slide as large as the room it is given allows, keeping its shape: it never overflows. With `onPress`, a button. */
function FittedSlide({ deck, slide, onPress }: { deck: Deck; slide: Slide; onPress?: () => void }) {
  const preview = <SlidePreview deck={deck} slide={slide} />;
  return (
    <div className="min-h-0 flex-1" style={{ containerType: "size" }}>
      <div data-testid="fitted-slide" style={{ width: fitWidth(pixelsOf({ size: deck.size })) }}>
        {onPress ? <NextSlide onPress={onPress}>{preview}</NextSlide> : preview}
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

/** The time now, counted on every second. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The time of day, for when the talk has to end. */
function WallClock() {
  const now = useNow();
  return (
    <time data-testid="wall-clock" title="The time of day" className="text-xs text-foreground/60 tabular-nums">
      {formatClock(now)}
    </time>
  );
}

function ElapsedTime(props: { timer: ShowTimer; budget: Budget }) {
  const now = useNow();
  const { timer } = props;
  const elapsed = watchTime(timer.show, now);
  const onSlide = watchTime(timer.slide, now);
  const total = props.budget.total > 0 ? remaining(elapsed, props.budget.total) : null;
  const slide = props.budget.perSlide > 0 ? remaining(onSlide, props.budget.perSlide) : null;
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-3", timer.paused && "text-foreground/50")}>
      <span role="timer" aria-label="Elapsed time" className="text-2xl font-medium tabular-nums">
        {formatElapsed(elapsed)}
      </span>
      {timer.paused && (
        <span data-testid="timer-paused" className="text-xs uppercase tracking-wide">
          Paused
        </span>
      )}
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

/** What a pressed-in button of the panel means: the microphone recording (red), or another tool at work. */
type Tone = "recording" | "primary";

const ACTIVE: Record<Tone, string> = {
  recording: "bg-destructive/15 text-destructive",
  primary: "bg-primary/20 text-primary",
};

/**
 * An icon button of the panel's header, with its name beside the icon (`text`) where there is
 * room. Pressed in (`active`), it takes the color of its `tone`. With a `disabledReason` it
 * cannot be pressed, and says why in its tooltip.
 */
function PanelButton(props: {
  ref?: React.Ref<HTMLButtonElement>;
  label: string;
  text?: string;
  active?: boolean;
  tone?: Tone;
  expanded?: boolean;
  disabledReason?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const disabled = props.disabledReason !== undefined;
  return (
    <button
      ref={props.ref}
      type="button"
      title={props.disabledReason ?? props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      aria-expanded={props.expanded}
      disabled={disabled}
      // Keep keyboard focus where it was, so Space still advances the slide.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
      className={cn(
        "flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-lg text-xs enabled:hover:bg-foreground/10 disabled:cursor-default disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0",
        props.text !== undefined && "px-2",
        props.active ? ACTIVE[props.tone ?? "primary"] : "text-foreground/70 enabled:hover:text-foreground",
      )}
    >
      {props.children}
      {props.text}
    </button>
  );
}
