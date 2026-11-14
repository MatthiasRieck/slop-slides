import {
  AArrowDown,
  AArrowUp,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  Keyboard,
  LayoutGrid,
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
import { typedGoal } from "./presenter/showSlides";
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
import type { Blank } from "./presenter/usePresenterFeed";
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
  /** What blanks the audience's screen, if anything, and blanking it or bringing the slide back. */
  blank: Blank;
  setBlank: (color: Blank) => void;
  /** The slide number being typed, if one is. */
  typed: string;
  end: () => void;
}

/** The notes (or script) box of the presenter view on screen, for the keys that scroll it. */
const NOTES = "[data-presenter-notes]";

/** Scrolls the presenter view's notes most of a box's height down (1) or up (-1); false without them. */
export function scrollNotes(by: 1 | -1): boolean {
  const notes = document.querySelector<HTMLElement>(NOTES);
  if (!notes) return false;
  notes.scrollBy({ top: by * notes.clientHeight * 0.8, behavior: "smooth" });
  return true;
}

/**
 * The presenter's side of the show, in three groups. The timer: time since the show started
 * (against the total time the presenter set, if any, amber as it runs short and red once over),
 * the time on this slide (against the time per slide), with Start or Pause beside it and its
 * settings (and Restart) behind a button; and the time of day. The slides: which slide is on
 * screen, numbered as the slide list numbers it, which opens all of them to go to one. Narration:
 * the teleprompter and the record buttons. Then the speaker notes of the slide on screen, with
 * their size beside them ([ and ] scroll them), and the next slide to be shown, which a press goes
 * to. Beside the slide it is a narrow column; in a window of its own (`window`, on a second
 * screen) it also shows the slide itself (covered while the audience's screen is blank), and has
 * a row that operates the show (`remote`). There, the next slide's picture is the one that shows
 * the slide once the show moves on to it (see `ShowSlide`), so going on loads one page, not two.
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
  /** Whether the show is past its last slide, on its end screen. */
  ended?: boolean;
  /** Moves the show on to the next slide. */
  onNext: () => void;
  /** Opens all the slides, to go to one. */
  onOverview?: () => void;
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
  // The one after it, loaded out of sight: moving on, its picture is there at once.
  const afterNext = next && deck.slides.slice(deck.slides.indexOf(next) + 1).find((s) => !s.hidden);
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
  // Audio counts down before the microphone is on; pressing its button meanwhile calls it off.
  const counting = recorder.phase === "countdown";
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
  const where = props.ended
    ? "End of show"
    : slide && !slide.hidden
      ? `Slide ${index + 1} of ${deck.slides.length}`
      : "Hidden slide";
  return (
    <aside
      aria-label="Presenter view"
      className={cn(
        "dark flex shrink-0 flex-col gap-3 bg-background p-3 text-foreground",
        props.window ? "size-full p-5" : "w-96 max-w-[40%] border-l border-foreground/10",
      )}
    >
      <div className="flex items-start gap-2">
        <fieldset aria-label="Timer" className="flex min-w-0 flex-1">
          <ElapsedTime timer={timer} budget={times}>
            <PanelButton
              label={!timer.started ? "Start the timer now" : timer.paused ? "Resume the timer" : "Pause the timer"}
              onClick={timer.toggle}
            >
              {!timer.started || timer.paused ? <Play /> : <Pause />}
            </PanelButton>
            <TimerSettings
              budget={budget}
              sources={budgetSources(budget, shown, slide)}
              onChange={update}
              onRestart={timer.restart}
            />
          </ElapsedTime>
        </fieldset>
        <WallClock />
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
      {props.remote ? (
        <RemoteRow
          deck={deck}
          remote={props.remote}
          where={where}
          onNext={props.onNext}
          onOverview={props.onOverview}
        />
      ) : (
        <fieldset aria-label="Slides" className="flex min-w-0 items-center gap-2">
          <GroupLabel>Slides</GroupLabel>
          <SlideCount where={where} onOverview={props.onOverview} />
        </fieldset>
      )}
      <fieldset aria-label="Narration" className="flex min-w-0 flex-wrap items-center gap-1">
        <GroupLabel>Narration</GroupLabel>
        <PanelButton
          label={following ? "Stop the teleprompter" : "Teleprompter: follow what you say through the script"}
          text="Teleprompter"
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
          text={recordingText ? "Stop" : "Record text"}
          active={recordingText}
          tone="recording"
          disabledReason={recordBlocked(recordingAudio || counting)}
          onClick={() => void recorder.toggle("text")}
        >
          {busyRecording && recorder.mode === "text" ? (
            <Loader2 className="animate-spin" />
          ) : recordingText ? (
            <Square className="fill-current" />
          ) : (
            <FileText />
          )}
        </PanelButton>
        <PanelButton
          label={
            recordingAudio
              ? "Stop recording the audio"
              : counting
                ? "Call off the recording"
                : "Record the narration as audio: your voice becomes the narration of each slide you speak over, in place of an earlier recording of it"
          }
          text={recordingAudio ? "Stop" : counting ? `Starts in ${recorder.count}` : "Record audio"}
          active={recordingAudio || counting}
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
      </fieldset>
      {props.window && slide && (
        <div className="relative flex min-h-0 flex-[2] gap-3">
          {/* By slide: the picture that was Next stays, and becomes Now, as the show moves on to it;
              the one after it waits, loaded and out of sight, to become Next. */}
          <ShowSlide key={slide.id} label="Now" deck={deck} slide={slide} blank={props.remote?.blank ?? null} />
          {next && <ShowSlide key={next.id} label="Next" deck={deck} slide={next} onPress={props.onNext} />}
          {afterNext && <ShowSlide key={afterNext.id} label="Next" deck={deck} slide={afterNext} waiting />}
          {!next && (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs text-foreground/60">Next</span>
              <TheEnd />
            </div>
          )}
        </div>
      )}
      <TeleprompterNotice teleprompter={teleprompter} />
      <TeleprompterNotice
        teleprompter={recorder}
        purpose="What you say is transcribed on this computer with Whisper."
      />
      <RecordingStatus recorder={recorder} locked={!!slide?.locked} />
      <fieldset aria-label="Notes" className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1">
          <GroupLabel>{following || recording ? "Script" : "Notes"}</GroupLabel>
          <span className="flex-1" />
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
        </div>
        {following && script ? (
          <div data-presenter-notes className="flex min-h-0 flex-1 flex-col">
            <FollowedScript key={`${id}:${script}`} text={script} className={notesClass} />
          </div>
        ) : (
          <div data-testid="presenter-notes" data-presenter-notes className={notesClass}>
            {script ? (
              <ScriptMarkdown text={script} />
            ) : (
              <span className="text-foreground/40">
                {recordingText ? "What you say over this slide shows up here." : "No notes for this slide."}
              </span>
            )}
          </div>
        )}
      </fieldset>
      {!props.window && (
        <div className="flex shrink-0 flex-col gap-1">
          <span className="text-xs text-foreground/60">Next</span>
          {/* By slide, as in the window: the one after Next waits, loaded and out of sight, to become Next. */}
          <div className="relative">
            {next && <SlidePicture key={next.id} deck={deck} slide={next} onPress={props.onNext} />}
            {afterNext && <SlidePicture key={afterNext.id} deck={deck} slide={afterNext} waiting />}
            {!next && <TheEnd />}
          </div>
        </div>
      )}
    </aside>
  );
}

