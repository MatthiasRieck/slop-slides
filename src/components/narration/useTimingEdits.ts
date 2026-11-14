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
import type { Timeline } from "../../lib/timeline";
import { useApp } from "../../store";

/** How far the pointer goes before pressing something is moving it, in pixels. */
const DRAG_START = 3;
/** How far the arrow keys move an edge or a narration, in seconds; with Shift, a second. */
const STEP = 0.1;

/** What to save for what is pressed to move by some seconds. */
export type Move = (by: number) => SlideTiming[];

/** A drag in progress: what it moves, where the pointer started, and how far a pixel goes. */
interface Drag {
  move: Move;
  target: Element;
  x: number;
  secondsPerPixel: number;
  moved: boolean;
}

/**
 * Moving the slides' edges and their narration on the timeline, by dragging them or with the
 * arrow keys, saved to the deck once let go. Until it is saved, `shown` is the timeline as it
 * would be (laid out by `layout` from `timeline`'s timing changed so), and `end` how long the
 * longer of the two is. `held` is how long the track was when a drag took off: until it ends, a
 * second stays as wide. `track` is the element the timeline is laid out along. Unless `editable`
 * (Edit mode), nothing moves.
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
  const drag = useRef<Drag | null>(null);

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
  const press = (event: PointerEvent, move: Move) => {
    if (!editable || event.button !== 0) return;
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

  return { shown, end, held, press, pointed, release, nudge };
}
