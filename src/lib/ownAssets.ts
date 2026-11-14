/**
 * How long after the app wrote an asset a change to that file is taken to be that write. The
 * file watcher tells of it a moment later, and may tell twice (made, then written).
 */
const OWN_WRITE_WINDOW = 2000;

/** When the app wrote each asset, by deck and the asset's path in the deck's folder. */
const written = new Map<string, number>();

const keyOf = (deckId: string, ref: string) => `${deckId}\n${ref}`;

/**
 * Remembers that the app itself just wrote the assets `refs` (`assets/…`, as the backend names
 * them) of deck `deckId`, and hands them back. A file the app just made is in no slide yet, so
 * its appearing needs no preview loaded again (see `wroteAsset`).
 */
export function noteAssetsWritten(deckId: string, refs: string[]): string[] {
  const now = Date.now();
  for (const [key, at] of written) if (now - at > OWN_WRITE_WINDOW) written.delete(key);
  for (const ref of refs) written.set(keyOf(deckId, ref), now);
  return refs;
}

/** Whether the change to the asset `ref` of deck `deckId` is the app's own write of a moment ago. */
export function wroteAsset(deckId: string, ref: string): boolean {
  const at = written.get(keyOf(deckId, ref));
  return at !== undefined && Date.now() - at <= OWN_WRITE_WINDOW;
}
