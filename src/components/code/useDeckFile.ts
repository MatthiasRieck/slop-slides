import { useEffect, useMemo, useRef, useState } from "react";

import { type Deck, errorMessage } from "../../lib/api";
import { normalizeNewlines } from "../../lib/codeSync";
import { basename, fileUrl } from "../../lib/utils";

/**
 * The deck file's text as last read from disk. While `active` it is read again whenever the
 * file's markup changes; otherwise nothing is read, however often the file changes, and it
 * catches up with one read when `active` again.
 */
export function useDeckFile(deck: Deck | null, active: boolean) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deckId = deck?.id;
  // Any change to the document's markup changes one of these. Section markers are not part of
  // the shell or slide hashes (so renaming one does not reload previews); they count here.
  const version = useMemo(
    () =>
      deck ? `${deck.shellHash}.${deck.slides.map((s) => s.hash).join(".")}.${JSON.stringify(deck.sections)}` : "",
    [deck],
  );
  /** The file and version last read, or being read: showing the tab again does not read it twice. */
  const read = useRef<string | null>(null);

  useEffect(() => {
    if (!deckId || !active) return;
    const wanted = `${deckId}\n${version}`;
    if (read.current === wanted) return;
    read.current = wanted;
    let settled = false;
    let cancelled = false;
    fetch(fileUrl(deckId, `v=${encodeURIComponent(version)}`), { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`Could not read ${basename(deckId)} (${res.status})`);
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        setSource(normalizeNewlines(text));
        setError(null);
      })
      .catch((err) => !cancelled && setError(errorMessage(err)))
      .finally(() => {
        settled = true;
      });
    return () => {
      cancelled = true;
      // Given up before it answered: the file is still to be read.
      if (!settled && read.current === wanted) read.current = null;
    };
  }, [deckId, version, active]);

  return { source, error };
}
