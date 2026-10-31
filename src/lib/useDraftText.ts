import { useCallback, useEffect, useRef, useState } from "react";

import { normalizeNarration } from "./narration";

/**
 * Text typed into a slide's narration or notes, saved once typing pauses for `delay` ms. Mount
 * one per slide: it saves the last one's pending text as it unmounts.
 */
export function useDraftText(saved: string, delay: number, save: (text: string) => Promise<void>) {
  const [draft, setDraft] = useState(saved);
  const draftRef = useRef(saved);
  const saveRef = useRef(save);
  saveRef.current = save;
  /** Typed but not saved yet. */
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Changed elsewhere (the agent, the HTML view): show it, unless the user is typing over it.
  useEffect(() => {
    if (dirty.current || normalizeNarration(draftRef.current) === saved) return;
    draftRef.current = saved;
    setDraft(saved);
  }, [saved]);

  const flush = useCallback(async () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    await saveRef.current(draftRef.current);
  }, []);
  useEffect(
    () => () => {
      void flush();
    },
    [flush],
  );

  const change = (text: string) => {
    draftRef.current = text;
    setDraft(text);
    dirty.current = true;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delay);
  };

  return { draft, change, flush };
}
