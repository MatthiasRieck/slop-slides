import { type MouseEvent, useLayoutEffect, useRef } from "react";

import type { SlideAudio } from "../../lib/api";
import type { Playback } from "../../lib/narrationAudio";
import { playheadTransform } from "../../lib/playbackClock";
import { scrollToPlayhead } from "../../lib/timeline";
import { cn } from "../../lib/utils";
import { usePeaks, useWords, Waveform, Words } from "../NarrationWave";

/** How wide a second of audio is at least once its words are shown, in pixels, so they can be read. */
const WORDS_SECOND_WIDTH = 80;

/**
 * The slide's audio as its waveform, with when each word is said once that is known. Pressing
 * it plays the audio from there; a line shows where it is while it plays. With words, it is as
 * wide as they need and scrolls, turning the page when the line runs out of sight.
 *
 * The line is moved every frame by a transform set on the element itself (see
 * `playheadTransform`), asking the audio where it is: the waveform and the words under it are
 * not rendered again for it. `paused`, it stays where the audio stopped.
 */
export function SlideWave(props: {
  deck: string;
  slide: string;
  audio: SlideAudio;
  seconds: number;
  playback: Playback | null;
  paused: boolean;
  onPlay: (from: number) => void;
}) {
  const { deck, slide, audio, seconds, playback, paused } = props;
  const peaks = usePeaks(deck, slide, audio);
  const words = useWords(deck, slide, audio);
  const scroller = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!playback) return;
    let frame = 0;
    const follow = () => {
      const at = Math.min(seconds, playback.time()) / seconds;
      if (playhead.current) playhead.current.style.transform = playheadTransform(at);
      const box = scroller.current;
      if (box) {
        const to = scrollToPlayhead(box.scrollWidth * at, box.scrollLeft, box.clientWidth);
        if (to !== box.scrollLeft) box.scrollLeft = to;
      }
      if (!paused) frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [playback, paused, seconds]);
  const press = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    props.onPlay(Math.min(seconds, Math.max(0, ((event.clientX - box.left) / (box.width || 1)) * seconds)));
  };
  const stale = audio.state === "stale";
  return (
    <div ref={scroller} className="overflow-x-auto overflow-y-hidden rounded-md border">
      <button
        type="button"
        aria-label={stale ? "Narration audio, out of date" : "Narration audio"}
        title="Press to play from there"
        onClick={press}
        className={cn(
          "relative block h-16 min-w-full cursor-pointer bg-primary/15 text-primary",
          stale && "bg-warning/10 text-warning",
        )}
        style={words.length > 0 ? { width: seconds * WORDS_SECOND_WIDTH } : undefined}
      >
        {peaks.length > 0 && <Waveform peaks={peaks} />}
        {words.length > 0 && <Words words={words} seconds={seconds} />}
        {playback && (
          // As wide as the waveform and just left of it, the line at its edge: see `playheadTransform`.
          <span
            ref={playhead}
            data-testid="wave-playhead"
            className="pointer-events-none absolute inset-y-0 right-full w-full"
          >
            <span className="absolute inset-y-0 left-full w-px bg-destructive" />
          </span>
        )}
      </button>
    </div>
  );
}
