import {
  AArrowDown,
  AArrowUp,
  Captions,
  ChevronLeft,
  ChevronRight,
  Keyboard,
  Mic,
  Pause,
  Play,
  RotateCcw,
  ScrollText,
  Settings2,
  Square,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { ButtonGroup } from "@/components/ui/button-group";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { keepKeys } from "@/hooks/useOverlayLayer";
import { DarkScope } from "@/lib/darkScope";
import type { Deck, Slide } from "../lib/api";
import { type Pixels, pixelsOf } from "../lib/slideSize";
import { cn } from "../lib/utils";
import { RecordingStatus } from "./NarrationRecorder";
import { loadNotesSize, NOTE_SIZES, saveNotesSize, stepNotesSize } from "./presenter/notesSize";
import { ShowButton } from "./presenter/ShowButton";
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
 * (`remote`). There, the next slide's picture is the one that shows the slide once the show
 * moves on to it (see `ShowSlide`), so going on loads one page, not two.
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
    <DarkScope>
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
              <Spinner aria-hidden="true" />
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
              <Spinner aria-hidden="true" />
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
              <Spinner aria-hidden="true" />
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
          <ButtonGroup aria-label="Notes size">
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
          </ButtonGroup>
          {props.onShowKeys && (
            <PanelButton label="Keys while presenting" shortcut="?" onClick={props.onShowKeys}>
              <Keyboard />
            </PanelButton>
          )}
          {props.onClose && (
            <PanelButton label="Close presenter view" shortcut="n" onClick={props.onClose}>
              <X />
            </PanelButton>
          )}
        </div>
        {props.remote && <RemoteRow remote={props.remote} onNext={props.onNext} />}
        {props.window && slide && (
          <div className="flex min-h-0 flex-[2] gap-3">
            {/* By slide: the picture that was Next stays, and becomes Now, as the show moves on to it. */}
            <ShowSlide key={slide.id} label="Now" deck={deck} slide={slide} />
            {next ? (
              <ShowSlide key={next.id} label="Next" deck={deck} slide={next} onPress={props.onNext} />
            ) : (
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
            {next ? <SlidePicture deck={deck} slide={next} onPress={props.onNext} /> : <TheEnd />}
          </div>
        )}
      </aside>
    </DarkScope>
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
    <ShowButton
      variant="ghost"
      size="default"
      aria-label="Go to the next slide"
      tooltip="Go to the next slide"
      shortcut="right"
      onClick={props.onPress}
      // Nothing of its own shows but a ring around the picture, under the pointer or the focus.
      className="absolute inset-0 h-auto rounded-lg ring-foreground/40 hover:bg-transparent hover:ring-2 focus-visible:ring-2 focus-visible:ring-foreground/40 dark:hover:bg-transparent"
    />
  );
}

/** Previous, Next, Play and End show, with their names: the show's bar is on the audience's screen. */
function RemoteRow({ remote, onNext }: { remote: ShowRemote; onNext: () => void }) {
  return (
    <div role="toolbar" aria-label="Show controls" className="flex shrink-0 flex-wrap items-center gap-1.5">
      <ButtonGroup>
        <ShowButton variant="outline" size="default" tooltip="Previous slide" shortcut="left" onClick={remote.previous}>
          <ChevronLeft data-icon="inline-start" />
          Previous
        </ShowButton>
        <ShowButton variant="outline" size="default" tooltip="Next slide" shortcut="right" onClick={onNext}>
          <ChevronRight data-icon="inline-start" />
          Next
        </ShowButton>
      </ButtonGroup>
      <ShowButton
        variant="outline"
        size="default"
        tooltip={remote.playing ? "Pause" : "Play: speak each slide's narration and move on by itself"}
        onClick={remote.togglePlay}
      >
        {remote.playing ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
        {remote.playing ? "Pause" : "Play"}
      </ShowButton>
      <span className="flex-1" />
      <ShowButton variant="outline" size="default" tooltip="End show" shortcut="escape" onClick={remote.end}>
        <X data-icon="inline-start" />
        End show
      </ShowButton>
    </div>
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
  const { budget, sources } = props;
  return (
    // Closed, the focus goes back to where it was as the settings opened (the popover's own
    // doing): the slide, when the button was pressed with the pointer, so Space still advances it.
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<ShowButton size="icon-sm" tooltip="Timer settings" />}>
        <Settings2 />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        // Typing here must not move the slides.
        onKeyDown={keepKeys()}
        className="w-64 gap-3 p-3 text-xs"
      >
        <PopoverHeader>
          <PopoverTitle>Timer settings</PopoverTitle>
        </PopoverHeader>
        <FieldGroup className="gap-2">
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
          <FieldDescription className="text-xs">
            {budget.perSlide && sources.perSlide
              ? `In minutes. This slide counts down its own time instead: ${sources.perSlide}.`
              : "In minutes. A time planned on a slide (Narration tab) comes before the time per slide; the total of the planned times is counted down when no total is set."}
          </FieldDescription>
        </FieldGroup>
      </PopoverContent>
    </Popover>
  );
}

function BudgetInput(props: {
  label: string;
  value: number;
  /** What is counted down while the field is empty, if anything. */
  source: string | null;
  onChange: (minutes: number) => void;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <FieldLabel htmlFor={id} className="text-xs font-normal">
        {props.label}
      </FieldLabel>
      <Input
        id={id}
        size="sm"
        type="number"
        min={0}
        step={0.5}
        placeholder={props.source ?? "min"}
        // The placeholder in full, where the field is too narrow for it.
        title={props.source ?? undefined}
        aria-label={`${props.label} in minutes`}
        value={props.value || ""}
        onChange={(event) => props.onChange(Math.max(0, Number(event.target.value) || 0))}
        className="w-40 flex-none tabular-nums"
      />
    </Field>
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
function ShowSlide(props: { label: string; deck: Deck; slide: Slide; onPress?: () => void }) {
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col gap-1", props.onPress ? "flex-1" : "flex-[2]")}>
      <span className="text-xs text-foreground/60">{props.label}</span>
      {/* As large as the room allows, keeping the slide's shape: it never overflows. */}
      <div className="min-h-0 flex-1" style={{ containerType: "size" }}>
        <div data-testid="fitted-slide" style={{ width: fitWidth(pixelsOf({ size: props.deck.size })) }}>
          <SlidePicture deck={props.deck} slide={props.slide} onPress={props.onPress} />
        </div>
      </div>
    </div>
  );
}

/** A slide's picture; with `onPress`, pressing it moves the show on to that slide. */
function SlidePicture({ deck, slide, onPress }: { deck: Deck; slide: Slide; onPress?: () => void }) {
  const version = useSlideVersion(slide);
  return (
    <div className="relative">
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
        <Badge data-testid="timer-paused" variant="outline" className="text-inherit uppercase tracking-wide">
          Paused
        </Badge>
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
  recording: "aria-pressed:bg-destructive/15 aria-pressed:text-destructive",
  primary: "aria-pressed:bg-primary/20 aria-pressed:text-primary",
};

/**
 * An icon button of the panel's header (a `ShowButton`), with its name beside the icon (`text`)
 * where there is room. `label` names it and is its tooltip, with the keys that do the same
 * (`shortcut`) after it. Pressed in (`active`), it takes the color of its `tone`. With a
 * `disabledReason` it cannot be pressed, and says why in its tooltip.
 */
function PanelButton(props: {
  label: string;
  shortcut?: string;
  text?: string;
  active?: boolean;
  tone?: Tone;
  disabledReason?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const disabled = props.disabledReason !== undefined;
  return (
    <ShowButton
      size={props.text === undefined ? "icon-sm" : "sm"}
      aria-label={props.label}
      tooltip={props.disabledReason ?? props.label}
      shortcut={disabled ? undefined : props.shortcut}
      {...(props.active !== undefined && { "aria-pressed": props.active })}
      disabled={disabled}
      onClick={props.onClick}
      className={cn("text-xs [&_svg:not([class*='size-'])]:size-4", ACTIVE[props.tone ?? "primary"])}
    >
      {props.children}
      {props.text}
    </ShowButton>
  );
}
