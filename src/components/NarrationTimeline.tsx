import { ChevronDown, Minus, Pause, Play, Plus, RotateCcw, StepBack, StepForward } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type Ref,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { Deck, Slide, SlideAudio, SlideTiming } from "../lib/api";
import { type TimedComment, timedComments } from "../lib/comments";
import { formatDuration } from "../lib/narrationAudio";
import { pixelsOf } from "../lib/slideSize";
import {
  filmstripFrames,
  layoutTimeline,
  moveClip,
  moveEdge,
  spokenSeconds,
  type Timeline,
  type TimelineClip,
  withTiming,
} from "../lib/timeline";
import { cn } from "../lib/utils";
import { loadVideoOptions } from "../lib/video";
import { useApp } from "../store";
import { Button } from "./Button";
import { usePeaks, useWords, Waveform, Words } from "./NarrationWave";
import { useDeckAudio } from "./narration/useDeckAudio";
import { useTimelinePlayback } from "./narration/useTimelinePlayback";
import { type Move, useTimingEdits } from "./narration/useTimingEdits";
import { SlideFrame, useSlideVersion } from "./SlideFrame";

/** The zoom steps of the track: how many times the width of the panel it is. */
const ZOOMS = [1, 2, 4, 8, 16];
/** How far the step buttons move the playhead, in seconds; with Shift, a second. */
const STEP = 0.1;
/** How far out of sight a slide's pictures are already there, in pixels, so scrolling finds them loaded. */
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
 * of film, its picture over and over for as long as it shows, with its narration a band of sound
 * below. The ruler moves the playhead, and Play plays it from there, the stage following along.
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
 */
