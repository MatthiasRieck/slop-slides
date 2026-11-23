import { type ComponentProps, type ReactNode, useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { stepNumber } from "@/lib/arrange";
import { isMod } from "@/lib/keys";
import { cn } from "@/lib/utils";

/**
 * A number to type that applies on Enter or when the field loses focus; Escape puts the value
 * back. ↑ and ↓ take it one up or down (ten with Shift) and apply that at once, the focus staying
 * in the field for the next step. Keystrokes pass through `sanitize`, and only a text `parse`
 * takes, that differs from the value, is applied. Enter and Escape also call `onDone`, to hand
 * focus back. With a `tooltip` it says what it is for under the pointer, also while it is disabled.
 */
export function DraftInput(
  props: Omit<ComponentProps<typeof Input>, "value" | "onChange" | "onBlur" | "onKeyDown" | "title"> & {
    value: number | null;
    parse: (text: string) => number | null;
    sanitize: (text: string) => string;
    onChange: (value: number) => void;
    onDone: () => void;
    tooltip?: ReactNode;
  },
) {
  const { value, parse, sanitize, onChange, onDone, tooltip, className, ...rest } = props;
  const shown = value === null ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const apply = () => {
    const next = parse(draft);
    if (next === null || next === value) setDraft(shown);
    else onChange(next);
  };
  /** Steps from what is typed (or, when that is no number, from the value) and applies the result. */
  const step = (direction: 1 | -1, large: boolean) => {
    const from = parse(draft) ?? value;
    const next = from === null ? null : parse(String(stepNumber(from, direction, large)));
    if (next === null) return;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  const input = (
    <Input
      type="text"
      inputMode="numeric"
      placeholder="–"
      {...rest}
      // The ribbon's own height, which `className` sets with the width.
      className={cn("h-6 rounded-md px-1 py-0 text-xs tabular-nums", className)}
      value={draft}
      onFocus={(event) => {
        rest.onFocus?.(event);
        // The tooltip is for the pointer: it does not stay up for as long as the field is typed in.
        if (tooltip) event.stopPropagation();
      }}
      onChange={(event) => setDraft(sanitize(event.target.value))}
      onBlur={apply}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          apply();
          onDone();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setDraft(shown);
          onDone();
        } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.altKey && !isMod(event)) {
          event.preventDefault();
          step(event.key === "ArrowUp" ? 1 : -1, event.shiftKey);
        }
      }}
    />
  );
  if (!tooltip) return input;
  return (
    <Tooltip>
      {/* A disabled field takes no pointer, so the tooltip is of the box around it. */}
      <TooltipTrigger render={<span className="inline-flex" />}>{input}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
