// The order slide previews load in. Every live thumbnail is a document of its own; started all
// at once (a deck opening, a style change reloading every slide) they compete with the slide on
// the stage and with each other. So thumbnails load a few at a time, the ones in view first, and
// wait while the stage's own slide is loading. Pictures of slides (see ../components/SlideImage.tsx)
// cost the window little to show, so more of them load at once and they do not wait for the stage;
// they still go in view first, as the backend makes the ones it has not got one at a time.

/** How many thumbnails load at the same time. */
export const MAX_FRAME_LOADS = 3;

/** How many pictures of slides load at the same time. */
export const MAX_PICTURE_LOADS = 6;

/**
 * How long a load counts at most. A document that never says it loaded must not keep the others
 * waiting for good.
 */
export const FRAME_LOAD_LIMIT = 4000;

/**
 * How long a picture's load counts at most: one the backend has to make first takes a while, and
 * the others in view wait their turn behind it there anyway.
 */
export const PICTURE_LOAD_LIMIT = 15000;

interface Waiting {
  /** Its turn has come; it calls `done` when it has loaded. */
  start: (done: () => void) => void;
  /** In view, so before the ones that are only near it. */
  urgent: boolean;
}

/** Calls `end` when `done` is called or `limit` ms have passed, whichever is first, and only once. */
function ending(end: () => void, limit: number) {
  let ended = false;
  const done = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    end();
  };
  const timer = setTimeout(done, limit);
  return done;
}

/** Loads that take turns: at most `max` at once, the urgent ones first, none while held. */
class LoadQueue {
  private loading = 0;
  private holds = 0;
  private readonly waiting: Waiting[] = [];

  constructor(
    private readonly max: number,
    private readonly limit: number,
  ) {}

  private next() {
    while (this.holds === 0 && this.loading < this.max && this.waiting.length > 0) {
      const at = Math.max(
        this.waiting.findIndex((load) => load.urgent),
        0,
      );
      const [load] = this.waiting.splice(at, 1);
      this.loading++;
      load!.start(
        ending(() => {
          this.loading--;
          this.next();
        }, this.limit),
      );
    }
  }

  queue(start: (done: () => void) => void, urgent: boolean): () => void {
    const load: Waiting = { start, urgent };
    this.waiting.push(load);
    this.next();
    return () => {
      const at = this.waiting.indexOf(load);
      if (at >= 0) this.waiting.splice(at, 1);
    };
  }

  hold(): () => void {
    this.holds++;
    return ending(() => {
      this.holds--;
      this.next();
    }, this.limit);
  }
}

const frames = new LoadQueue(MAX_FRAME_LOADS, FRAME_LOAD_LIMIT);
const pictures = new LoadQueue(MAX_PICTURE_LOADS, PICTURE_LOAD_LIMIT);

/**
 * Asks for a thumbnail to load: `start` is called when it is its turn (at once when there is
 * room), with what to call once the thumbnail has loaded or is given up. Returns how to take the
 * request back while it still waits.
 */
export function queueFrameLoad(start: (done: () => void) => void, urgent: boolean): () => void {
  return frames.queue(start, urgent);
}

/**
 * Keeps thumbnails from starting to load while a slide the user is looking at loads. Call what
 * this returns when it has.
 */
export function holdFrameLoads(): () => void {
  return frames.hold();
}

/** Asks for a picture of a slide to load, as {@link queueFrameLoad} does for a thumbnail. */
export function queuePictureLoad(start: (done: () => void) => void, urgent: boolean): () => void {
  return pictures.queue(start, urgent);
}
