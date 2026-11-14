import { ChevronDown, Gauge, Minus, Pause, Play, Plus, RotateCcw, SkipBack, StepBack, StepForward } from "lucide-react";
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
import { formatKeys, isTextField, isTypingTarget } from "../lib/keys";
import { formatDuration } from "../lib/narrationAudio";
import { perFrame } from "../lib/perFrame";
import type { PlaybackClock } from "../lib/playbackClock";
import { pixelsOf } from "../lib/slideSize";
import { loadJson, saveJson } from "../lib/storage";
import {
  clampTimelineHeight,
  clampZoom,
  clipTargets,
  edgeTargets,
  formatTenths,
  formatZoom,
  layoutTimeline,
  MAX_ZOOM,
  moveClip,
  moveEdge,
  scrollForZoom,
  scrollStep,
  showsPicture,
  slideAt,
  spokenSeconds,
  TIMELINE_HEIGHTS,
  type Timeline,
  wheelZoom,
  withTiming,
} from "../lib/timeline";
import { nextRate } from "../lib/timelinePlayback";
import { useApp } from "../store";
import { Button, withShortcut } from "./Button";
import { TimelineClip } from "./narration/TimelineClip";
import { Playhead, TimeReadout, useFollowPlayhead, usePlayheadValue } from "./narration/TimelinePlayhead";
import { TimelineSlide } from "./narration/TimelineSlide";
import { TimingButton } from "./narration/TimingSettings";
import { useDeckAudio } from "./narration/useDeckAudio";
import { useTimelinePlayback } from "./narration/useTimelinePlayback";
import { type Move, type SnapTargets, useTimingEdits } from "./narration/useTimingEdits";
import { useDeckVideoOptions } from "./narration/useVideoOptions";

/** How far the step buttons move the playhead, in seconds; with Shift, a second. */
const STEP = 0.1;
/** How far J steps back, in seconds. */
const JUMP = 1;
/** How far out of sight a slide's picture is already there, in pixels, so scrolling finds it loaded. */
const OVERSCAN = 200;
/** How else the timeline zooms, for the zoom buttons' tooltips. */
const ZOOM_GESTURE = `${formatKeys("mod")}-scroll or pinch`;
/** Where the timeline's height is remembered. */
const HEIGHT_KEY = "slopslide.timelineHeight";

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
 * pressing a slide moves the playhead to where that slide starts, and pressing a narration to
 * where it starts (double-clicking it opens its script). Zoomed in, the track scrolls to keep a
 * playing playhead in sight, and a change of zoom leaves the playhead where it is; ⌘/Ctrl and
 * the wheel (or a pinch) zoom around the pointer, and the readout between the zoom buttons fits
 * the whole timeline in again. Its top edge drags it taller or lower, remembered.
 *
 * With the focus in the tracks, the keys play and move too: Space plays and pauses, ← and → step
 * a tenth of a second (a second with Shift), Home and End go to the ends, J steps back a second,
 * K pauses and L plays, faster each time while it plays. The ruler is a slider for that. Space
 * also plays and pauses with the focus anywhere but a field, a button or the slide itself.
 *
 * How long a slide without narration shows, and the pauses around narration, are set under
 * Timing in its bar (see `TimingSettings`): the deck's own times, which a video export and the
 * show's Play use too.
 *
 * In View it only plays and scrubs. Not playing, the slide on the stage is frozen as it is at the
 * playhead, its animations that far in: pausing, pressing or dragging on the ruler and stepping
 * back or forward all leave it so, to look at one moment, and to comment on it: a comment made
 * then is about that moment, and marked on the ruler, where pressing its mark goes back to it.
 *
 * In Edit the timing changes too, and the stage stays the editor's unless the deck plays. Dragging
 * the end of a slide changes how long it shows, the slides after it following with their
 * narration. Dragging a narration moves it, up to the narration on either side: so a slide can
 * change in the middle of the narration, and narration can run on over the next slide. Drags
 * snap to where narration ends, where slides change and to the playhead, a line showing where;
 * Alt lets them go anywhere. A slide timed by hand is marked, and goes back to following its
 * narration with a double-click on its handle.
 *
 * It is laid out once for the slides, their audio and the stored times, and again only when one
 * of those changes. Where the playhead is, is no state of it (see `useTimelinePlayback`): playing
 * moves the playhead and counts the time, and renders nothing else.
 */
