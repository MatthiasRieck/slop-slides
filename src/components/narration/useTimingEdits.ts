import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { SlideTiming } from "../../lib/api";
import { snapTime, type Timeline } from "../../lib/timeline";
import { useApp } from "../../store";

/** How far the pointer goes before pressing something is moving it, in pixels. */
const DRAG_START = 3;
/** How far the arrow keys move an edge or a narration, in seconds; with Shift, a second. */
const STEP = 0.1;
/** How near a target a drag comes before it snaps to it, in pixels. */
export const SNAP_PIXELS = 6;

/** What to save for what is pressed to move by some seconds. */
export type Move = (by: number) => SlideTiming[];

/**
 * What a drag snaps to: `from`, the time of what is dragged as it starts (an edge, a narration's
 * start), and the times it snaps to, worked out once as it is pressed.
 */
export interface SnapTargets {
  from: number;
  targets: number[];
}

/** A drag in progress: what it moves, where the pointer started, how far a pixel goes and what it snaps to. */
interface Drag {
  move: Move;
  /** What is dragged, for whoever shows it while it moves. */
  name: string;
  target: Element;
  x: number;
  secondsPerPixel: number;
  snap: SnapTargets | null;
  moved: boolean;
}

/** A drag as it shows while it moves: what is dragged, and the time it snapped to (null when none). */
export interface Dragging {
  name: string;
  guide: number | null;
}

/**
 * Moving the slides' edges and their narration on the timeline, by dragging them or with the
 * arrow keys, saved to the deck once let go. Until it is saved, `shown` is the timeline as it
 * would be (laid out by `layout` from `timeline`'s timing changed so), and `end` how long the
 * longer of the two is. `held` is how long the track was when a drag took off: until it ends, a
 * second stays as wide. `track` is the element the timeline is laid out along. Unless `editable`
 * (Edit mode), nothing moves.
 *
 * A drag snaps to the targets it is pressed with, within a few pixels (Alt held lets it go
 * anywhere); `dragging` says what moves and where it snapped, for a guide line. A press that
 * did not move is no drag: `wasDragged` says whether the press just released moved something,
 * so a click after a drag does nothing more.
 *
 * `layout` and `timeline` are expected to stay the same while what they are made from does: the
 * preview is laid out once for each move of a drag, not again for every render in between.
 */
export function useTimingEdits(
  layout: (timing: SlideTiming[]) => Timeline,
  timeline: Timeline,
  track: RefObject<HTMLElement | null>,
  editable = true,
) {
  // What a drag would save, until it is saved.
  const [preview, setPreview] = useState<SlideTiming[] | null>(null);
  const [held, setHeld] = useState<number | null>(null);
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const drag = useRef<Drag | null>(null);
  const dragged = useRef(false);

  const shown = useMemo(() => (preview ? layout(preview) : timeline), [preview, layout, timeline]);
  const end = Math.max(timeline.end, shown.end);

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
    if (!editable || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    event.stopPropagation();
    finish(move((event.shiftKey ? 1 : STEP) * (event.key === "ArrowLeft" ? -1 : 1)));
  };
  const press = (event: PointerEvent, move: Move, name = "", snap: SnapTargets | null = null) => {
    dragged.current = false;
    if (!editable || event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const width = track.current?.getBoundingClientRect().width ?? 0;
    const secondsPerPixel = end / (width || 1);
    // A track not laid out yet has no pixels to snap within.
    const snaps = width > 0 ? snap : null;
    drag.current = {
      move,
      name,
      target: event.currentTarget,
      x: event.clientX,
      secondsPerPixel,
      snap: snaps,
      moved: false,
    };
  };
  const pointed = (event: PointerEvent) => {
    const current = drag.current;
    if (!current) return;
    const pixels = event.clientX - current.x;
    if (!current.moved && Math.abs(pixels) < DRAG_START) return;
    current.moved = true;
    let by = pixels * current.secondsPerPixel;
    let guide: number | null = null;
    if (current.snap && !event.altKey) {
      const { from, targets } = current.snap;
      const snapped = snapTime(from + by, targets, SNAP_PIXELS * current.secondsPerPixel);
      by = snapped.at - from;
      guide = snapped.target;
    }
    setHeld((length) => length ?? end);
    setDragging((was) => (was?.name === current.name && was.guide === guide ? was : { name: current.name, guide }));
    setPreview(current.move(by));
  };
  const release = () => {
    const current = drag.current;
    drag.current = null;
    dragged.current = !!current?.moved;
    setHeld(null);
    setDragging(null);
    if (current?.moved && preview) finish(preview);
  };
  /** Whether the press released last moved what it pressed; asking forgets it. */
  const wasDragged = () => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  };

  return { shown, end, held, dragging, press, pointed, release, nudge, finish, wasDragged };
}
