import { useEffect, useState } from "react";

import type { Deck } from "../../lib/api";
import { setSlideClock } from "../../lib/slideClock";
import { slideAt, type Timeline } from "../../lib/timeline";
import { playTimeline } from "../../lib/timelinePlayback";
import { useApp } from "../../store";

/**
 * The playhead of the deck's `timeline` and playing it from there, the stage following along:
 * `play` plays (or, while it plays, pauses), `freeze` stops at a moment, the slide on the
 * stage frozen as it is then, its timed animations that far in, and `goToSlide` moves to where a
 * slide starts, so that Play plays from the slide picked. A changed deck stops it, and so
 * does leaving. While `editing`, the stage is only taken to play: stopped, it stays the editor's,
 * showing the slide's final state, whatever moment the playhead is at.
 */
export function useTimelinePlayback(deck: Deck, timeline: Timeline, editing = false) {
  const [time, setTime] = useState(0);
  const [stop, setStop] = useState<(() => void) | null>(null);
  const playing = stop !== null;

  // Replacing what stops it stops it, and so does leaving.
  useEffect(() => stop ?? undefined, [stop]);
  // A changed deck has another timeline than the one playing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs on every change of the deck.
  useEffect(() => {
    setStop(null);
    setSlideClock(null);
  }, [deck]);
  useEffect(() => () => setSlideClock(null), []);
  // Entering edit mode hands a frozen stage to the editor; leaving it, the stage is at the playhead again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a change of mode moves the stage.
  useEffect(() => {
    if (playing) return;
    const slide = timeline.slides[slideAt(timeline, time)];
    if (editing || time <= 0 || slide?.id !== useApp.getState().selected) setSlideClock(null);
    else clockAt(time, true);
  }, [editing]);

  /** Puts the slide showing at `at` (and its timed animations) where the timeline is then; `paused`, they stay there. */
  const clockAt = (at: number, paused = false) => {
    const slide = timeline.slides[slideAt(timeline, at)];
    setSlideClock(slide ? { slide: slide.id, at: at - slide.start, ...(paused && { paused }) } : null);
  };
  /** Selects the slide at `index` of the timeline. */
  const select = (index: number) => {
    const slide = timeline.slides[index];
    if (slide) useApp.getState().select(slide.id);
  };
  /** Stops at `at`, the stage showing that moment and staying on it. */
  const freeze = (at: number) => {
    const to = Math.min(timeline.end, Math.max(0, at));
    setStop(null);
    setTime(to);
    select(slideAt(timeline, to));
    if (editing) setSlideClock(null);
    else clockAt(to, true);
  };
  /** Plays from `from` (the start, at the end), the stage following along. */
  const playFrom = (at: number) => {
    const from = at >= timeline.end ? 0 : Math.max(0, at);
    setTime(from);
    select(slideAt(timeline, from));
    const stopping = playTimeline(deck.id, timeline, from, {
      slide: select,
      tick: (at) => {
        setTime(at);
        clockAt(at);
      },
      ended: () => {
        setStop(null);
        setTime(0);
        setSlideClock(null);
      },
    });
    setStop(() => stopping);
  };
  const play = () => (stop ? freeze(time) : playFrom(time));
  /**
   * Goes to the start of the slide at `index`: playing, it plays on from there; stopped, the
   * playhead waits there with the slide selected and showing as it does anywhere else, its
   * animations running, rather than frozen before the first of them.
   */
  const goToSlide = (index: number) => {
    const slide = timeline.slides[index];
    if (!slide) return;
    if (stop) return playFrom(slide.start);
    setTime(slide.start);
    select(index);
    setSlideClock(null);
  };

  return { time, playing, play, freeze, select, goToSlide };
}