export function NarrationTimeline() {
  const deck = useApp((s) => s.deck);
  const audio = useDeckAudio(deck?.id);
  const stored = useDeckVideoOptions(deck?.id);
  const all = deck?.slides;
  const slides = useMemo(() => (all ?? []).filter((s) => !s.hidden), [all]);
  const layout = useMemo(() => {
    const spoken = spokenSeconds(slides, audio);
    const options = { ...stored, narration: true };
    return (timing: SlideTiming[]) => layoutTimeline(withTiming(slides, timing), spoken, options);
  }, [slides, audio, stored]);
  if (!deck || slides.length === 0) return null;
  return (
    <Tracks
      deck={deck}
      slides={slides}
      audio={audio}
      layout={layout}
      pauseBefore={stored.pauseBefore}
      pauseAfter={stored.pauseAfter}
    />
  );
}

/** The timeline's height as last dragged, or as it opens first. */
function loadHeight(): number {
  return loadJson(HEIGHT_KEY, TIMELINE_HEIGHTS.initial, (saved) =>
    typeof saved === "number" ? clampTimelineHeight(saved) : TIMELINE_HEIGHTS.initial,
  );
}

/** The tracks themselves, with what plays and moves them. */
function Tracks(props: {
  deck: Deck;
  slides: Slide[];
  audio: Record<string, SlideAudio>;
  layout: (timing: SlideTiming[]) => Timeline;
  pauseBefore: number;
  pauseAfter: number;
}) {
  const { deck, slides, audio, layout } = props;
  const timeline = useMemo(() => layout([]), [layout]);
  const selected = useApp((s) => s.selected);
  // Only Edit mode changes the timing; View plays and scrubs.
  const editable = useApp((s) => s.editing);
  const comments = useApp((s) => (s.reviewVisible ? s.comments : NO_COMMENTS));
  const [zoom, setZoom] = useState(1);
  const [height, setHeight] = useState(loadHeight);
  const track = useRef<HTMLDivElement>(null);
  const { clock, playing, rate, play, pause, freeze, goToSlide, changeRate } = useTimelinePlayback(
    deck,
    timeline,
    editable,
  );
  const edits = useTimingEdits(layout, timeline, track, editable);
  const { shown, end, held, dragging, press, pointed, release, nudge, finish, wasDragged } = edits;
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

  // A change of zoom keeps a point where it is on screen: the playhead, or the pointer that
  // zoomed. The track's width before it, and that point (as a part of the track), until laid out anew.
  const zoomedFrom = useRef<{ width: number; at: number | null } | null>(null);
  const zoomTo = (next: number, at: number | null = null) => {
    const to = clampZoom(next);
    if (to === zoom) return;
    zoomedFrom.current = { width: track.current?.clientWidth ?? 0, at };
    setZoom(to);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once the track has its new width.
  useLayoutEffect(() => {
    const [box, from, after] = [scroller.current, zoomedFrom.current, track.current?.clientWidth ?? 0];
    zoomedFrom.current = null;
    if (!box || from === null || !(end > 0)) return;
    const at = from.at ?? now() / end;
    box.scrollLeft = scrollForZoom(at, from.width, after, box.scrollLeft, box.clientWidth);
  }, [zoom]);
  // ⌘/Ctrl and the wheel, and a trackpad's pinch (which comes as that), zoom around the pointer.
  // Listened to by hand: React's wheel listener may not keep the page itself from zooming.
  const wheel = useHandlers({
    zoom: (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const box = track.current?.getBoundingClientRect();
      const at = box && box.width > 0 ? (event.clientX - box.left) / box.width : null;
      zoomTo(wheelZoom(zoom, event.deltaY), at);
    },
  });
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    box.addEventListener("wheel", wheel.zoom, { passive: false });
    return () => box.removeEventListener("wheel", wheel.zoom);
  }, [wheel]);

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
  /** L: plays, or while it plays, plays faster (round to as recorded after the fastest). */
  const faster = () => (playing ? changeRate(nextRate(rate)) : play());
  /**
   * The keys of the tracks, with the focus in them: Space plays and pauses, the arrows step, Home
   * and End go to the ends, J K L step back, pause and play. An edge or a narration being moved
   * with the arrows has taken them before; a field or a button of the bar keeps its own.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTextField(event.target)) return;
    if ((event.target as Element).closest("[data-timeline-bar], [data-popover]")) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === " ") play();
    else if (key === "ArrowLeft") step(event, -1);
    else if (key === "ArrowRight") step(event, 1);
    else if (key === "Home") freeze(0);
    else if (key === "End") freeze(timeline.end);
    else if (key === "j") freeze(clock.time() - JUMP);
    else if (key === "k") pause();
    else if (key === "l") faster();
    else return;
    // The keys are the timeline's here: Space presses no button, the arrows move no slide.
    event.preventDefault();
    event.stopPropagation();
  };
  // Space plays and pauses from anywhere the timeline is in sight, unless what has the focus
  // takes Space itself: a field, a button or a list, or the slide (whose frame keeps its keys).
  const spaceKey = useHandlers({
    down: (event: globalThis.KeyboardEvent) => {
      if (event.key !== " " || event.repeat || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target as Element | null;
      if (isTypingTarget(target) || target?.closest?.("button, a, summary, [role=button], iframe, [data-popover]"))
        return;
      if (useApp.getState().presenting) return;
      event.preventDefault();
      play();
    },
  });
  useEffect(() => {
    window.addEventListener("keydown", spaceKey.down);
    return () => window.removeEventListener("keydown", spaceKey.down);
  }, [spaceKey]);

  /** What to save for the end of the slide at `index` to move by some seconds, from where it is now. */
  const moveEnd = (index: number): Move => {
    const from = shown.slides[index]?.end ?? 0;
    return (by) => moveEdge(shown, index, from + by);
  };
  const moveNarration =
    (slide: string): Move =>
    (by) =>
      moveClip(shown, slide, by);
  /** What the end of the slide at `index` snaps to, worked out once as it is pressed. */
  const edgeSnap = (index: number): SnapTargets => ({
    from: shown.slides[index]?.end ?? 0,
    targets: edgeTargets(shown, index, props.pauseAfter, now()),
  });
  const clipSnap = (slide: string): SnapTargets => ({
    from: shown.clips.find((c) => c.slide === slide)?.start ?? 0,
    targets: clipTargets(shown, slide, props.pauseBefore, now()),
  });
  const locked = (slide: string) => !!shown.slides.find((s) => s.id === slide)?.locked;
  // The same from one render to the next, so the slides and clips they are handed to stay as they are.
  const on = useHandlers({
    seek,
    step,
    goToSlide,
    pointed,
    release,
    pressEdge: (event: PointerEvent, index: number) =>
      press(event, moveEnd(index), `edge:${index}`, editable ? edgeSnap(index) : null),
    nudgeEdge: (event: KeyboardEvent, index: number) => nudge(event, moveEnd(index)),
    followNarration: (index: number) => {
      const slide = shown.slides[index];
      if (editable && slide && !slide.locked) finish([{ slide: slide.id, duration: null, narrationStart: null }]);
    },
    // A locked slide's narration stays where it is; pressing it still goes to it.
    pressClip: (event: PointerEvent, slide: string) => {
      if (!locked(slide)) press(event, moveNarration(slide), `clip:${slide}`, editable ? clipSnap(slide) : null);
    },
    nudgeClip: (event: KeyboardEvent, slide: string) => {
      if (!locked(slide)) nudge(event, moveNarration(slide));
    },
    clickClip: (slide: string, start: number) => {
      if (wasDragged()) return;
      freeze(start);
      if (useApp.getState().selected !== slide) useApp.getState().select(slide);
    },
    openClip: (slide: string) => {
      useApp.getState().select(slide);
      useApp.getState().showNarration();
    },
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

  /** Sets the height, kept for the next time the timeline opens. */
  const resize = (next: number | null) => {
    const to = next === null ? TIMELINE_HEIGHTS.initial : clampTimelineHeight(next, window.innerHeight * 0.6);
    setHeight(to);
    saveJson(HEIGHT_KEY, to);
  };

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the keys of what is focused in it.
    <section
      aria-label="Narration timeline"
      onKeyDown={onKeyDown}
      className="relative flex shrink-0 flex-col border-t bg-background"
      style={{ height }}
    >
      <HeightHandle height={height} onResize={resize} />
      {/* The time on the left, zoom on the right, and what plays it in the middle between them. */}
      <div
        data-timeline-bar=""
        className="@container grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-1.5 border-b px-2 py-1 text-xs"
      >
        <TimeReadout clock={clock} limit={shown.end} total={shown.end} playing={playing} />
        <Transport
          clock={clock}
          limit={shown.end}
          end={timeline.end}
          playing={playing}
          rate={rate}
          onPlay={play}
          onFreeze={freeze}
          onStep={on.step}
          onRate={() => changeRate(nextRate(rate))}
        />
        <div className="flex min-w-0 items-center justify-end gap-1.5">
          <TimingButton deck={deck.id} />
          {reset.length > 0 && (
            <Button
              size="xs"
              title={`Let every slide follow its narration again: ${reset.length} ${reset.length === 1 ? "slide is" : "slides are"} timed by hand. Undo brings the timing back.`}
              aria-label="Reset all timing"
              onClick={() => void useApp.getState().setSlideTiming(reset)}
            >
              <RotateCcw />
              <span className="hidden @[44rem]:inline">Reset all timing</span>
            </Button>
          )}
          <div className="flex items-center">
            <Button
              size="xs"
              aria-label="Zoom timeline out"
              title={zoom <= 1 ? "The whole timeline is in sight" : `Zoom timeline out (${ZOOM_GESTURE})`}
              disabled={zoom <= 1}
              onClick={() => zoomTo(zoom / 2)}
            >
              <Minus />
            </Button>
            <button
              type="button"
              data-testid="timeline-zoom"
              title={zoom <= 1 ? "Timeline zoom: the whole timeline is in sight" : "Fit the whole timeline in"}
              aria-label={`Timeline zoom ${formatZoom(zoom)}; fit the whole timeline in`}
              disabled={zoom <= 1}
              onClick={() => zoomTo(1)}
              className="hidden min-w-8 rounded-md px-1 text-center tabular-nums text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground @[36rem]:block"
            >
              {formatZoom(zoom)}
            </button>
            <Button
              size="xs"
              aria-label="Zoom timeline in"
              title={
                zoom >= MAX_ZOOM ? "Zoomed in all the way" : `Zoom timeline in, around the playhead (${ZOOM_GESTURE})`
              }
              disabled={zoom >= MAX_ZOOM}
              onClick={() => zoomTo(zoom * 2)}
            >
              <Plus />
            </Button>
          </div>
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
      <div className="flex min-h-0 flex-1">
        {/* What each track is, beside it. */}
        <div aria-hidden="true" className="flex w-16 shrink-0 flex-col border-r pl-2 text-2xs text-muted-foreground">
          <span className="h-4 shrink-0" />
          <span className="flex min-h-0 flex-[3] items-center">Slides</span>
          <span className="flex min-h-10 flex-[2] items-center">Narration</span>
        </div>
        {/* Clear of the panels' resize handles, which take a press a few pixels either side of them. */}
        <div
          ref={scroller}
          onScroll={(event) => setScrolled(scrollStep(event.currentTarget.scrollLeft, picture))}
          className="mx-1.5 min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
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
            <div className="relative min-h-0 flex-[3]">
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
            <div className="relative min-h-10 flex-[2] shrink-0">
              {shown.clips.length === 0 && (
                <p
                  data-testid="no-narration"
                  className="sticky left-0 flex h-full w-fit items-center gap-1.5 px-2 text-2xs text-muted-foreground"
                >
                  No narration yet.
                  <Button size="xs" onClick={() => useApp.getState().showNarration()}>
                    Write narration
                  </Button>
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
                  start={clip.start}
                  end={clip.end}
                  audio={audio[clip.slide]}
                  movable={editable && !placed.get(clip.slide)?.locked}
                  dragging={dragging?.name === `clip:${clip.slide}`}
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
            {dragging?.guide != null && (
              <div
                data-testid="snap-guide"
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 z-20 w-px bg-warning"
                style={{ left: percent(dragging.guide) }}
              />
            )}
            <Playhead clock={clock} limit={shown.end} end={end} />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The timeline's top edge, which drags it taller or lower (the arrows too, Home and End to the
 * lowest and tallest); a double click gives it its first height back. `height` is the height now.
 */
function HeightHandle(props: { height: number; onResize: (height: number | null) => void }) {
  const start = useRef<{ y: number; height: number } | null>(null);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter supports resizing; hr cannot take the keys.
    <div
      role="separator"
      aria-label="Resize timeline"
      aria-orientation="horizontal"
      aria-valuemin={TIMELINE_HEIGHTS.min}
      aria-valuemax={TIMELINE_HEIGHTS.max}
      aria-valuenow={props.height}
      tabIndex={0}
      title="Drag to make the timeline taller or lower; double-click for its first height"
      className="absolute inset-x-0 -top-1 z-30 h-2 cursor-ns-resize touch-none focus-visible:bg-primary/40 focus-visible:outline-none hover:bg-primary/30"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        start.current = { y: event.clientY, height: props.height };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const from = start.current;
        if (from) props.onResize(from.height + from.y - event.clientY);
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
      onDoubleClick={() => props.onResize(null)}
      onKeyDown={(event) => {
        const by = event.shiftKey ? 48 : 16;
        const next =
          event.key === "ArrowUp"
            ? props.height + by
            : event.key === "ArrowDown"
              ? props.height - by
              : event.key === "Home"
                ? TIMELINE_HEIGHTS.min
                : event.key === "End"
                  ? TIMELINE_HEIGHTS.max
                  : null;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        props.onResize(next);
      }}
    />
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
  rate: number;
  onPlay: () => void;
  onFreeze: (at: number) => void;
  onStep: (event: { shiftKey: boolean }, direction: 1 | -1) => void;
  onRate: () => void;
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
        aria-label={playing ? "Pause" : "Play"}
        title={withShortcut(playing ? "Pause" : "Play from the playhead", "space")}
        onClick={props.onPlay}
      >
        {playing ? <Pause /> : <Play />}
        <span className="hidden @[30rem]:inline">{playing ? "Pause" : "Play"}</span>
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
      <button
        type="button"
        data-testid="playback-rate"
        aria-label={`Playback speed ${props.rate}×`}
        title={withShortcut(`Playback speed ${props.rate}×: press for faster, round to 1× after 2×`, "l")}
        onClick={props.onRate}
        className="flex min-w-8 items-center gap-0.5 rounded-md px-1 tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Gauge aria-hidden="true" className="size-3.5" />
        {props.rate}×
      </button>
    </div>
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
