import { ChevronDown, Minus, Pause, Play, Plus, RotateCcw, SkipBack, StepBack, StepForward, Timer } from "lucide-react";
import {
  type KeyboardEvent,
  memo,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useHandlers } from "../hooks/useHandlers";
import type { Deck, Slide, SlideAudio, SlideTiming } from "../lib/api";
import { type TimedComment, timedComments } from "../lib/comments";
import { isTextField } from "../lib/keys";
import { formatDuration } from "../lib/narrationAudio";
import { perFrame } from "../lib/perFrame";
import type { PlaybackClock } from "../lib/playbackClock";
import { pixelsOf } from "../lib/slideSize";
import {
  formatTenths,
  layoutTimeline,
  moveClip,
  moveEdge,
  scrollForZoom,
  scrollStep,
  showsPicture,
  slideAt,
  spokenSeconds,
  type Timeline,
  withTiming,
} from "../lib/timeline";
import { useApp } from "../store";
import { Button, withShortcut } from "./Button";
import { TimelineClip } from "./narration/TimelineClip";
import { Playhead, TimeReadout, useFollowPlayhead, usePlayheadValue } from "./narration/TimelinePlayhead";
import { TimelineSlide } from "./narration/TimelineSlide";
import { TimingSettings } from "./narration/TimingSettings";
import { useDeckAudio } from "./narration/useDeckAudio";
import { useTimelinePlayback } from "./narration/useTimelinePlayback";
import { type Move, useTimingEdits } from "./narration/useTimingEdits";
import { useVideoOptions } from "./narration/useVideoOptions";
import { Popover } from "./Popover";

/** The zoom steps of the track: how many times the width of the panel it is. */
const ZOOMS = [1, 2, 4, 8, 16];
/** How far the step buttons move the playhead, in seconds; with Shift, a second. */
const STEP = 0.1;
/** How far out of sight a slide's picture is already there, in pixels, so scrolling finds it loaded. */
const OVERSCAN = 200;

/** The track as measured, in pixels: its whole width, how much of it is in sight, and how tall a slide is on it. */
interface Measured {
  track: number;
  view: number;
  slide: number;
}

/**
 * The deck on a timeline, under the slide in View and in Edit while it is open: the shown slides
 * above their audio, as a video export and the self-running show play them. Each slide is a strip
 * of film, as long as it shows, with its picture at the start (see `TimelineSlide`) and its
 * narration a band of sound below. The ruler moves the playhead, and Play plays it from there, the stage following along;
 * pressing a slide moves the playhead to where that slide starts. Zoomed in, the track scrolls to
 * keep a playing playhead in sight, and a change of zoom leaves the playhead where it is.
 *
 * With the focus in the tracks, the keys play and move too: Space plays and pauses, ← and → step
 * a tenth of a second (a second with Shift), Home and End go to the ends. The ruler is a slider
 * for that. Elsewhere those keys mean what they always do.
 *
 * How long a slide without narration shows, and the pauses around narration, are set under
 * Timing in its bar (see `TimingSettings`): the same times a video export and the show's Play use.
 *
 * In View it only plays and scrubs. Not playing, the slide on the stage is frozen as it is at the
 * playhead, its animations that far in: pausing, pressing or dragging on the ruler and stepping
 * back or forward all leave it so, to look at one moment, and to comment on it: a comment made
 * then is about that moment, and marked on the ruler, where pressing its mark goes back to it.
 *
 * In Edit the timing changes too, and the stage stays the editor's unless the deck plays. Dragging
 * the end of a slide changes how long it shows, the slides after it following with their
 * narration. Dragging a narration moves it, up to the narration on either side: so a slide can
 * change in the middle of the narration, and narration can run on over the next slide.
 *
 * It is laid out once for the slides, their audio and the stored times, and again only when one
 * of those changes. Where the playhead is, is no state of it (see `useTimelinePlayback`): playing
 * moves the playhead and counts the time, and renders nothing else.
 */
