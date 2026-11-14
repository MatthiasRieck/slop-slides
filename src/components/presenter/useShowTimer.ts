import { useState } from "react";

import { pauseWatch, resumeWatch, type Stopwatch, startWatch } from "./time";

/** The show's clocks: how long it has run, and how long the slide on screen has been up. */
export interface ShowTimer {
  show: Stopwatch;
  slide: Stopwatch;
  paused: boolean;
  /** Stops both clocks, or lets them run on from where they stopped. */
  toggle: () => void;
  /** Starts both over, running. */
  restart: () => void;
}

/**
 * The time of a show and of the slide on screen (`slide`, as the player reports it). Each slide's
 * time starts when it comes on screen. Pausing stops both, and they run on from there. It lasts
 * as long as the show, whether or not the presenter view that displays it is open.
 */
export function useShowTimer(slide: string | null): ShowTimer {
  const [watches, setWatches] = useState(() => {
    const now = Date.now();
    return { show: startWatch(now), slide: startWatch(now) };
  });
  const [shown, setShown] = useState(slide);
  // Another slide came on screen: its time starts, stopped if the show's is.
  const paused = watches.show.since === null;
  if (shown !== slide) {
    setShown(slide);
    setWatches({ ...watches, slide: startWatch(Date.now(), paused) });
  }

  return {
    ...watches,
    paused,
    toggle: () => {
      const now = Date.now();
      const change = paused ? resumeWatch : pauseWatch;
      setWatches({ show: change(watches.show, now), slide: change(watches.slide, now) });
    },
    restart: () => {
      const now = Date.now();
      setWatches({ show: startWatch(now), slide: startWatch(now) });
    },
  };
}
