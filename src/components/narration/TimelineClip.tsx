import { type KeyboardEvent, memo, type PointerEvent } from "react";

import type { SlideAudio } from "../../lib/api";
import { formatShown, formatTenths } from "../../lib/timeline";
import { cn } from "../../lib/utils";
import { usePeaks, useWords, Waveform, Words } from "../NarrationWave";

/** What a narration on the audio track tells the timeline, by its slide's id. */
export interface ClipHandlers {
  pressClip: (event: PointerEvent, slide: string) => void;
  nudgeClip: (event: KeyboardEvent, slide: string) => void;
  /** Pressed without being moved: its slide and its start. */
  clickClip: (slide: string, start: number) => void;
  /** Double-clicked: to its script. */
  openClip: (slide: string) => void;
  pointed: (event: PointerEvent) => void;
  release: () => void;
}

/**
 * A slide's narration on the audio track, from `left` and `width` wide (as parts of the track),
 * with its waveform once it has audio, and its words once their times are known (while it is in
 * sight). Pressing it selects its slide and moves the playhead to where it starts;
 * double-clicking it goes to its script in the Narration tab; in Edit it is dragged (or moved with
 * the arrows) to start earlier or later, a bubble over it saying where it starts while it is
 * `dragging`. Audio whose script changed since it was made shows as a warning.
 * Rendered again only when something of its own changes: `on` stays the same, so the playhead
 * passing over it redraws nothing.
 */
export const TimelineClip = memo(function TimelineClip(props: {
  deck: string;
  slide: string;
  /** The number of its slide among those shown. */
  number: number;
  left: string;
  width: string;
  /** Where it starts and ends on the timeline, in seconds. */
  start: number;
  end: number;
  audio: SlideAudio | undefined;
  /**
   * Whether it is in sight, or nearly: only then are its words marked on it. Zoomed in on a long
   * deck, thousands of words lie along the track, and each would be laid out again with every
   * change of zoom.
   */
  worded: boolean;
  /** Whether it may move: in Edit, on a slide that is not locked. */
  movable: boolean;
  dragging: boolean;
  on: ClipHandlers;
}) {
  const { deck, slide, audio, on } = props;
  const seconds = audio?.seconds ?? null;
  const peaks = usePeaks(deck, slide, audio);
  const words = useWords(deck, slide, audio);
  const stale = audio?.state === "stale";
  const name =
    seconds === null
      ? `Narration of slide ${props.number}, not spoken yet`
      : `Narration of slide ${props.number}${stale ? ", out of date" : ""}`;
  const span = `${formatTenths(props.start)} – ${formatTenths(props.end)} (${formatShown(props.end - props.start)})`;
  const hint = [
    stale ? "The script changed since this audio was made; update it in the Narration tab." : null,
    props.movable ? "Drag to move it (Alt: without snapping)." : null,
    "Double-click for its script.",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      aria-label={name}
      aria-disabled={!props.movable || undefined}
      title={`${name} · ${span}. ${hint}`}
      onPointerDown={(event) => on.pressClip(event, slide)}
      onPointerMove={on.pointed}
      onPointerUp={on.release}
      onPointerCancel={on.release}
      onClick={() => on.clickClip(slide, props.start)}
      onDoubleClick={() => on.openClip(slide)}
      onKeyDown={(event) => on.nudgeClip(event, slide)}
      className={cn(
        "absolute inset-y-0.5 overflow-visible rounded-md border text-primary",
        props.movable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        seconds === null ? "border-dashed bg-muted/40" : "border-primary/40 bg-primary/25",
        stale && "border-dashed border-warning bg-warning/10 text-warning",
      )}
      style={{ left: props.left, width: props.width }}
    >
      <span className="absolute inset-0 overflow-hidden rounded-md">
        {peaks.length > 0 && <Waveform peaks={peaks} />}
        {props.worded && words.length > 0 && seconds !== null && <Words words={words} seconds={seconds} />}
      </span>
      {props.dragging && (
        <span
          data-testid="clip-time"
          className="pointer-events-none absolute bottom-full left-0 z-30 mb-0.5 whitespace-nowrap rounded-sm bg-overlay px-1 text-2xs tabular-nums text-overlay-foreground"
        >
          Starts {formatTenths(props.start)}
        </span>
      )}
    </button>
  );
});