export function NarrationTimeline() {
  const deck = useApp((s) => s.deck);
  const audio = useDeckAudio(deck?.id);
  const stored = useVideoOptions();
  const all = deck?.slides;
  const slides = useMemo(() => (all ?? []).filter((s) => !s.hidden), [all]);
  const layout = useMemo(() => {
    const spoken = spokenSeconds(slides, audio);
    const options = { ...stored, narration: true };
    return (timing: SlideTiming[]) => layoutTimeline(withTiming(slides, timing), spoken, options);
  }, [slides, audio, stored]);
  if (!deck || slides.length === 0) return null;
  return <Tracks deck={deck} slides={slides} audio={audio} layout={layout} />;
}

/** The tracks themselves, with what plays and moves them. */
function Tracks(props: {
  deck: Deck;
  slides: Slide[];
  audio: Record<string, SlideAudio>;
  layout: (timing: SlideTiming[]) => Timeline;
}) {
  const { deck, slides, audio, layout } = props;
  const timeline = useMemo(() => layout([]), [layout]);
  const selected = useApp((s) => s.selected);
  // Only Edit mode changes the timing; View plays and scrubs.
  const editable = useApp((s) => s.editing);
  const comments = useApp((s) => (s.reviewVisible ? s.comments : NO_COMMENTS));
  const [zoom, setZoom] = useState(1);
  const track = useRef<HTMLDivElement>(null);
  const { clock, playing, play, freeze, goToSlide } = useTimelinePlayback(deck, timeline, editable);
  const { shown, end, held, press, pointed, release, nudge } = useTimingEdits(layout, timeline, track, editable);
  const scroller = useRef<HTMLDivElement>(null);
  const strips = useRef<HTMLDivElement>(null);

  const [measured, setMeasured] = useState<Measured>({ track: 0, view: 0, slide: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const next = {
        track: track.current?.clientWidth ?? 0,
        view: scroller.current?.clientWidth ?? 0,
        slide: strips.current?.clientHeight ?? 0,
      };
      setMeasured((was) =>
        was.track === next.track && was.view === next.view && was.slide === next.slide ? was : next,
      );
    };
    const observer = new ResizeObserver(measure);
    for (const element of [track.current, scroller.current, strips.current]) if (element) observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  const canvas = useMemo(() => pixelsOf({ size: deck.size }), [deck.size]);
  // A picture is as tall as its slide on the track, and as wide as the slide's shape makes that.
  const picture = measured.slide * (canvas.width / canvas.height);
  // How far the track is scrolled, a picture's width at a time: what is in sight is only worked
  // out anew from one step to the next, so scrolling renders nothing in between.
  const [scrolled, setScrolled] = useState(0);
  const sight = { from: scrolled - OVERSCAN, to: scrolled + picture + measured.view + OVERSCAN };

  const percent = (seconds: number) => `${(seconds / end) * 100}%`;
  /** Where the playhead shows: never past the end of a timeline a drag made shorter. */
  const now = () => Math.min(clock.time(), shown.end);

  useFollowPlayhead(clock, scroller, playing, { track: measured.track, view: measured.view, limit: shown.end, end });

  // A change of zoom keeps the playhead where it is on screen: the track's width before it, until laid out anew.
  const zoomedFrom = useRef<number | null>(null);
  const zoomTo = (next: number) => {
    zoomedFrom.current = track.current?.clientWidth ?? null;
    setZoom(next);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once the track has its new width.
  useLayoutEffect(() => {
    const [box, before, after] = [scroller.current, zoomedFrom.current, track.current?.clientWidth ?? 0];
    zoomedFrom.current = null;
    if (!box || before === null || !(end > 0)) return;
    box.scrollLeft = scrollForZoom(now() / end, before, after, box.scrollLeft, box.clientWidth);
  }, [zoom]);

  // Dragging along the ruler moves the playhead once a frame at most, however fast the pointer tells.
  const scrub = useMemo(() => perFrame(freeze), [freeze]);
  useEffect(() => () => scrub.cancel(), [scrub]);
  const seek = (event: PointerEvent<HTMLDivElement>) => {
    // Pressed, or dragged along with the button down.
    if (event.type === "pointermove" ? !(event.buttons & 1) : event.button !== 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const at = ((event.clientX - box.left) / (box.width || 1)) * end;
    if (event.type === "pointermove") return scrub.push(at);
    // A press moves it at once, whatever a drag before it still had to say.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    scrub.cancel();
    freeze(at);
  };
  const step = (event: { shiftKey: boolean }, direction: 1 | -1) =>
    freeze(clock.time() + direction * (event.shiftKey ? 1 : STEP));
  /**
   * The keys of the tracks, with the focus in them: Space plays and pauses, the arrows step, Home
   * and End go to the ends. An edge or a narration being moved with the arrows has taken them
   * before; a field or a button of the bar keeps its own.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTextField(event.target)) return;
    if ((event.target as Element).closest("[data-timeline-bar], [data-popover]")) return;
    if (event.key === " ") play();
    else if (event.key === "ArrowLeft") step(event, -1);
    else if (event.key === "ArrowRight") step(event, 1);
    else if (event.key === "Home") freeze(0);
    else if (event.key === "End") freeze(timeline.end);
    else return;
    // The keys are the timeline's here: Space presses no button, the arrows move no slide.
    event.preventDefault();
    event.stopPropagation();
  };

  /** What to save for the end of the slide at `index` to move by some seconds, from where it is now. */
  const moveEnd = (index: number): Move => {
    const from = shown.slides[index]?.end ?? 0;
    return (by) => moveEdge(shown, index, from + by);
  };
  const moveNarration =
    (slide: string): Move =>
    (by) =>
      moveClip(shown, slide, by);
  // The same from one render to the next, so the slides and clips they are handed to stay as they are.
  const on = useHandlers({
    seek,
    step,
    goToSlide,
    pointed,
    release,
    pressEdge: (event: PointerEvent, index: number) => press(event, moveEnd(index)),
    nudgeEdge: (event: KeyboardEvent, index: number) => nudge(event, moveEnd(index)),
    pressClip: (event: PointerEvent, slide: string) => press(event, moveNarration(slide)),
    nudgeClip: (event: KeyboardEvent, slide: string) => nudge(event, moveNarration(slide)),
  });

  const marks = useMemo(() => timedComments(comments, shown.slides), [comments, shown.slides]);
  /** Each shown slide by its id: its number, and whether it is locked. */
  const placed = useMemo(
    () => new Map(shown.slides.map((slide, index) => [slide.id, { number: index + 1, locked: slide.locked }])),
    [shown.slides],
  );
  const reset = (editable ? slides : [])
    .filter((s) => !s.locked && (s.duration != null || s.narrationStart != null))
    .map((s) => ({ slide: s.id, duration: null, narrationStart: null }));

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the keys of what is focused in it.
    <section
      aria-label="Narration timeline"
      onKeyDown={onKeyDown}
      className="flex h-44 shrink-0 flex-col border-t bg-background"
    >
      {/* The time on the left, zoom on the right, and what plays it in the middle between them. */}
      <div
        data-timeline-bar=""
        className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-1.5 border-b px-2 py-1 text-xs"
      >
        <TimeReadout clock={clock} limit={shown.end} total={shown.end} playing={playing} />
        <Transport
          clock={clock}
          limit={shown.end}
          end={timeline.end}
          playing={playing}
          onPlay={play}
          onFreeze={freeze}
          onStep={on.step}
        />
        <div className="flex items-center justify-end gap-1.5">
          <TimingButton />
          {reset.length > 0 && (
            <Button
              size="xs"
              title="Let every slide follow its narration again"
              onClick={() => void useApp.getState().setSlideTiming(reset)}
            >
              <RotateCcw />
              Reset timing
            </Button>
          )}
          <Button
            size="xs"
            aria-label="Zoom out"
            title={zoom === ZOOMS[0] ? "The whole timeline is in sight" : "Zoom out"}
            disabled={zoom === ZOOMS[0]}
            onClick={() => zoomTo(zoom / 2)}
          >
            <Minus />
          </Button>
          <Button
            size="xs"
            aria-label="Zoom in"
            title={zoom === ZOOMS[ZOOMS.length - 1] ? "Zoomed in all the way" : "Zoom in, around the playhead"}
            disabled={zoom === ZOOMS[ZOOMS.length - 1]}
            onClick={() => zoomTo(zoom * 2)}
          >
            <Plus />
          </Button>
          <Button
            size="xs"
            aria-label="Hide timeline"
            title="Fold the timeline away, leaving the room to the slide"
            onClick={() => useApp.getState().setTimelineOpen(false)}
          >
            <ChevronDown />
          </Button>
        </div>
      </div>
      {/* Clear of the panels' resize handles, which take a press a few pixels either side of them. */}
      <div
        ref={scroller}
        onScroll={(event) => setScrolled(scrollStep(event.currentTarget.scrollLeft, picture))}
        className="mx-1.5 min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
      >
        <div
          ref={track}
          className="relative flex h-full min-w-full flex-col"
          style={{ width: `${zoom * 100 * Math.max(1, end / (held ?? end))}%` }}
        >
          <Ruler clock={clock} timeline={shown} end={end} onSeek={on.seek} />
          {marks.map((comment) => (
            <CommentMark
              key={comment.id}
              comment={comment}
              left={percent(comment.at)}
              onGo={() => freeze(comment.at)}
            />
          ))}
          <div className="relative min-h-0 flex-1">
            {shown.slides.map((slide, index) => {
              const source = slides[index];
              const left = measured.track * (slide.start / end);
              const width = measured.track * ((slide.end - slide.start) / end);
              return (
                source && (
                  <TimelineSlide
                    key={slide.id}
                    deck={deck.id}
                    size={canvas}
                    slide={source}
                    index={index}
                    left={percent(slide.start)}
                    width={percent(slide.end - slide.start)}
                    seconds={slide.end - slide.start}
                    selected={slide.id === selected}
                    picture={picture}
                    pictured={showsPicture(left, width, picture, sight.from, sight.to)}
                    resizable={editable && !slide.locked}
                    editable={editable}
                    last={index === shown.slides.length - 1}
                    filmRef={index === 0 ? strips : undefined}
                    on={on}
                  />
                )
              );
            })}
          </div>
          <div className="relative h-10 shrink-0">
            {shown.clips.length === 0 && (
              <p
                data-testid="no-narration"
                className="sticky left-0 flex h-full w-fit items-center px-2 text-2xs text-muted-foreground"
              >
                No narration yet. Write it in the Narration tab.
              </p>
            )}
            {shown.clips.map((clip) => (
              <TimelineClip
                key={clip.slide}
                deck={deck.id}
                slide={clip.slide}
                number={placed.get(clip.slide)?.number ?? 0}
                left={percent(clip.start)}
                width={percent(clip.end - clip.start)}
                audio={audio[clip.slide]}
                locked={!editable || !!placed.get(clip.slide)?.locked}
                on={on}
              />
            ))}
            {/* Where the slides change, so narration running over a change shows. */}
            {shown.slides.slice(0, -1).map((slide) => (
              <div
                key={slide.id}
                className="pointer-events-none absolute inset-y-0 w-px bg-primary/50"
                style={{ left: percent(slide.end) }}
              />
            ))}
          </div>
          <Playhead clock={clock} limit={shown.end} end={end} />
        </div>
      </div>
    </section>
  );
}

/**
 * What plays the timeline and steps along it, in the middle of its bar. Back and forward go as
 * far as the ends: whether the playhead (`limit` at most) is at one is all it follows of it.
 */
function Transport(props: {
  clock: PlaybackClock;
  limit: number;
  end: number;
  playing: boolean;
  onPlay: () => void;
  onFreeze: (at: number) => void;
  onStep: (event: { shiftKey: boolean }, direction: 1 | -1) => void;
}) {
  const { clock, limit, end, playing } = props;
  const atStart = usePlayheadValue(clock, (time) => Math.min(time, limit) <= 0);
  const atEnd = usePlayheadValue(clock, (time) => Math.min(time, limit) >= end);
  return (
    <div data-testid="transport" className="flex items-center gap-1">
      <Button
        size="xs"
        aria-label="Back to start"
        title={withShortcut("Back to the start", "home")}
        disabled={atStart}
        onClick={() => props.onFreeze(0)}
      >
        <SkipBack />
      </Button>
      <Button
        size="xs"
        aria-label="Step back"
        title={withShortcut("Step back a tenth of a second, the slide frozen there; with Shift, a second", "left")}
        disabled={atStart}
        onClick={(event) => props.onStep(event, -1)}
      >
        <StepBack />
      </Button>
      <Button
        size="xs"
        title={withShortcut(playing ? "Pause" : "Play from the playhead", "space")}
        onClick={props.onPlay}
      >
        {playing ? <Pause /> : <Play />}
        {playing ? "Pause" : "Play"}
      </Button>
      <Button
        size="xs"
        aria-label="Step forward"
        title={withShortcut("Step forward a tenth of a second, the slide frozen there; with Shift, a second", "right")}
        disabled={atEnd}
        onClick={(event) => props.onStep(event, 1)}
      >
        <StepForward />
      </Button>
    </div>
  );
}

/**
 * How the stored times are set, from the timeline's bar: how long a slide without narration
 * shows, and the pauses around narration.
 */
function TimingButton() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={anchor}
        size="xs"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="How long a slide without narration shows, and the pauses around narration"
        onClick={() => setOpen((o) => !o)}
      >
        <Timer />
        Timing
      </Button>
      {open && (
        <Popover
          anchor={anchor}
          placement="above"
          align="end"
          width={280}
          portal
          label="Timing"
          onClose={() => setOpen(false)}
        >
          <TimingSettings />
        </Popover>
      )}
    </>
  );
}