/** The name of a group of the presenter view's controls. */
function GroupLabel({ children }: { children: ReactNode }) {
  return <span className="mr-1 text-2xs font-medium uppercase tracking-wide text-foreground/50">{children}</span>;
}

/** Which slide is on screen (`where`), pressed to see all of them and go to one. */
function SlideCount({ where, onOverview }: { where: string; onOverview?: () => void }) {
  if (!onOverview) return <span className="text-xs text-foreground/70 tabular-nums">{where}</span>;
  return (
    <button
      type="button"
      data-testid="panel-position"
      title="All slides (G)"
      // Keep keyboard focus where it was, so Space still advances the slide.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOverview}
      className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-foreground/80 tabular-nums hover:bg-foreground/10 hover:text-foreground [&_svg]:size-3.5"
    >
      <LayoutGrid />
      {where}
    </button>
  );
}

function TheEnd() {
  return <p className="rounded-lg bg-foreground/5 p-3 text-sm text-foreground/40">The end of the show.</p>;
}

/**
 * Over the next slide's picture, all of it a button: pressing it moves the show on to that slide.
 * It lies over the picture rather than around it, so the picture is the same thing with it and
 * without (see `ShowSlide`).
 */
function NextSlide(props: { onPress: () => void }) {
  return (
    <button
      type="button"
      aria-label="Go to the next slide"
      title="Go to the next slide (→)"
      // Keep keyboard focus where it was, so Space still advances the slide.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onPress}
      className="absolute inset-0 rounded-lg ring-foreground/40 hover:ring-2 focus-visible:ring-2"
    />
  );
}

