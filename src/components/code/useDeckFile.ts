import { useEffect, useState } from "react";

import { type Deck, errorMessage } from "../../lib/api";
import { normalizeNewlines } from "../../lib/codeSync";
import { basename, fileUrl } from "../../lib/utils";

/** The deck file's text as last read from disk, read again whenever its markup changes. */
export function useDeckFile(deck: Deck | null) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deckId = deck?.id;
  // Any change to the document's markup changes one of these. Section markers are not part of
  // the shell or slide hashes (so renaming one does not reload previews); they count here.
  const version = deck
    ? `${deck.shellHash}.${deck.slides.map((s) => s.hash).join(".")}.${JSON.stringify(deck.sections)}`
    : "";

  useEffect(() => {
    if (!deckId) return;
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
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [deckId, version]);

  return { source, error };
}