export function NarrationTimeline() {
  const deck = useApp((s) => s.deck);
  const audio = useDeckAudio(deck?.id);
  if (!deck) return null;
  const slides = deck.slides.filter((s) => !s.hidden);
  if (slides.length === 0) return null;
  const spoken = spokenSeconds(slides, audio);
  const options = { ...loadVideoOptions(), narration: true };
  const layout = (timing: SlideTiming[]) => layoutTimeline(withTiming(slides, timing), spoken, options);
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
  const timeline = layout([]);
  const selected = useApp((s) => s.selected);
  // Only Edit mode changes the timing; View plays and scrubs.
  const editable = useApp((s) => s.editing);
  const comments = useApp((s) => (s.reviewVisible ? s.comments : NO_COMMENTS));
  const [zoom, setZoom] = useState(1);
  const track = useRef<HTMLDivElement>(null);
  const { time, playing, play, freeze, select } = useTimelinePlayback(deck, timeline, editable);
  const { shown, end, held, press, pointed, release, nudge } = useTimingEdits(layout, timeline, track, editable);
  const scroller = useRef<HTMLDivElement>(null);
  const strips = useRef<HTMLDivElement>(null);

  const [measured, setMeasured] = useState<Measured>({ track: 0, view: 0, slide: 0 });
  const [scrolled, setScrolled] = useState(0);
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
  const canvas = pixelsOf(deck);
  // A picture is as tall as its slide on the track, and as wide as the slide's shape makes that.
  const picture = measured.slide * (canvas.width / canvas.height);

  const percent = (seconds: number) => `${(seconds / end) * 100}%`;
  const now = Math.min(time, shown.end);

  const seek = (event: PointerEvent<HTMLDivElement>) => {
    // Pressed, or dragged along with the button down.
    if (event.type === "pointermove" ? !(event.buttons & 1) : event.button !== 0) return;
    if (event.type === "pointerdown") event.currentTarget.setPointerCapture?.(event.pointerId);
    const box = event.currentTarget.getBoundingClientRect();
    freeze(((event.clientX - box.left) / (box.width || 1)) * end);
  };
  const step = (event: MouseEvent, direction: 1 | -1) => freeze(time + direction * (event.shiftKey ? 1 : STEP));

  const reset = (editable ? slides : [])
    .filter((s) => !s.locked && (s.duration != null || s.narrationStart != null))
    .map((s) => ({ slide: s.id, duration: null, narrationStart: null }));

  return (
    <section aria-label="Narration timeline" className="flex h-44 shrink-0 flex-col border-t bg-background">
      {/* The time on the left, zoom on the right, and what plays it in the middle between them. */}
      <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-1.5 border-b px-2 py-1 text-xs">
        <span className="tabular-nums text-muted-foreground">
          {formatDuration(now)} / {formatDuration(shown.end)}
        </span>
        <div data-testid="transport" className="flex items-center gap-1">
          <Button
            size="xs"
            aria-label="Step back"
            title="Step back a tenth of a second, the slide frozen there; with Shift, a second"
            disabled={now <= 0}
            onClick={(event) => step(event, -1)}
          >
            <StepBack />
          </Button>
          <Button size="xs" onClick={play}>
            {playing ? <Pause /> : <Play />}
            {playing ? "Pause" : "Play"}
          </Button>
          <Button
            size="xs"
            aria-label="Step forward"
            title="Step forward a tenth of a second, the slide frozen there; with Shift, a second"
            disabled={now >= timeline.end}
            onClick={(event) => step(event, 1)}
          >
            <StepForward />
          </Button>
        </div>
        <div className="flex items-center justify-end gap-1.5">
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
          <Button size="xs" aria-label="Zoom out" disabled={zoom === ZOOMS[0]} onClick={() => setZoom((z) => z / 2)}>
            <Minus />
          </Button>
          <Button
            size="xs"
            aria-label="Zoom in"
            disabled={zoom === ZOOMS[ZOOMS.length - 1]}
            onClick={() => setZoom((z) => z * 2)}
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
        onScroll={(event) => setScrolled(event.currentTarget.scrollLeft)}
        className="mx-1.5 min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
      >
        <div
          ref={track}
          className="relative flex h-full min-w-full flex-col"
          style={{ width: `${zoom * 100 * Math.max(1, end / (held ?? end))}%` }}
        >
          <Ruler end={end} onSeek={seek} />
          {timedComments(comments, shown.slides).map((comment) => (
            <CommentMark
              key={comment.id}
              comment={comment}
              left={percent(comment.at)}
              onGo={() => freeze(comment.at)}
            />
          ))}
          <div className="relative min-h-0 flex-1">
            {shown.slides.map((placed, index) => {
              const moveEnd: Move = (by) => moveEdge(shown, index, placed.end + by);
              const left = measured.track * (placed.start / end);
              const frames = filmstripFrames(
                measured.track * ((placed.end - placed.start) / end),
                picture,
                scrolled - left - OVERSCAN,
                scrolled + measured.view - left + OVERSCAN,
              );
              return (
                // A sliver apart, as cuts of film lie next to each other.
                <div
                  key={placed.id}
                  className="absolute inset-y-1 px-px"
                  style={{ left: percent(placed.start), width: percent(placed.end - placed.start) }}
                >
                  <SlideBlock
                    ref={index === 0 ? strips : undefined}
                    deck={deck}
                    slide={slides[index]}
                    number={index + 1}
                    selected={placed.id === selected}
                    frames={frames}
                    picture={picture}
                    onSelect={() => select(index)}
                  />
                  <button
                    type="button"
                    aria-label={`End of slide ${index + 1}`}
                    title={
                      editable ? "Drag to change how long this slide shows" : "Switch to Edit to change the timing"
                    }
                    disabled={placed.locked || !editable}
                    onPointerDown={(event) => press(event, moveEnd)}
                    onPointerMove={pointed}
                    onPointerUp={release}
                    onPointerCancel={release}
                    onKeyDown={(event) => nudge(event, moveEnd)}
                    className={cn(
                      "absolute inset-y-0 z-10 w-2 cursor-ew-resize rounded-md focus-visible:bg-primary enabled:hover:bg-primary/60 disabled:cursor-default",
                      // Inside the track at its end, which would scroll otherwise.
                      index < shown.slides.length - 1 ? "-right-1" : "right-0",
                    )}
                  />
                </div>
              );
            })}
          </div>
          <div className="relative h-10 shrink-0">
            {shown.clips.map((clip) => {
              const moveNarration: Move = (by) => moveClip(shown, clip.slide, by);
              return (
                <Clip
                  key={clip.slide}
                  deck={deck.id}
                  clip={clip}
                  audio={audio[clip.slide]}
                  end={end}
                  locked={!editable || slides.some((s) => s.id === clip.slide && s.locked)}
                  onPress={(event) => press(event, moveNarration)}
                  onPoint={pointed}
                  onRelease={release}
                  onKeyDown={(event) => nudge(event, moveNarration)}
                />
              );
            })}
            {/* Where the slides change, so narration running over a change shows. */}
            {shown.slides.slice(0, -1).map((slide) => (
              <div
                key={slide.id}
                className="pointer-events-none absolute inset-y-0 w-px bg-primary/50"
                style={{ left: percent(slide.end) }}
              />
            ))}
          </div>
          <div
            data-testid="playhead"
            className="pointer-events-none absolute inset-y-0 z-20 w-px bg-destructive"
            style={{ left: percent(now) }}
          >
            {/* Its head, on the ruler. */}
            <span className="absolute top-0 -left-1 h-2.5 w-[9px] rounded-b-full bg-destructive" />
          </div>
        </div>
      </div>
    </section>
  );
}

