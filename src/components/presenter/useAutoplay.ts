import { useEffect, useRef, useState } from "react";

import type { Deck } from "../../lib/api";
import { setSlideClock } from "../../lib/slideClock";
import { layoutTimeline, slideAt } from "../../lib/timeline";
import { playTimeline } from "../../lib/timelinePlayback";
import { loadVideoOptions } from "../../lib/video";
import { useNarration } from "../../narrationStore";

/**
 * Runs the show by itself while playing, on the deck's timeline (see `layoutTimeline`), as the
 * timeline under the slide plays it: each slide shows for its time, then `next` moves on, and
 * narration (up-to-date audio only, from the Narration tab) plays at its time, carrying on across
 * slides when it runs over. The narration always plays: leaving it out is a choice about a video
 * export, not about the show. Pausing stops the narration; playing again starts over from the
 * start of the slide, its timed animations too, so they keep with its narration (see
 * `setSlideClock`). Moving to another slide meanwhile goes on from there. The show stops playing
 * after the last slide.
 */
export function useAutoplay(deck: Deck | null, current: string | null, next: () => void) {
  const [playing, setPlaying] = useState(false);
  // Bumped to start over from the slide on screen, when something else moved to it.
  const [from, setFrom] = useState(0);
  const nextRef = useRef(next);
  nextRef.current = next;
  const currentRef = useRef(current);
  currentRef.current = current;
  // The slide the timeline is on; another one on screen means someone else moved the show.
  const onTimeline = useRef<string | null>(null);
  useEffect(() => {
    if (playing && current && current !== onTimeline.current) setFrom((n) => n + 1);
  }, [playing, current]);
  useEffect(() => {
    const slide = currentRef.current;
    onTimeline.current = slide;
    if (!playing || !deck || !slide || from < 0) return;
    const { audio, audioDeck } = useNarration.getState();
    const shown = deck.slides.filter((s) => !s.hidden);
    const spoken = Object.fromEntries(
      shown.map((s) => {
        const said = audioDeck === deck.id && audio[s.id]?.state === "ready";
        return [s.id, said ? (audio[s.id]?.seconds ?? null) : null];
      }),
    );
    const timeline = layoutTimeline(shown, spoken, { ...loadVideoOptions(), narration: true });
    const start = timeline.slides.find((s) => s.id === slide)?.start;
    // A hidden slide has no place on the timeline.
    if (start === undefined) return void nextRef.current();
    const stop = playTimeline(deck.id, timeline, start, {
      slide: (index) => {
        onTimeline.current = timeline.slides[index]?.id ?? null;
        nextRef.current();
      },
      ended: () => setPlaying(false),
      // From the start of the slide on screen: its animations start over with its narration.
      tick: (time) => {
        const shown = timeline.slides[slideAt(timeline, time)];
        if (shown) setSlideClock({ slide: shown.id, at: time - shown.start });
      },
    });
    return () => {
      stop();
      // Paused, the slide's animations run on their own.
      setSlideClock(null);
    };
  }, [playing, deck, from]);
  // Leaving the show lets the slides run on their own again.
  useEffect(() => () => setSlideClock(null), []);
  return { playing, toggle: () => setPlaying((p) => !p) };
}
