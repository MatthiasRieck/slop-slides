// The order slide previews load in. Every thumbnail is a document of its own; started all at once
// (a deck opening, a style change reloading every slide) they compete with the slide on the stage
// and with each other. So thumbnails load a few at a time, the ones in view first, and wait while
// the stage's own slide is loading.

/** How many thumbnails load at the same time. */
export const MAX_FRAME_LOADS = 3;

/**
 * How long a load counts at most. A document that never says it loaded must not keep the others
 * waiting for good.
 */
export const FRAME_LOAD_LIMIT = 4000;

interface Waiting {
  /** Its turn has come; it calls `done` when it has loaded. */
  start: (done: () => void) => void;
  /** In view, so before the ones that are only near it. */
  urgent: boolean;
}

let loading = 0;
let holds = 0;
const waiting: Waiting[] = [];

function next() {
  while (holds === 0 && loading < MAX_FRAME_LOADS && waiting.length > 0) {
    const at = Math.max(
      waiting.findIndex((load) => load.urgent),
      0,
    );
    const [load] = waiting.splice(at, 1);
    loading++;
    load!.start(
      ending(() => {
        loading--;
        next();
      }),
    );
  }
}

/** Calls `end` when `done` is called or the load's time is up, whichever is first, and only once. */
function ending(end: () => void) {
  let ended = false;
  const done = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    end();
  };
  const timer = setTimeout(done, FRAME_LOAD_LIMIT);
  return done;
}

/**
 * Asks for a thumbnail to load: `start` is called when it is its turn (at once when there is
 * room), with what to call once the thumbnail has loaded or is given up. Returns how to take the
 * request back while it still waits.
 */
export function queueFrameLoad(start: (done: () => void) => void, urgent: boolean): () => void {
  const load: Waiting = { start, urgent };
  waiting.push(load);
  next();
  return () => {
    const at = waiting.indexOf(load);
    if (at >= 0) waiting.splice(at, 1);
  };
}

/**
 * Keeps thumbnails from starting to load while a slide the user is looking at loads. Call what
 * this returns when it has.
 */
export function holdFrameLoads(): () => void {
  holds++;
  return ending(() => {
    holds--;
    next();
  });
}