/** The time along the track, which moves the playhead. */
function Ruler({ end, onSeek }: { end: number; onSeek: (event: PointerEvent<HTMLDivElement>) => void }) {
  const step = rulerStep(end);
  const marks = Array.from({ length: Math.floor(end / step) + 1 }, (_, i) => i * step);
  return (
    <div
      data-testid="ruler"
      onPointerDown={onSeek}
      onPointerMove={onSeek}
      className="relative h-4 shrink-0 cursor-pointer select-none overflow-hidden border-b text-2xs tabular-nums text-muted-foreground"
    >
      {marks.map((at) => (
        <span key={at} className="absolute border-l pl-0.5" style={{ left: `${(at / end) * 100}%` }}>
          {formatDuration(at)}
        </span>
      ))}
    </div>
  );
}

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

/**
 * A slide on its track, as a strip of film: `frames` are which of its pictures to show, each
 * `picture` pixels wide, side by side from its left. `ref` is what holds them, as tall as a picture.
 */
function SlideBlock(props: {
  ref?: Ref<HTMLDivElement>;
  deck: Deck;
  slide: Slide | undefined;
  number: number;
  selected: boolean;
  frames: number[];
  picture: number;
  onSelect: () => void;
}) {
  const { slide } = props;
  if (!slide) return null;
  return (
    <button
      type="button"
      aria-label={`Slide ${props.number}`}
      aria-current={props.selected ? "true" : undefined}
      title={`Slide ${props.number}`}
      onClick={props.onSelect}
      className="relative block size-full overflow-hidden rounded-md bg-card text-left"
    >
      <div ref={props.ref} data-testid="filmstrip" className="pointer-events-none absolute inset-0">
        {props.frames.length > 0 && (
          <SlidePictures deck={props.deck} slide={slide} frames={props.frames} picture={props.picture} />
        )}
      </div>
      <span className="absolute top-1 left-1 rounded-sm bg-overlay px-1 text-2xs tabular-nums text-overlay-foreground">
        {props.number}
      </span>
      {/* Over the pictures, which would cover an outline of the button itself. */}
      <span
        className={cn(
          "pointer-events-none absolute inset-0 rounded-md ring-inset",
          props.selected ? "ring-2 ring-primary" : "ring-1 ring-border",
        )}
      />
    </button>
  );
}

function SlidePictures(props: { deck: Deck; slide: Slide; frames: number[]; picture: number }) {
  const { deck, slide, picture } = props;
  const version = useSlideVersion(slide);
  return props.frames.map((frame) => (
    <div
      key={frame}
      data-frame={frame}
      className="absolute inset-y-0"
      style={{ left: frame * picture, width: picture }}
    >
      <SlideFrame deckId={deck.id} slideId={slide.id} version={version} size={pixelsOf(deck)} thumbnail />
    </div>
  ));
}

/** A slide's narration on the audio track, to press and move, with its waveform once it has audio. */
function Clip(props: {
  deck: string;
  clip: TimelineClip;
  audio: SlideAudio | undefined;
  end: number;
  locked: boolean;
  onPress: (event: PointerEvent) => void;
  onPoint: (event: PointerEvent) => void;
  onRelease: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  const { deck, clip, audio, end } = props;
  const seconds = audio?.seconds ?? null;
  const peaks = usePeaks(deck, clip.slide, audio);
  const words = useWords(deck, clip.slide, audio);
  const label =
    seconds === null
      ? `Narration of ${clip.slide}, not spoken yet`
      : `Narration of ${clip.slide}${audio?.state === "stale" ? ", out of date" : ""}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={props.locked}
      onPointerDown={props.onPress}
      onPointerMove={props.onPoint}
      onPointerUp={props.onRelease}
      onPointerCancel={props.onRelease}
      onKeyDown={props.onKeyDown}
      className={cn(
        "absolute inset-y-0.5 cursor-grab overflow-hidden rounded-md border text-primary active:cursor-grabbing disabled:cursor-default",
        seconds === null ? "border-dashed bg-muted/40" : "border-primary/40 bg-primary/25",
        audio?.state === "stale" && "border-dashed text-muted-foreground",
      )}
      style={{ left: `${(clip.start / end) * 100}%`, width: `${((clip.end - clip.start) / end) * 100}%` }}
    >
      {peaks.length > 0 && <Waveform peaks={peaks} />}
      {words.length > 0 && seconds !== null && <Words words={words} seconds={seconds} />}
    </button>
  );
}
