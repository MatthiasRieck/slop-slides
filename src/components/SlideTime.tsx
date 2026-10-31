import { Timer } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Deck } from "../lib/api";
import { parseTime } from "../lib/slideTime";
import { useApp } from "../store";
import { formatElapsed } from "./PresenterPanel";

const asText = (seconds: number | undefined) => (seconds ? formatElapsed(seconds * 1000) : "");

/**
 * View mode's field for the time the presenter expects to spend on the selected slide, which
 * the presenter view counts down, and what the times of the slides shown add up to.
 */
export function SlideTime({ deck }: { deck: Deck }) {
  const selected = useApp((s) => s.selected);
  const slide = deck.slides.find((s) => s.id === selected);
  const [draft, setDraft] = useState(asText(slide?.time));
  // Escape blurs the field, and blur commits; this keeps that blur from saving the edit.
  const cancelled = useRef(false);
  useEffect(() => setDraft(asText(slide?.time)), [slide?.time]);
  const total = deck.slides.reduce((sum, s) => sum + (s.hidden ? 0 : (s.time ?? 0)), 0);
  if (!slide) return null;

  const commit = () => {
    const seconds = parseTime(draft);
    if (cancelled.current || seconds === null) {
      cancelled.current = false;
      return setDraft(asText(slide.time));
    }
    if (seconds !== (slide.time ?? 0)) void useApp.getState().setSlideTime(slide.id, seconds);
  };

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Timer className="size-3.5" />
      <input
        key={slide.id}
        value={draft}
        disabled={slide.locked}
        placeholder="m:ss"
        aria-label="Expected time for this slide"
        title={
          slide.locked
            ? "This slide is locked; unlock it in the slide list to change its time"
            : "How long you expect to spend on this slide, like 1:30 or 2 (minutes). The presenter view counts it down."
        }
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            cancelled.current = true;
            event.currentTarget.blur();
          }
        }}
        className="w-12 rounded-md bg-transparent px-1.5 py-1 text-foreground tabular-nums outline-none hover:bg-accent focus:bg-accent disabled:opacity-50"
      />
      {total > 0 && (
        <span data-testid="deck-time" title="The expected times of all slides shown" className="tabular-nums">
          of {formatElapsed(total * 1000)}
        </span>
      )}
    </div>
  );
}
