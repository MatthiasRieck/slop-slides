import { Minus, Pause, Play, Plus, RotateCcw, StepBack, StepForward } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { Deck, Slide, SlideAudio, SlideTiming } from "../lib/api";
import { formatDuration } from "../lib/narrationAudio";
import { setSlideClock } from "../lib/slideClock";
import { pixelsOf } from "../lib/slideSize";
import {
  layoutTimeline,
  moveClip,
  moveEdge,
  slideAt,
  spokenSeconds,
  type Timeline,
  type TimelineClip,
  withTiming,
} from "../lib/timeline";
import { playTimeline } from "../lib/timelinePlayback";
import { cn } from "../lib/utils";
import { loadVideoOptions } from "../lib/video";
import { useApp } from "../store";
import { Button } from "./Button";
import { usePeaks, useWords, Waveform, Words } from "./NarrationWave";
import { useDeckAudio } from "./narration/useDeckAudio";
import { SlideFrame, useSlideVersion } from "./SlideFrame";

/** The zoom steps of the track: how many times the width of the panel it is. */
const ZOOMS = [1, 2, 4, 8, 16];
/** How far the pointer goes before pressing something is moving it, in pixels. */
const DRAG_START = 3;
/** How far the arrow keys move an edge or a narration, in seconds; with Shift, a second. */
const STEP = 0.1;
/** How narrow a slide can be and still have room for its picture, in pixels. */
const PICTURE_WIDTH = 72;

/** What to save for what is pressed to move by some seconds. */
type Move = (by: number) => SlideTiming[];

/** A drag in progress: what it moves, where the pointer started, and how far a pixel goes. */
interface Drag {
  move: Move;
  target: Element;
  x: number;
  secondsPerPixel: number;
  moved: boolean;
}

