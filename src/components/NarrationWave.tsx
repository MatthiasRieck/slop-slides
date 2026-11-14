import { memo, useEffect, useState } from "react";

import { api, type NarrationWord, type SlideAudio } from "../lib/api";
import { narrationPeaks } from "../lib/narrationCache";
import { wavePath } from "../lib/waveform";

/**
 * How loud a slide's narration audio is along its length, for its waveform; empty without audio
 * or while it loads. Shared by the timeline's clips and the Narration tab, which read it once
 * between them (see ../lib/narrationCache.ts).
 */
export function usePeaks(deck: string, slide: string, audio: SlideAudio | undefined): number[] {
  const [peaks, setPeaks] = useState<number[]>([]);
  const seconds = audio?.seconds ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Regenerated audio has another waveform.
  useEffect(() => {
    if (seconds === null) return setPeaks([]);
    let current = true;
    // Without a waveform, what shows it still shows where the audio is.
    const show = (found: number[] | null) => {
      if (current) setPeaks(found ?? []);
    };
    narrationPeaks(deck, slide).then(show, () => show(null));
    return () => {
      current = false;
    };
  }, [deck, slide, seconds, audio?.state]);
  return peaks;
}

/** When each word of the slide's up-to-date audio is said, once that is known. */
export function useWords(deck: string, slide: string, audio: SlideAudio | undefined): NarrationWord[] {
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

/**
 * `words` along audio `seconds` long, each at its start, cut off where the next begins. Drawn
 * again only for other words: a playhead moving over them changes nothing of theirs.
 */
export const Words = memo(function Words({ words, seconds }: { words: NarrationWord[]; seconds: number }) {
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
});

/** `peaks`, one bar each, mirrored around the middle and stretched to fit. Drawn again only for other peaks. */
export const Waveform = memo(function Waveform({ peaks }: { peaks: number[] }) {
  const bars = wavePath(peaks);
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
});
