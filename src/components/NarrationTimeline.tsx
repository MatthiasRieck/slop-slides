import { Minus, Pause, Play, Plus, RotateCcw } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import { api, type Deck, type NarrationWord, type Slide, type SlideAudio, type SlideTiming } from "../lib/api";
import { formatDuration } from "../lib/narrationAudio";
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
import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { Button } from "./Button";
import { SlideFrame, useSlideVersion } from "./SlideFrame";

const NO_AUDIO: Record<string, SlideAudio> = {};
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
 * The deck on a timeline, under the slide in Narration mode: the shown slides above their audio,
 * as a video export and the self-running show play them. Dragging the end of a slide changes
 * how long it shows, the slides after it following with their narration. Dragging a narration
 * moves it, up to the narration on either side: so a slide can change in the middle of the
 * narration, and narration can run on over the next slide. The ruler moves the playhead, and
 * Play plays it from there, the stage following along.
 */
export function NarrationTimeline() {
  const deck = useApp((s) => s.deck);
  const audio = useNarration((s) => (s.audioDeck === deck?.id ? s.audio : NO_AUDIO));
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
        <Button size="xs" onClick={play}>
          {stop ? <Pause /> : <Play />}
          {stop ? "Pause" : "Play"}
        </Button>
        <span className="tabular-nums text-muted-foreground">
          {formatDuration(now)} / {formatDuration(shown.end)}
        </span>
        <span className="ml-auto" />
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

/** When each word of the slide's up-to-date audio is said, once that is known. */
function useWords(deck: string, slide: string, audio: SlideAudio | undefined): NarrationWord[] {
  const [words, setWords] = useState<NarrationWord[]>([]);
  const timed = audio?.state === "ready" && !!audio.timed;
  // biome-ignore lint/correctness/useExhaustiveDependencies: New audio has other words.
  useEffect(() => {
    if (!timed) return setWords([]);
    let current = true;
    api.narrationWords(deck, slide).then(
      (found) => current && setWords(found ?? []),
      () => current && setWords([]),
    );
    return () => {
      current = false;
    };
  }, [deck, slide, timed, audio?.seconds]);
  return words;
}

/** `words` along audio `seconds` long, each at its start, cut off where the next begins. */
function Words({ words, seconds }: { words: NarrationWord[]; seconds: number }) {
  const at = (time: number) => (Math.min(time, seconds) / seconds) * 100;
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-3.5">
      {words.map((word, i) => {
        const next = words[i + 1]?.start ?? seconds;
        return (
          <span
            key={`${word.start}-${word.end}-${word.text}`}
            data-word={word.text}
            className="absolute bottom-0 overflow-hidden whitespace-nowrap border-l border-current/40 pl-px text-left text-[9px] leading-3.5 text-foreground/80"
            style={{ left: `${at(word.start)}%`, width: `${Math.max(0, at(next) - at(word.start))}%` }}
          >
            {word.text}
          </span>
        );
      })}
    </span>
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
