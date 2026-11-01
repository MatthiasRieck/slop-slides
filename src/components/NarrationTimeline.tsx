import { Minus, Pause, Play, Plus, RotateCcw } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import { api, type Deck, type Slide, type SlideAudio } from "../lib/api";
import { formatDuration } from "../lib/narrationAudio";
import { pixelsOf } from "../lib/slideSize";
import {
  edgeMovable,
  layoutTimeline,
  moveEdge,
  moveSlide,
  retime,
  slideAt,
  slideMovable,
  spokenSeconds,
  type Timeline,
  type TimelineClip,
} from "../lib/timeline";
import { playTimeline } from "../lib/timelinePlayback";
import { cn } from "../lib/utils";
import { loadVideoOptions } from "../lib/video";
import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { SlideFrame, useSlideVersion } from "./SlideFrame";

const NO_AUDIO: Record<string, SlideAudio> = {};
/** The zoom steps of the track: how many times the width of the panel it is. */
const ZOOMS = [1, 2, 4, 8, 16];
/** How far the pointer goes before pressing a slide is moving it, in pixels. */
const DRAG_START = 3;
/** How far the arrow keys move an edge or a slide, in seconds; with Shift, a second. */
const STEP = 0.1;
/** How narrow a slide can be and still have room for its picture, in pixels. */
const PICTURE_WIDTH = 72;

const button =
  "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent [&_svg]:size-3.5";

/** A drag in progress: what is pressed, and where the pointer started. */
interface Drag {
  index: number;
  edge: boolean;
  x: number;
  moved: boolean;
}

/**
 * The deck on a timeline, under the slide in Narration mode: the shown slides above their audio,
 * as a video export and the self-running show play them. Dragging a slide, or the edge between
 * two, moves it across the audio, which stays where it is: so a slide can change in the middle
 * of the narration, and narration can run on over the next slide. The ruler moves the playhead,
 * and Play plays it from there, the stage following along.
 */
export function NarrationTimeline() {
  const deck = useApp((s) => s.deck);
  const audio = useNarration((s) => (s.audioDeck === deck?.id ? s.audio : NO_AUDIO));
  if (!deck) return null;
  const slides = deck.slides.filter((s) => !s.hidden);
  if (slides.length === 0) return null;
  const timeline = layoutTimeline(slides, spokenSeconds(slides, audio), { ...loadVideoOptions(), narration: true });
  return <Tracks deck={deck} slides={slides} audio={audio} timeline={timeline} />;
}

