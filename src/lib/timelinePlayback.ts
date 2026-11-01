import { type Playback, playNarration } from "./narrationAudio";
import type { Timeline } from "./timeline";

/** What a playing timeline tells. */
export interface TimelineEvents {
  /** It got to the slide at this index of the timeline's. */
  slide: (index: number) => void;
  /** It reached its end. */
  ended: () => void;
}

/**
 * Plays `timeline` from `from` seconds: each slide's narration at its time, from where it has
 * got to if it already started, whichever slide is showing. Gives back how to stop it.
 */
export function playTimeline(deck: string, timeline: Timeline, from: number, on: TimelineEvents): () => void {
  let stopped = false;
  const voices = new Set<Playback>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const at = (seconds: number, run: () => void) => {
    timers.push(setTimeout(run, Math.max(0, (seconds - from) * 1000)));
  };
  const say = async (slide: string, skip: number) => {
    try {
      const voice = await playNarration(deck, slide, skip);
      if (stopped) return voice.stop();
      voices.add(voice);
      void voice.ended.then(() => voices.delete(voice));
    } catch {
      // Audio that cannot play: the slides still get their time.
    }
  };
  for (const clip of timeline.clips) {
    if (clip.end > from) at(clip.start, () => void say(clip.slide, Math.max(0, from - clip.start)));
  }
  timeline.slides.forEach((slide, index) => {
    if (slide.start > from) at(slide.start, () => on.slide(index));
  });
  at(timeline.end, on.ended);
  return () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    for (const voice of voices) voice.stop();
  };
}
