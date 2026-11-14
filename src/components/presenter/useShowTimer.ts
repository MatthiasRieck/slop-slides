import { useState } from "react";

import { pauseWatch, resumeWatch, type Stopwatch, startWatch } from "./time";

/** The show's clocks: how long it has run, and how long the slide on screen has been up. */
export interface ShowTimer {
  show: Stopwatch;
  slide: Stopwatch;
  /** Whether they run yet: they start as the show first moves on, or when asked to. */
  started: boolean;
  paused: boolean;
  /** Starts both clocks, stops them, or lets them run on from where they stopped. */
  toggle: () => void;
  /** Starts both over, running. */
  restart: () => void;
}

/**
 * The time of a show and of the slide on screen (`slide`, as the player reports it). Both start
 * as the show first moves to another slide, so the time the opening slide waits for the talk to
 * begin is not counted, or when the presenter starts them. Each slide's time starts when it comes
 * on screen. Pausing stops both, and they run on from there. It lasts as long as the show,
 * whether or not the presenter view that displays it is open.
 */
export function useShowTimer(slide: string | null): ShowTimer {
  const [watches, setWatches] = useState(() => ({ show: startWatch(0, true), slide: startWatch(0, true) }));
  const [started, setStarted] = useState(false);
  // The slide on screen as last seen; the first one known is where the show opened.
  const [shown, setShown] = useState(slide);
  const paused = started && watches.show.since === null;
  if (shown !== slide) {
    setShown(slide);
    const now = Date.now();
    if (started) {
      // Another slide came on screen: its time starts, stopped if the show's is.
      setWatches({ ...watches, slide: startWatch(now, paused) });
    } else if (shown !== null) {
      // The first move: the talk is under way.
      setStarted(true);
      setWatches({ show: startWatch(now), slide: startWatch(now) });
    }
  }
  const restart = () => {
    const now = Date.now();
    setStarted(true);
    setWatches({ show: startWatch(now), slide: startWatch(now) });
  };

  return {
    ...watches,
    started,
    paused,
    toggle: () => {
      if (!started) return restart();
      const now = Date.now();
      const change = paused ? resumeWatch : pauseWatch;
      setWatches({ show: change(watches.show, now), slide: change(watches.slide, now) });
    },
    restart,
  };
}