/** The tracks themselves, with what plays and moves them. */
function Tracks(props: { deck: Deck; slides: Slide[]; audio: Record<string, SlideAudio>; timeline: Timeline }) {
  const { deck, slides, audio, timeline } = props;
  const selected = useApp((s) => s.selected);
  const [zoom, setZoom] = useState(1);
  const [time, setTime] = useState(0);
  const [stop, setStop] = useState<(() => void) | null>(null);
  // Where the slides end during a drag, before it is saved.
  const [preview, setPreview] = useState<number[] | null>(null);
  const drag = useRef<Drag | null>(null);
  const track = useRef<HTMLDivElement>(null);

  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!track.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(track.current);
    return () => observer.disconnect();
  }, []);

  // Replacing what stops it stops it, and so does leaving.
  useEffect(() => stop ?? undefined, [stop]);
  // A changed deck has another timeline than the one playing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs on every change of the deck.
  useEffect(() => setStop(null), [deck]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The clock starts where playing did.
  useEffect(() => {
    if (!stop) return;
    const started = Date.now() - time * 1000;
    const clock = setInterval(() => setTime((Date.now() - started) / 1000), 100);
    return () => clearInterval(clock);
  }, [stop]);

  const select = (index: number) => {
    const slide = timeline.slides[index];
    if (slide) useApp.getState().select(slide.id);
  };
  const play = () => {
    if (stop) return setStop(null);
    const from = time >= timeline.end ? 0 : time;
    setTime(from);
    select(slideAt(timeline, from));
    const stopping = playTimeline(deck.id, timeline, from, {
      slide: select,
      ended: () => {
        setStop(null);
        setTime(0);
      },
    });
    setStop(() => stopping);
  };

  const shown = preview
    ? timeline.slides.map((s, i) => ({ ...s, start: preview[i - 1] ?? 0, end: preview[i] ?? s.end }))
    : timeline.slides;
  const end = Math.max(timeline.end, shown[shown.length - 1]?.end ?? 0);
  const percent = (seconds: number) => `${(seconds / end) * 100}%`;

  const finish = (next: number[]) => {
    setPreview(null);
    void useApp.getState().setSlideTiming(retime(timeline, next));
  };
  const nudge = (event: KeyboardEvent, index: number, edge: boolean) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const by = (event.shiftKey ? 1 : STEP) * (event.key === "ArrowLeft" ? -1 : 1);
    const slide = timeline.slides[index];
    if (slide) finish(edge ? moveEdge(timeline, index, slide.end + by) : moveSlide(timeline, index, by));
  };
  const press = (event: PointerEvent, index: number, edge: boolean) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { index, edge, x: event.clientX, moved: false };
  };
  const pointed = (event: PointerEvent) => {
    const held = drag.current;
    const slide = held && timeline.slides[held.index];
    if (!held || !slide) return;
    const pixels = event.clientX - held.x;
    if (!held.moved && Math.abs(pixels) < DRAG_START) return;
    held.moved = true;
    const by = pixels * (timeline.end / (width || 1));
    setPreview(held.edge ? moveEdge(timeline, held.index, slide.end + by) : moveSlide(timeline, held.index, by));
  };
  const release = () => {
    const held = drag.current;
    drag.current = null;
    if (held && preview) finish(preview);
  };
  const seek = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = Math.min(end, Math.max(0, ((event.clientX - box.left) / (box.width || 1)) * end));
    setStop(null);
    setTime(at);
    select(slideAt(timeline, at));
  };

  const reset = slides
    .filter((s) => !s.locked && (s.duration != null || s.narrationStart != null))
    .map((s) => ({ slide: s.id, duration: null, narrationStart: null }));

  return (
    <section aria-label="Narration timeline" className="flex h-44 shrink-0 flex-col border-t bg-background">
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1 text-xs">
        <button type="button" className={button} onClick={play}>
          {stop ? <Pause /> : <Play />}
          {stop ? "Pause" : "Play"}
        </button>
        <span className="tabular-nums text-muted-foreground">
          {formatDuration(time)} / {formatDuration(timeline.end)}
        </span>
        <span className="ml-auto" />
        {reset.length > 0 && (
          <button
            type="button"
            className={button}
            title="Let every slide follow its narration again"
            onClick={() => void useApp.getState().setSlideTiming(reset)}
          >
            <RotateCcw />
            Reset timing
          </button>
        )}
        <button
          type="button"
          aria-label="Zoom out"
          className={button}
          disabled={zoom === ZOOMS[0]}
          onClick={() => setZoom((z) => z / 2)}
        >
          <Minus />
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          className={button}
          disabled={zoom === ZOOMS[ZOOMS.length - 1]}
          onClick={() => setZoom((z) => z * 2)}
        >
          <Plus />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div ref={track} className="relative flex h-full min-w-full flex-col" style={{ width: `${zoom * 100}%` }}>
          <Ruler end={end} onSeek={seek} />
          <div className="relative min-h-0 flex-1 border-b">
            {shown.map((placed, index) => (
              <div
                key={placed.id}
                className="absolute inset-y-1"
                style={{ left: percent(placed.start), width: percent(placed.end - placed.start) }}
              >
                <SlideBlock
                  deck={deck}
                  slide={slides[index]}
                  number={index + 1}
                  selected={placed.id === selected}
                  movable={slideMovable(timeline, index)}
                  wide={width * ((placed.end - placed.start) / end) >= PICTURE_WIDTH}
                  onPress={(event) => press(event, index, false)}
                  onPoint={pointed}
                  onRelease={release}
                  onKeyDown={(event) => nudge(event, index, false)}
                  onSelect={() => select(index)}
                />
                <button
                  type="button"
                  aria-label={`End of slide ${index + 1}`}
                  title="Drag to change when this slide ends"
                  disabled={!edgeMovable(timeline, index)}
                  onPointerDown={(event) => press(event, index, true)}
                  onPointerMove={pointed}
                  onPointerUp={release}
                  onPointerCancel={release}
                  onKeyDown={(event) => nudge(event, index, true)}
                  className={cn(
                    "absolute inset-y-0 z-10 w-2 cursor-ew-resize rounded-sm focus-visible:bg-primary enabled:hover:bg-primary/60 disabled:cursor-default",
                    // Inside the track at its end, which would scroll otherwise.
                    index < shown.length - 1 ? "-right-1" : "right-0",
                  )}
                />
              </div>
            ))}
          </div>
          <div className="relative h-11 shrink-0">
            {timeline.clips.map((clip) => (
              <Clip key={clip.slide} deck={deck.id} clip={clip} audio={audio[clip.slide]} end={end} />
            ))}
            {/* Where the slides change, so narration running over a change shows. */}
            {shown.slice(0, -1).map((slide) => (
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
            style={{ left: percent(Math.min(time, end)) }}
          />
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

/** A round time between ruler marks, for about a dozen of them. */
export function rulerStep(end: number): number {
  return [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((step) => end / step <= 12) ?? 1200;
}

/** A slide on its track, to press and move, with its picture when it fits. */
function SlideBlock(props: {
  deck: Deck;
  slide: Slide | undefined;
  number: number;
  selected: boolean;
  movable: boolean;
  wide: boolean;
  onPress: (event: PointerEvent) => void;
  onPoint: (event: PointerEvent) => void;
  onRelease: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onSelect: () => void;
}) {
  const { slide } = props;
  if (!slide) return null;
  return (
    <button
      type="button"
      aria-label={`Slide ${props.number}`}
      aria-current={props.selected ? "true" : undefined}
      title={props.movable ? "Drag to move this slide across the audio" : `Slide ${props.number}`}
      onPointerDown={props.movable ? props.onPress : undefined}
      onPointerMove={props.onPoint}
      onPointerUp={props.onRelease}
      onPointerCancel={props.onRelease}
      onKeyDown={props.movable ? props.onKeyDown : undefined}
      onClick={props.onSelect}
      className={cn(
        "flex size-full items-center gap-1 overflow-hidden rounded-sm border bg-card px-1 text-left text-xs",
        props.movable && "cursor-grab active:cursor-grabbing",
        props.selected && "ring-2 ring-primary ring-inset",
      )}
    >
      {props.wide && <SlidePicture deck={props.deck} slide={slide} />}
      <span className="min-w-0 truncate tabular-nums text-muted-foreground">{props.number}</span>
    </button>
  );
}

function SlidePicture({ deck, slide }: { deck: Deck; slide: Slide }) {
  const version = useSlideVersion(slide);
  return (
    <span className="pointer-events-none w-14 shrink-0 overflow-hidden rounded-sm">
      <SlideFrame deckId={deck.id} slideId={slide.id} version={version} size={pixelsOf(deck)} thumbnail />
    </span>
  );
}

/** A slide's narration on the audio track, with its waveform once it has audio. */
function Clip(props: { deck: string; clip: TimelineClip; audio: SlideAudio | undefined; end: number }) {
  const { deck, clip, audio, end } = props;
  const [peaks, setPeaks] = useState<number[]>([]);
  const seconds = audio?.seconds ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Regenerated audio has another waveform.
  useEffect(() => {
    if (seconds === null) return setPeaks([]);
    let current = true;
    // Without a waveform, the clip still shows where the audio is.
    const show = (found: number[] | null) => {
      if (current) setPeaks(found ?? []);
    };
    api.narrationPeaks(deck, clip.slide).then(show, () => show(null));
    return () => {
      current = false;
    };
  }, [deck, clip.slide, seconds, audio?.state]);
  const label =
    seconds === null
      ? `Narration of ${clip.slide}, not spoken yet`
      : `Narration of ${clip.slide}${audio?.state === "stale" ? ", out of date" : ""}`;
  return (
    <div
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "absolute inset-y-1 overflow-hidden rounded-sm border text-primary",
        seconds === null ? "border-dashed bg-muted/40" : "bg-primary/15",
        audio?.state === "stale" && "border-dashed text-muted-foreground",
      )}
      style={{ left: `${(clip.start / end) * 100}%`, width: `${((clip.end - clip.start) / end) * 100}%` }}
    >
      {peaks.length > 0 && <Waveform peaks={peaks} />}
    </div>
  );
}

/** `peaks`, one bar each, mirrored around the middle and stretched to fit. */
function Waveform({ peaks }: { peaks: number[] }) {
  const bars = peaks.map((peak, i) => `M${i} ${1 - peak}V${1 + peak}`).join("");
  return (
    <svg
      aria-hidden="true"
      className="size-full"
      viewBox={`0 0 ${peaks.length} 2`}
      preserveAspectRatio="none"
      fill="none"
      stroke="currentColor"
    >
      <path d={bars} strokeWidth="0.8" />
    </svg>
  );
}
