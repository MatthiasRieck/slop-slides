import { type KeyboardEvent, memo, type PointerEvent } from "react";

import type { SlideAudio } from "../../lib/api";
import { cn } from "../../lib/utils";
import { usePeaks, useWords, Waveform, Words } from "../NarrationWave";

/** What a narration on the audio track tells the timeline, by its slide's id. */
export interface ClipHandlers {
  pressClip: (event: PointerEvent, slide: string) => void;
  nudgeClip: (event: KeyboardEvent, slide: string) => void;
  pointed: (event: PointerEvent) => void;
  release: () => void;
}

/**
 * A slide's narration on the audio track, from `left` and `width` wide (as parts of the track),
 * to press and move, with its waveform once it has audio. Rendered again only when something of
 * its own changes: `on` stays the same, so the playhead passing over it redraws nothing.
 */
export const TimelineClip = memo(function TimelineClip(props: {
  deck: string;
  slide: string;
  /** The number of its slide among those shown. */
  number: number;
  left: string;
  width: string;
  audio: SlideAudio | undefined;
  locked: boolean;
  on: ClipHandlers;
}) {
  const { deck, slide, audio, on } = props;
  const seconds = audio?.seconds ?? null;
  const peaks = usePeaks(deck, slide, audio);
  const words = useWords(deck, slide, audio);
  const label =
    seconds === null
      ? `Narration of slide ${props.number}, not spoken yet`
      : `Narration of slide ${props.number}${audio?.state === "stale" ? ", out of date" : ""}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={props.locked}
      onPointerDown={(event) => on.pressClip(event, slide)}
      onPointerMove={on.pointed}
      onPointerUp={on.release}
      onPointerCancel={on.release}
      onKeyDown={(event) => on.nudgeClip(event, slide)}
      className={cn(
        "absolute inset-y-0.5 cursor-grab overflow-hidden rounded-md border text-primary active:cursor-grabbing disabled:cursor-default",
        seconds === null ? "border-dashed bg-muted/40" : "border-primary/40 bg-primary/25",
        audio?.state === "stale" && "border-dashed text-muted-foreground",
      )}
      style={{ left: props.left, width: props.width }}
    >
      {peaks.length > 0 && <Waveform peaks={peaks} />}
      {words.length > 0 && seconds !== null && <Words words={words} seconds={seconds} />}
    </button>
  );
});
