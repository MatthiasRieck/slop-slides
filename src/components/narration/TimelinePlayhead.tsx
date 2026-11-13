import { type RefObject, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { formatDuration } from "../../lib/narration";
import { type PlaybackClock, playheadTransform } from "../../lib/playbackClock";
import { formatTenths, scrollToPlayhead } from "../../lib/timeline";

// What shows where the timeline's playhead is. Each follows the clock by itself (see
// ../../lib/playbackClock.ts): while the deck plays, the playhead moves every frame and the time
// counts on, and the tracks around them are not rendered again for it.

/**
 * Something told by where the playhead is, rendered again only when `pick` gives another answer
 * for the time: a text, a number or a yes or no, not an object made anew each time.
 */
export function usePlayheadValue<T extends string | number | boolean>(
  clock: PlaybackClock,
  pick: (time: number) => T,
): T {
  return useSyncExternalStore(clock.onFrame, () => pick(clock.time()));
}

/**
 * The playhead: a line across the tracks with its head on the ruler, `limit` seconds at most
 * along a track `end` seconds long. It is moved by a transform set on the element itself, every
 * frame while the deck plays: nothing is rendered or laid out for it.
 */
export function Playhead({ clock, limit, end }: { clock: PlaybackClock; limit: number; end: number }) {
  const sheet = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const at = end > 0 ? Math.min(clock.time(), limit) / end : 0;
      if (sheet.current) sheet.current.style.transform = playheadTransform(at);
    };
    place();
    return clock.onFrame(place);
  }, [clock, limit, end]);
  return (
    // As wide as the track and just left of it: see `playheadTransform`.
    <div ref={sheet} data-testid="playhead" className="pointer-events-none absolute inset-y-0 right-full z-20 w-full">
      <div className="absolute inset-y-0 left-full w-px bg-destructive">
        {/* Its head, on the ruler. */}
        <span className="absolute top-0 -left-1 h-2.5 w-[9px] rounded-b-full bg-destructive" />
      </div>
    </div>
  );
}

/**
 * The time at the playhead (`limit` at most) of `total`. Stopped, to the tenth: that is what a
 * step changes. Playing, in whole seconds, so it is written anew once a second.
 */
export function TimeReadout(props: { clock: PlaybackClock; limit: number; total: number; playing: boolean }) {
  const { clock, limit, playing } = props;
  const format = playing ? formatDuration : formatTenths;
  const now = usePlayheadValue(clock, (time) => format(Math.min(time, limit)));
  return (
    <span data-testid="timeline-time" className="tabular-nums text-muted-foreground">
      {now} / {formatDuration(props.total)}
    </span>
  );
}

/**
 * Zoomed in, the track is wider than the panel: while the deck plays, `scroller` scrolls on with
 * the playhead, a page at a time (see `scrollToPlayhead`). `track` and `view` are how wide the
 * track is and how much of it is in sight, in pixels; `limit` and `end` as for the `Playhead`.
 */
export function useFollowPlayhead(
  clock: PlaybackClock,
  scroller: RefObject<HTMLElement | null>,
  following: boolean,
  measures: { track: number; view: number; limit: number; end: number },
) {
  const { track, view, limit, end } = measures;
  useEffect(() => {
    if (!following || !(end > 0)) return;
    const follow = () => {
      const box = scroller.current;
      if (!box) return;
      const to = scrollToPlayhead(track * (Math.min(clock.time(), limit) / end), box.scrollLeft, view);
      if (to !== box.scrollLeft) box.scrollLeft = to;
    };
    follow();
    return clock.onFrame(follow);
  }, [clock, scroller, following, track, view, limit, end]);
}
