/**
 * Changes to the open deck file (slide edits, rail changes, undo, …) are saved one after another,
 * each based on the previous one's result. A change that fails does not hold up the ones after it.
 */
let queue: Promise<void> = Promise.resolve();

/** Runs `change` once the changes queued before it are done, resolving to its result (rejecting when it fails). */
export function queueEdit<T>(change: () => Promise<T>): Promise<T> {
  const done = queue.then(change);
  // The queue only waits for the change to settle; its failure is the caller's to handle.
  queue = done.then(
    () => undefined,
    () => undefined,
  );
  return done;
}

/** Resolves once every change queued so far has settled, whether it was saved or failed. */
export function editsSaved(): Promise<void> {
  return queue;
}
