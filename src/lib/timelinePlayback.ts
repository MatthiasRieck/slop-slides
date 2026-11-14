import { type Playback, playNarration } from "./narrationAudio";
import type { Timeline } from "./timeline";

/** What a playing timeline tells. */
export interface TimelineEvents {
  /** It got to the slide at this index of the timeline's. */
  slide: (index: number) => void;
  /** It reached its end. */
  ended: () => void;
  /**
   * Where it is, in seconds, about every {@link TICK} ms while it plays: often enough to keep a
   * slide's animations and a clock of one's own (see ./playbackClock.ts) with it. What must move
   * every frame follows such a clock, not this.
   */
  tick?: (time: number) => void;
}

/** How often a playing timeline tells where it is, in ms. */
export const TICK = 100;

/** The rates the timeline plays at, slowest first: 1 is as recorded. */
export const PLAYBACK_RATES = [1, 1.5, 2] as const;

/** The next rate up from `rate`, round to the first after the fastest. */
export function nextRate(rate: number): number {
  return PLAYBACK_RATES.find((r) => r > rate) ?? PLAYBACK_RATES[0];
}

/**
 * Plays `timeline` from `from` seconds on one clock: each slide at its time, and each slide's
 * narration at its time, from where it has got to if it already started, whichever slide is
 * showing. Audio that takes a while to load starts where the clock is by then, so it keeps
 * with the slides. At a `rate` other than 1 all of it goes that much faster, the voices too.
 * Gives back how to stop it.
 */
export function playTimeline(deck: string, timeline: Timeline, from: number, on: TimelineEvents, rate = 1): () => void {
  let stopped = false;
  const voices = new Set<Playback>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const started = performance.now();
  const now = () => from + ((performance.now() - started) / 1000) * rate;
  const at = (seconds: number, run: () => void) => {
    timers.push(setTimeout(run, Math.max(0, ((seconds - from) * 1000) / rate)));
  };
  const say = async (slide: string, start: number) => {
    try {
      const voice = await playNarration(deck, slide, () => now() - start, rate);
      if (stopped) return voice.stop();
      voices.add(voice);
      void voice.ended.then(() => voices.delete(voice));
    } catch {
      // Audio that cannot play: the slides still get their time.
    }
  };
  for (const clip of timeline.clips) {
    if (clip.end > from) at(clip.start, () => void say(clip.slide, clip.start));
  }
  timeline.slides.forEach((slide, index) => {
    if (slide.start > from) at(slide.start, () => on.slide(index));
  });
  // The last tick is at the end, before it ends; none follows, though one may be due at the
  // same moment: the caller clears what ticks set (the slide clock) as it ends, and stops this
  // only after it rendered again.
  let ended = false;
  at(timeline.end, () => {
    ended = true;
    if (ticking) clearInterval(ticking);
    on.tick?.(timeline.end);
    on.ended();
  });
  const ticking =
    on.tick &&
    setInterval(() => {
      if (!stopped && !ended) on.tick?.(Math.min(now(), timeline.end));
    }, TICK);
  on.tick?.(from);
  return () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    if (ticking) clearInterval(ticking);
    for (const voice of voices) voice.stop();
  };
}
