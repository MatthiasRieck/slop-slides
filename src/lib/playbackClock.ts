/**
 * Where something that plays is, in seconds: standing at a moment, or running on from one with
 * the time. It is no React state, so that what follows it (a playhead, a time readout) can move
 * every frame without anything around it rendering: a follower listens and reads the time itself.
 *
 * Running, the time is worked out from `performance.now()` whenever it is asked for, so it is
 * exact between frames too. What really plays (see `playTimeline`) is the authority, and sets the
 * clock right as it goes (`sync`).
 */
export interface PlaybackClock {
  /** Where it is now. */
  time: () => number;
  running: () => boolean;
  /** Where it last stood or started running from: this changes only when `onChange` tells. */
  rest: () => number;
  /** Stands at `at`. */
  stopAt: (at: number) => void;
  /** Runs on from `at`, starting now. */
  runFrom: (at: number) => void;
  /** Says a running clock is at `at` now, as what plays has it; a standing one stays. */
  sync: (at: number) => void;
  /** Calls `listener` every animation frame while it runs, and whenever it is set; gives back how to stop. */
  onFrame: (listener: () => void) => () => void;
  /** Calls `listener` when it is stopped or started somewhere, not as it runs; gives back how to stop. */
  onChange: (listener: () => void) => () => void;
}

export function createPlaybackClock(): PlaybackClock {
  // Standing: where. Running: where it was at `since`, a `performance.now()`.
  let at = 0;
  let since: number | null = null;
  let rest = 0;
  let frame: number | null = null;
  const frames = new Set<() => void>();
  const changes = new Set<() => void>();

  const tell = (listeners: Set<() => void>) => {
    for (const listener of [...listeners]) listener();
  };
  // Frames are only asked for while it runs and someone follows it.
  const schedule = () => {
    const wanted = since !== null && frames.size > 0;
    if (wanted && frame === null) frame = requestAnimationFrame(tick);
    else if (!wanted && frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
  };
  const tick = () => {
    frame = null;
    schedule();
    tell(frames);
  };
  const set = (to: number, runs: boolean) => {
    at = to;
    rest = to;
    since = runs ? performance.now() : null;
    schedule();
    tell(frames);
    tell(changes);
  };

  return {
    time: () => (since === null ? at : at + (performance.now() - since) / 1000),
    running: () => since !== null,
    rest: () => rest,
    stopAt: (to) => set(to, false),
    runFrom: (from) => set(from, true),
    sync: (to) => {
      if (since === null) return;
      at = to;
      since = performance.now();
      tell(frames);
    },
    onFrame: (listener) => {
      frames.add(listener);
      schedule();
      return () => {
        frames.delete(listener);
        schedule();
      };
    },
    onChange: (listener) => {
      changes.add(listener);
      return () => changes.delete(listener);
    },
  };
}

/**
 * The `transform` that puts a playhead `fraction` (0 to 1) of the way along its track. The
 * playhead is the right edge of a sheet as wide as the track, lying just left of it: a transform's
 * percentage is of the element's own width, so the sheet slid in by that part of itself has its
 * edge at that part of the track, at any zoom, with nothing measured and nothing laid out again.
 */
export function playheadTransform(fraction: number): string {
  return `translateX(${Math.min(1, Math.max(0, fraction)) * 100}%)`;
}