/**
 * The deck on a timeline, under the slide in Play mode: the shown slides above their audio,
 * as a video export and the self-running show play them. Dragging the end of a slide changes
 * how long it shows, the slides after it following with their narration. Dragging a narration
 * moves it, up to the narration on either side: so a slide can change in the middle of the
 * narration, and narration can run on over the next slide. The ruler moves the playhead, and
 * Play plays it from there, the stage following along. Not playing, the slide on the stage is
 * frozen as it is at the playhead, its animations that far in: pausing, pressing or dragging on
 * the ruler and stepping back or forward all leave it so, to look at one moment.
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
  const [zoom, setZoom] = useState(1);
  const [time, setTime] = useState(0);
  const [stop, setStop] = useState<(() => void) | null>(null);
  // What a drag would save, until it is saved.
  const [preview, setPreview] = useState<SlideTiming[] | null>(null);
  // How long the track was when a drag took off: until it ends, a second stays as wide.
  const [held, setHeld] = useState<number | null>(null);
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
  useEffect(() => {
    setStop(null);
    setSlideClock(null);
  }, [deck]);
  useEffect(() => () => setSlideClock(null), []);

  /** Puts the slide showing at `at` (and its timed animations) where the timeline is then; `paused`, they stay there. */
  const clockAt = (at: number, paused = false) => {
    const slide = timeline.slides[slideAt(timeline, at)];
    setSlideClock(slide ? { slide: slide.id, at: at - slide.start, ...(paused && { paused }) } : null);
  };
  const select = (index: number) => {
    const slide = timeline.slides[index];
    if (slide) useApp.getState().select(slide.id);
  };
  const play = () => {
    if (stop) return freeze(time);
    const from = time >= timeline.end ? 0 : time;
    setTime(from);
    select(slideAt(timeline, from));
    const stopping = playTimeline(deck.id, timeline, from, {
      slide: select,
      tick: (at) => {
        setTime(at);
        clockAt(at);
      },
      ended: () => {
        setStop(null);
        setTime(0);
        setSlideClock(null);
      },
    });
    setStop(() => stopping);
  };

  const shown = preview ? layout(preview) : timeline;
  const end = Math.max(timeline.end, shown.end);
  const percent = (seconds: number) => `${(seconds / end) * 100}%`;
  const now = Math.min(time, shown.end);

  // Past the end of the panel, the track scrolls to keep what is dragged in sight.
  // biome-ignore lint/correctness/useExhaustiveDependencies: What is dragged moves with the preview.
  useLayoutEffect(() => {
    drag.current?.target.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [preview]);

  const finish = (timing: SlideTiming[]) => {
    setPreview(timing);
    void useApp
      .getState()
      .setSlideTiming(timing)
      .then(() => setPreview((current) => (current === timing ? null : current)));
  };
  const nudge = (event: KeyboardEvent, move: Move) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    finish(move((event.shiftKey ? 1 : STEP) * (event.key === "ArrowLeft" ? -1 : 1)));
  };
  const press = (event: PointerEvent, move: Move) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const secondsPerPixel = end / (track.current?.getBoundingClientRect().width || 1);
    drag.current = { move, target: event.currentTarget, x: event.clientX, secondsPerPixel, moved: false };
  };
  const pointed = (event: PointerEvent) => {
    const dragged = drag.current;
    if (!dragged) return;
    const pixels = event.clientX - dragged.x;
    if (!dragged.moved && Math.abs(pixels) < DRAG_START) return;
    dragged.moved = true;
    setHeld((length) => length ?? end);
    setPreview(dragged.move(pixels * dragged.secondsPerPixel));
  };
  const release = () => {
    const dragged = drag.current;
    drag.current = null;
    setHeld(null);
    if (dragged?.moved && preview) finish(preview);
  };
  /** Stops at `at`, the stage showing that moment and staying on it. */
  const freeze = (at: number) => {
    const to = Math.min(timeline.end, Math.max(0, at));
    setStop(null);
    setTime(to);
    select(slideAt(timeline, to));
    clockAt(to, true);
  };
  const seek = (event: PointerEvent<HTMLDivElement>) => {
    // Pressed, or dragged along with the button down.
    if (event.type === "pointermove" ? !(event.buttons & 1) : event.button !== 0) return;
    if (event.type === "pointerdown") event.currentTarget.setPointerCapture?.(event.pointerId);
    const box = event.currentTarget.getBoundingClientRect();
    freeze(((event.clientX - box.left) / (box.width || 1)) * end);
  };
  const step = (event: MouseEvent, direction: 1 | -1) => freeze(time + direction * (event.shiftKey ? 1 : STEP));

  const reset = slides
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
            {stop ? <Pause /> : <Play />}
            {stop ? "Pause" : "Play"}
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
        </div>
      </div>
      {/* Clear of the panels' resize handles, which take a press a few pixels either side of them. */}
      <div className="mx-1.5 min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div
          ref={track}
          className="relative flex h-full min-w-full flex-col"
          style={{ width: `${zoom * 100 * Math.max(1, end / (held ?? end))}%` }}
        >
          <Ruler end={end} onSeek={seek} />
          <div className="relative min-h-0 flex-1 border-b">
            {shown.slides.map((placed, index) => {
              const moveEnd: Move = (by) => moveEdge(shown, index, placed.end + by);
              return (
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
                    wide={width * ((placed.end - placed.start) / end) >= PICTURE_WIDTH}
                    onSelect={() => select(index)}
                  />
                  <button
                    type="button"
                    aria-label={`End of slide ${index + 1}`}
                    title="Drag to change how long this slide shows"
                    disabled={placed.locked}
                    onPointerDown={(event) => press(event, moveEnd)}
                    onPointerMove={pointed}
                    onPointerUp={release}
                    onPointerCancel={release}
                    onKeyDown={(event) => nudge(event, moveEnd)}
                    className={cn(
                      "absolute inset-y-0 z-10 w-2 cursor-ew-resize rounded-sm focus-visible:bg-primary enabled:hover:bg-primary/60 disabled:cursor-default",
                      // Inside the track at its end, which would scroll otherwise.
                      index < shown.slides.length - 1 ? "-right-1" : "right-0",
                    )}
                  />
                </div>
              );
            })}
          </div>
          <div className="relative h-11 shrink-0">
            {shown.clips.map((clip) => {
              const moveNarration: Move = (by) => moveClip(shown, clip.slide, by);
              return (
                <Clip
                  key={clip.slide}
                  deck={deck.id}
                  clip={clip}
                  audio={audio[clip.slide]}
                  end={end}
                  locked={slides.some((s) => s.id === clip.slide && s.locked)}
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

/** A round time between ruler marks, for about a dozen of them. */
export function rulerStep(end: number): number {
  return [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((step) => end / step <= 12) ?? 1200;
}

/** A slide on its track, with its picture when it fits. */
function SlideBlock(props: {
  deck: Deck;
  slide: Slide | undefined;
  number: number;
  selected: boolean;
  wide: boolean;
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
      className={cn(
        "flex size-full items-center gap-1 overflow-hidden rounded-sm border bg-card px-1 text-left text-xs",
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
        "absolute inset-y-1 cursor-grab overflow-hidden rounded-sm border text-primary focus-visible:ring-2 focus-visible:ring-primary active:cursor-grabbing disabled:cursor-default",
        seconds === null ? "border-dashed bg-muted/40" : "bg-primary/15",
        audio?.state === "stale" && "border-dashed text-muted-foreground",
      )}
      style={{ left: `${(clip.start / end) * 100}%`, width: `${((clip.end - clip.start) / end) * 100}%` }}
    >
      {peaks.length > 0 && <Waveform peaks={peaks} />}
      {words.length > 0 && seconds !== null && <Words words={words} seconds={seconds} />}
    </button>
  );
}