/**
 * The time along the track, which moves the playhead: pressed or dragged with the pointer, and
 * a slider for the keyboard, whose keys are the timeline's (see `Tracks`). As a slider it says
 * where the playhead stands, or, while the deck plays, where it set out from: its value changes
 * when the playhead is moved or stopped, not with every moment played.
 */
const Ruler = memo(function Ruler(props: {
  clock: PlaybackClock;
  /** The timeline as shown, which the playhead never passes the end of. */
  timeline: Timeline;
  /** How long the track is, in seconds. */
  end: number;
  onSeek: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  const { clock, timeline, end, onSeek } = props;
  const now = Math.min(useSyncExternalStore(clock.onChange, clock.rest), timeline.end);
  const step = rulerStep(end);
  const marks = Array.from({ length: Math.floor(end / step) + 1 }, (_, i) => i * step);
  return (
    <div
      data-testid="ruler"
      role="slider"
      tabIndex={0}
      aria-label="Playhead"
      aria-valuemin={0}
      aria-valuemax={Math.round(end * 10) / 10}
      aria-valuenow={Math.round(now * 10) / 10}
      aria-valuetext={`${formatTenths(now)} of ${formatDuration(end)}, slide ${slideAt(timeline, now) + 1}`}
      title="Press or drag to move the playhead; with the focus here, ← → step and Space plays"
      onPointerDown={onSeek}
      onPointerMove={onSeek}
      className="relative h-4 shrink-0 cursor-pointer select-none overflow-hidden border-b text-2xs tabular-nums text-muted-foreground focus-visible:bg-accent focus-visible:outline-none"
    >
      {marks.map((at) => (
        <span key={at} className="absolute border-l pl-0.5" style={{ left: `${(at / end) * 100}%` }}>
          {formatDuration(at)}
        </span>
      ))}
    </div>
  );
});

const NO_COMMENTS: Record<string, never> = {};

/** A comment made at a moment, over the ruler at that moment: pressing it goes there. */
function CommentMark(props: { comment: TimedComment; left: string; onGo: () => void }) {
  const { comment } = props;
  const label = `Comment ${comment.number} on slide ${comment.index + 1}`;
  return (
    <button
      type="button"
      data-testid="comment-mark"
      aria-label={label}
      title={`${label}: ${comment.text}`}
      onClick={props.onGo}
      style={{ left: props.left }}
      className="absolute top-0.5 z-30 size-3 -translate-x-1/2 rounded-full rounded-bl-none border border-background bg-primary hover:scale-125"
    />
  );
}

/** A round time between ruler marks, for about a dozen of them. */
export function rulerStep(end: number): number {
  return [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((step) => end / step <= 12) ?? 1200;
}
