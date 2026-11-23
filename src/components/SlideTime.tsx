import { Timer } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { quietFocus } from "@/lib/focus";
import type { Deck } from "../lib/api";
import { parseTime } from "../lib/slideTime";
import { useApp } from "../store";
import { formatElapsed } from "./presenter/time";

const asText = (seconds: number | undefined) => (seconds ? formatElapsed(seconds * 1000) : "");

/**
 * The Narration tab's field for the time the presenter plans to spend on the selected slide, which
 * the presenter view counts down, and what the planned times of the slides shown add up to.
 * What is typed and is no time stays in the field, marked as that, until it is put right or
 * Escape takes it back: nothing is thrown away unseen.
 */
export function SlideTime({ deck }: { deck: Deck }) {
  const selected = useApp((s) => s.selected);
  const slide = deck.slides.find((s) => s.id === selected);
  const [draft, setDraft] = useState(asText(slide?.time));
  // Escape blurs the field, and blur commits; this keeps that blur from saving the edit.
  const cancelled = useRef(false);
  // What was typed is no time; said until it is typed over.
  const [invalid, setInvalid] = useState(false);
  const id = useId();
  const problemId = `${id}-problem`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Another slide has another time, even an equal one.
  useEffect(() => {
    setDraft(asText(slide?.time));
    setInvalid(false);
  }, [slide?.id, slide?.time]);
  const total = deck.slides.reduce((sum, s) => sum + (s.hidden ? 0 : (s.time ?? 0)), 0);
  if (!slide) return null;

  const commit = () => {
    const seconds = parseTime(draft);
    if (cancelled.current) {
      cancelled.current = false;
      setInvalid(false);
      return setDraft(asText(slide.time));
    }
    if (seconds === null) return setInvalid(true);
    if (seconds !== (slide.time ?? 0)) void useApp.getState().setSlideTime(slide.id, seconds);
  };

  return (
    <div className="relative flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Label htmlFor={id} className="gap-1.5 text-xs font-normal">
        <Timer className="size-3.5" />
        Planned time
      </Label>
      <Tooltip>
        {/* The tooltip is the wrapper's: a locked slide's field is disabled, and nothing under the pointer. */}
        <TooltipTrigger render={<span />}>
          <Input
            key={slide.id}
            id={id}
            size="sm"
            value={draft}
            disabled={slide.locked}
            placeholder="m:ss"
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? problemId : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
            // The hint is for the pointer: it does not open over the field while a time is typed.
            onFocus={quietFocus}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                cancelled.current = true;
                event.currentTarget.blur();
              }
            }}
            className="h-6 w-14 text-foreground tabular-nums"
          />
        </TooltipTrigger>
        <TooltipContent>
          {slide.locked
            ? "This slide is locked; unlock it in the slide list to change its time"
            : "How long you plan to spend on this slide, like 1:30 or 2 (minutes). The presenter view counts it down."}
        </TooltipContent>
      </Tooltip>
      {total > 0 && (
        <span data-testid="deck-time" title="The planned times of all slides shown, added up" className="tabular-nums">
          of {formatElapsed(total * 1000)} planned
        </span>
      )}
      {invalid && (
        <FieldError
          id={problemId}
          className="absolute top-full right-0 z-10 mt-1 whitespace-nowrap rounded-md border bg-card px-2 py-1 text-xs shadow-md"
        >
          Type a time like 1:30, or minutes like 2. Esc puts the old time back.
        </FieldError>
      )}
    </div>
  );
}