/**
 * The show's controls, with their names, as the show's bar is on the audience's screen: previous,
 * which slide is on screen (all slides, to go to one), next, blanking the audience's screen,
 * Play and End show; and the slide number being typed, until Enter goes there.
 */
function RemoteRow(props: {
  deck: Deck;
  remote: ShowRemote;
  where: string;
  onNext: () => void;
  onOverview?: () => void;
}) {
  const { remote } = props;
  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      <div role="toolbar" aria-label="Show controls" className="flex flex-wrap items-center gap-1.5">
        <RemoteButton label="Previous" title="Previous slide (←)" onClick={remote.previous}>
          <ChevronLeft />
        </RemoteButton>
        <SlideCount where={props.where} onOverview={props.onOverview} />
        <RemoteButton label="Next" title="Next slide (→)" onClick={props.onNext}>
          <ChevronRight />
        </RemoteButton>
        <RemoteButton
          label={remote.blank ? "Show the slide" : "Black screen"}
          title={remote.blank ? "Bring the slide back to the audience (B)" : "Blank the audience's screen to black (B)"}
          active={remote.blank !== null}
          onClick={() => remote.setBlank(remote.blank ? null : "black")}
        >
          {remote.blank ? <Eye /> : <EyeOff />}
        </RemoteButton>
        <RemoteButton
          label={remote.playing ? "Pause" : "Play"}
          title={remote.playing ? "Pause (K)" : "Play: move on by itself, speaking any narration (K)"}
          active={remote.playing}
          onClick={remote.togglePlay}
        >
          {remote.playing ? <Pause /> : <Play />}
        </RemoteButton>
        <span className="flex-1" />
        <RemoteButton label="End show" title="End show (Esc)" onClick={remote.end}>
          <X />
        </RemoteButton>
      </div>
      {remote.typed && (
        <p role="status" data-testid="typed-slide" className="text-sm text-foreground/80">
          {typedGoal(props.deck, remote.typed)} ↵
        </p>
      )}
    </div>
  );
}

function RemoteButton(props: {
  label: string;
  title: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={props.title}
      aria-pressed={props.active}
      // Keep keyboard focus where it was, so Space still advances the slide.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-lg border border-foreground/15 px-3 text-sm hover:bg-foreground/10 hover:text-foreground [&_svg]:size-4",
        props.active ? "bg-foreground/15 text-foreground" : "text-foreground/80",
      )}
    >
      {props.children}
      {props.label}
    </button>
  );
}

/**
 * The times the presenter counts down against, behind a button: they are set once, not watched.
 * An empty field says what is counted down instead, when the slides' own times are. Restarting
 * the clocks is here too, a step away from Pause, as it cannot be taken back.
 */
function TimerSettings(props: {
  budget: Budget;
  sources: { total: string | null; perSlide: string | null };
  onChange: (change: Partial<Budget>) => void;
  /** Starts the show's clocks over, from now. */
  onRestart: () => void;
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
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                props.onRestart();
                setOpen(false);
              }}
              className="flex h-7 items-center gap-1.5 self-start rounded-lg border border-foreground/15 px-2 text-foreground/80 hover:bg-foreground/10 hover:text-foreground [&_svg]:size-3.5"
            >
              <RotateCcw />
              Restart the timer
            </button>
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

/**
 * A slide of the show in the presenter view's window, under its `label`: the one on screen, large,
 * or the next one (with `onPress`, which goes to it), smaller beside it. The two are told apart by
 * their slide, not their place, so when the show moves on, the next slide's picture stays what
 * it is, page and all, and only grows into the place of the one on screen.
 */
