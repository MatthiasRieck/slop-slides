import { useId, useState } from "react";

import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PopoverHeader, PopoverTitle } from "@/components/ui/popover";

import {
  loadVideoOptions,
  MAX_PAUSE,
  MAX_SECONDS,
  MIN_SECONDS,
  pauseProblem,
  saveVideoOptions,
  secondsProblem,
} from "../../lib/video";

/** A time in seconds to type under its label, kept as the text typed so it can be checked before use. */
function SecondsField(props: {
  label: string;
  "aria-label": string;
  value: string;
  min: number;
  max: number;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Field data-invalid={props.invalid || undefined} className="min-w-0 flex-1 gap-1">
      <FieldLabel htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {props.label}
      </FieldLabel>
      <Input
        id={id}
        size="sm"
        aria-label={props["aria-label"]}
        aria-invalid={props.invalid || undefined}
        type="number"
        inputMode="decimal"
        min={props.min}
        max={props.max}
        step="any"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="tabular-nums"
      />
    </Field>
  );
}

/**
 * The times the deck is laid out with wherever it plays by itself: on the timeline, in the show's
 * Play and in a video. How long a slide without narration shows, and the pauses before and after
 * a slide's narration. They are the video export's options (see `loadVideoOptions`), saved as
 * they are typed, each once it is a time the backend takes; what is not says why.
 *
 * It is what the timeline's Timing popover holds, and its title names that popover.
 */
export function TimingSettings() {
  const [initial] = useState(loadVideoOptions);
  const [seconds, setSeconds] = useState(String(initial.secondsPerSlide));
  const [before, setBefore] = useState(String(initial.pauseBefore));
  const [after, setAfter] = useState(String(initial.pauseAfter));
  const problem = secondsProblem(seconds) ?? pauseProblem(before) ?? pauseProblem(after);

  /** Keeps what was typed, and saves it once it is a time that can be used. */
  const change =
    (
      set: (text: string) => void,
      problemOf: (text: string) => string | null,
      key: "secondsPerSlide" | "pauseBefore" | "pauseAfter",
    ) =>
    (text: string) => {
      set(text);
      if (problemOf(text) === null) saveVideoOptions({ ...loadVideoOptions(), [key]: Number(text) });
    };

  return (
    <>
      <PopoverHeader>
        <PopoverTitle>Timing</PopoverTitle>
      </PopoverHeader>
      <FieldGroup className="gap-3 text-xs">
        <SecondsField
          label="Seconds per slide without narration"
          aria-label="Seconds per slide without narration"
          min={MIN_SECONDS}
          max={MAX_SECONDS}
          value={seconds}
          invalid={secondsProblem(seconds) !== null}
          onChange={change(setSeconds, secondsProblem, "secondsPerSlide")}
        />
        <div className="flex gap-2">
          <SecondsField
            label="Pause before (s)"
            aria-label="Pause before narration"
            min={0}
            max={MAX_PAUSE}
            value={before}
            invalid={pauseProblem(before) !== null}
            onChange={change(setBefore, pauseProblem, "pauseBefore")}
          />
          <SecondsField
            label="Pause after (s)"
            aria-label="Pause after narration"
            min={0}
            max={MAX_PAUSE}
            value={after}
            invalid={pauseProblem(after) !== null}
            onChange={change(setAfter, pauseProblem, "pauseAfter")}
          />
        </div>
        {problem ? (
          <FieldError className="text-xs">{problem}</FieldError>
        ) : (
          <FieldDescription className="text-xs">
            Used by the timeline, the show's Play and a video. A slide timed on the timeline keeps its own length.
          </FieldDescription>
        )}
      </FieldGroup>
    </>
  );
}
