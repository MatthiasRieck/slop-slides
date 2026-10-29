import { Lock } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Slide } from "../lib/api";
import { normalizeNarration, speakingTime, wordCount } from "../lib/narration";
import { useApp } from "../store";

/** How long typing pauses before the narration is saved to the deck. */
export const NARRATION_SAVE_DELAY = 800;

/** The sidebar's narration tab: what is said over the current slide, to view and edit. */
export function NarrationPanel() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const index = deck?.slides.findIndex((s) => s.id === selected) ?? -1;
  const slide = deck?.slides[index];
  if (!deck || !slide) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {deck ? "Add a slide to write its narration." : "Open a deck to write narration for its slides."}
      </p>
    );
  }
  // One editor per slide: switching slides saves the last one's pending text as it unmounts.
  return <NarrationEditor key={slide.id} slide={slide} index={index} total={deck.slides.length} />;
}

function NarrationEditor(props: { slide: Slide; index: number; total: number }) {
  const { slide, index, total } = props;
  const saved = slide.narration ?? "";
  const [draft, setDraft] = useState(saved);
  const draftRef = useRef(saved);
  /** Typed but not saved yet. */
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Changed elsewhere (the agent, the HTML view): show it, unless the user is typing over it.
  useEffect(() => {
    if (dirty.current || normalizeNarration(draftRef.current) === saved) return;
    draftRef.current = saved;
    setDraft(saved);
  }, [saved]);

  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    void useApp.getState().setNarration(slide.id, draftRef.current);
  }, [slide.id]);
  useEffect(() => flush, [flush]);

  const change = (text: string) => {
    draftRef.current = text;
    setDraft(text);
    dirty.current = true;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, NARRATION_SAVE_DELAY);
  };

  const words = wordCount(draft);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          Slide {index + 1} of {total} · <span className="font-mono">{slide.id}</span>
        </span>
        {slide.locked && (
          <span className="flex shrink-0 items-center gap-1">
            <Lock className="size-3" />
            Locked
          </span>
        )}
      </div>
      <textarea
        aria-label="Narration"
        value={draft}
        readOnly={slide.locked}
        onChange={(event) => change(event.target.value)}
        onBlur={flush}
        placeholder={slide.locked ? "No narration." : "What is said while this slide is shown…"}
        className="selectable min-h-0 flex-1 resize-none rounded-md border bg-card p-3 text-sm leading-relaxed outline-none focus:border-primary"
      />
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>
          {words} {words === 1 ? "word" : "words"}
        </span>
        <span title="Estimated at 150 words per minute">~{speakingTime(draft)}</span>
      </div>
    </div>
  );
}
