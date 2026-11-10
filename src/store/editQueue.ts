/**
 * Changes to the open deck file (slide edits, rail changes, undo, …) are saved one after another,
 * each based on the previous one's result.
 */
let queue: Promise<unknown> = Promise.resolve();

/** Runs `change` once the changes queued before it are done, resolving to its result. */
export function queueEdit<T>(change: () => Promise<T>): Promise<T> {
  const done = queue.then(change);
  queue = done;
  return done;
}

/** Resolves once every change queued so far is done. */
export function editsSaved(): Promise<unknown> {
  return queue;
}
