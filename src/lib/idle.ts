// Work that can wait for the browser to have nothing better to do, such as loading the parts of
// the app the first screen does not show.

/** How long to wait where the browser cannot say when it is idle (WebKit). */
const IDLE_FALLBACK_MS = 200;

/** Runs `run` when the browser is next idle. Returns what calls it off. */
export function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run);
    return () => window.cancelIdleCallback(id);
  }
  const timer = setTimeout(run, IDLE_FALLBACK_MS);
  return () => clearTimeout(timer);
}

/**
 * Runs `tasks` in order, each once the browser is idle after the one before is done, so that
 * none of them holds up a frame the user is waiting for. A task that fails does not stop the
 * rest. Returns what calls off the tasks not started yet.
 */
export function preloadWhenIdle(tasks: readonly (() => Promise<unknown>)[]): () => void {
  let cancel = () => {};
  let stopped = false;
  const next = (index: number) => {
    const task = tasks[index];
    if (!task || stopped) return;
    cancel = whenIdle(() => {
      const after = () => next(index + 1);
      task().then(after, after);
    });
  };
  next(0);
  return () => {
    stopped = true;
    cancel();
  };
}