function ShowSlide(props: {
  label: string;
  deck: Deck;
  slide: Slide;
  blank?: Blank;
  onPress?: () => void;
  /** It is the slide after Next, loaded where Next is but out of sight (see `WAITING`). */
  waiting?: boolean;
}) {
  return (
    <div
      aria-hidden={props.waiting || undefined}
      inert={props.waiting}
      className={cn(
        "flex min-h-0 min-w-0 flex-col gap-1",
        props.waiting ? `${WAITING} inset-y-0 right-0 w-1/3` : props.onPress ? "flex-1" : "flex-[2]",
      )}
    >
      <span className="text-xs text-foreground/60">{props.label}</span>
      {/* As large as the room allows, keeping the slide's shape: it never overflows. */}
      <div className="min-h-0 flex-1" style={{ containerType: "size" }}>
        <div
          data-testid="fitted-slide"
          className="relative"
          style={{ width: fitWidth(pixelsOf({ size: props.deck.size })) }}
        >
          <SlidePicture deck={props.deck} slide={props.slide} onPress={props.onPress} />
          {props.blank && (
            <div
              role="status"
              data-testid="blank-cover"
              className={cn(
                "absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-lg p-3 text-center text-sm",
                props.blank === "black" ? "bg-stage/90 text-paper/80" : "bg-paper/90 text-stage/70",
              )}
            >
              <span className="font-medium">The audience sees a {props.blank} screen</span>
              <span className="text-xs opacity-75">B, or any slide key, brings the slide back</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Where the slide after Next waits: laid out as Next is, so its page is loaded and fitted, but out
 * of sight and out of reach. When the show moves on it becomes Next as it is, page and all, and
 * the next slide's picture shows at once rather than once its page has loaded.
 */
const WAITING = "pointer-events-none invisible absolute";

/**
 * A slide's picture; with `onPress`, pressing it moves the show on to that slide. `waiting`, it
 * is the slide after Next, out of sight over it (see `WAITING`).
 */
function SlidePicture(props: { deck: Deck; slide: Slide; onPress?: () => void; waiting?: boolean }) {
  const { deck, slide, onPress } = props;
  const version = useSlideVersion(slide);
  return (
    <div
      aria-hidden={props.waiting || undefined}
      inert={props.waiting}
      className={props.waiting ? `${WAITING} inset-x-0 top-0` : "relative"}
    >
      <SlideFrame
        deckId={deck.id}
        slideId={slide.id}
        version={version}
        size={pixelsOf({ size: deck.size })}
        thumbnail
        className="overflow-hidden rounded-lg"
      />
      {onPress && <NextSlide onPress={onPress} />}
    </div>
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

/** The color of a time counted down: amber as it runs short, red once over. */
function countdownClass(left: { over: boolean; low: boolean } | null): string | undefined {
  if (left?.over) return "text-destructive";
  if (left?.low) return "text-warning";
  return undefined;
}

/**
 * The show's time, large, with its controls (`children`) beside it; under it whether it waits or
 * is paused, the time left of the total and the time on the slide.
 */
function ElapsedTime(props: { timer: ShowTimer; budget: Budget; children: ReactNode }) {
  const now = useNow();
  const { timer } = props;
  const elapsed = watchTime(timer.show, now);
  const onSlide = watchTime(timer.slide, now);
  const total = props.budget.total > 0 ? remaining(elapsed, props.budget.total) : null;
  const slide = props.budget.perSlide > 0 ? remaining(onSlide, props.budget.perSlide) : null;
  const resting = timer.paused || !timer.started;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex items-center gap-1">
        <span
          role="timer"
          aria-label="Elapsed time"
          className={cn("mr-1 text-2xl font-medium tabular-nums", resting && "text-foreground/50")}
        >
          {formatElapsed(elapsed)}
        </span>
        {props.children}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 text-sm tabular-nums">
        {!timer.started && (
          <span data-testid="timer-waiting" className="text-xs text-foreground/50">
            Starts on the first advance
          </span>
        )}
        {timer.paused && (
          <span data-testid="timer-paused" className="text-xs uppercase tracking-wide text-foreground/50">
            Paused
          </span>
        )}
        {total && (
          <span
            data-testid="total-left"
            data-state={total.over ? "over" : total.low ? "low" : undefined}
            className={countdownClass(total) ?? "text-foreground/70"}
          >
            {total.over ? `${total.text} over` : `${total.text} left`}
          </span>
        )}
        <span data-testid="slide-time" className="text-foreground/70">
          <span className="mr-1 text-foreground/40">slide</span>
          <span data-state={slide?.over ? "over" : slide?.low ? "low" : undefined} className={countdownClass(slide)}>
            {formatElapsed(onSlide)}
          </span>
          {slide && <span className="text-foreground/40"> / {formatElapsed(props.budget.perSlide * 60_000)}</span>}
        </span>
      </div>
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
