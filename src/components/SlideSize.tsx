import { RectangleHorizontal, RectangleVertical, Square } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import {
  convert,
  DEFAULT_SIZE,
  describeSize,
  type Orientation,
  orientationOf,
  SIZE_PRESETS,
  type SizeUnit,
  type SlideSize,
  sameSize,
  sizeProblem,
  toPixels,
  withOrientation,
} from "../lib/slideSize";
import { type DesignChange, useApp } from "../store";
import { RequestStatus } from "./Templates";

const ORIENTATIONS: { id: Orientation; label: string; icon: typeof Square }[] = [
  { id: "landscape", label: "Landscape", icon: RectangleHorizontal },
  { id: "portrait", label: "Portrait", icon: RectangleVertical },
  { id: "square", label: "Square", icon: Square },
];

const UNITS: { id: SizeUnit; label: string }[] = [
  { id: "px", label: "px" },
  { id: "in", label: "in" },
  { id: "cm", label: "cm" },
];

const SIZE_BUSY = "Wait for the agent to finish to change the slide size";

/** The small muted label over a control of this panel. */
const LABEL = "text-xs font-normal text-muted-foreground";

/** The deck's slide size, in the deck's settings. */
export function SlideSizeSettings() {
  const size = useApp((s) => s.deck?.size) ?? DEFAULT_SIZE;
  const deckId = useApp((s) => s.deck?.id);
  /** How the last Apply went, and for which deck; kept here, as the panel starts over with the new size. */
  const [applied, setApplied] = useState<{ deck: string | undefined; change: DesignChange } | null>(null);
  const change = applied && applied.deck === deckId ? applied.change : null;
  return (
    // Starts over from the deck's size when it changes, by Apply or by the agent.
    <SlideSizePanel
      key={`${size.width}x${size.height}${size.unit}`}
      current={size}
      applied={change}
      onApplied={(next) => setApplied(next && { deck: deckId, change: next })}
    />
  );
}

/**
 * Picks a slide size: an orientation, width and height in px, in or cm, or a common size.
 * Applying resizes every slide and, for a deck with slides, prepares a message asking the agent
 * to lay them out again.
 */
function SlideSizePanel(props: {
  current: SlideSize;
  /** How the last Apply went: the status under the form says so. */
  applied: DesignChange | null;
  onApplied: (change: DesignChange | null) => void;
}) {
  const current: SlideSize = { width: props.current.width, height: props.current.height, unit: props.current.unit };
  const [unit, setUnit] = useState<SizeUnit>(current.unit);
  const [width, setWidth] = useState(String(current.width));
  const [height, setHeight] = useState(String(current.height));
  const hasSlides = useApp((s) => (s.deck?.slides.length ?? 0) > 0);
  const running = useApp((s) => s.running);
  const id = useId();

  const draft: SlideSize = { width: Number(width), height: Number(height), unit };
  const problem = width.trim() === "" || height.trim() === "" ? "Enter a width and a height." : sizeProblem(draft);
  const orientation = problem ? null : orientationOf(draft);
  const unchanged = !problem && sameSize(draft, current);

  const show = (size: SlideSize) => {
    setUnit(size.unit);
    setWidth(String(size.width));
    setHeight(String(size.height));
  };

  const apply = async () => {
    if (problem || unchanged || running) return;
    props.onApplied(null);
    props.onApplied(await useApp.getState().resizeSlides(draft));
  };

  const pixels = problem ? null : toPixels(draft);
  const inPixels = unit !== "px" && pixels ? `A ${pixels.width} × ${pixels.height} px canvas (96 px per inch).` : "";
  return (
    <form
      className="flex flex-col gap-3 p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        void apply();
      }}
    >
      <div className="font-medium">Slide size</div>
      <ToggleGroup
        aria-label="Orientation"
        variant="outline"
        size="xs"
        spacing={0}
        disabled={!!problem}
        value={orientation ? [orientation] : []}
        // A press on the orientation the slides have changes nothing.
        onValueChange={([next]) => next && show(withOrientation(draft, next as Orientation))}
        className="w-full"
      >
        {ORIENTATIONS.map(({ id: value, label, icon: Icon }) => (
          <ToggleGroupItem key={value} value={value} className="flex-1 gap-1.5">
            <Icon data-icon="inline-start" />
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className="flex items-end gap-2">
        <Field className="min-w-0 flex-1 gap-1">
          <FieldLabel htmlFor={`${id}-width`} className={LABEL}>
            Width
          </FieldLabel>
          <Input
            id={`${id}-width`}
            size="sm"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={width}
            onChange={(event) => setWidth(event.target.value)}
            className="tabular-nums"
          />
        </Field>
        <span className="pb-1.5 text-muted-foreground">×</span>
        <Field className="min-w-0 flex-1 gap-1">
          <FieldLabel htmlFor={`${id}-height`} className={LABEL}>
            Height
          </FieldLabel>
          <Input
            id={`${id}-height`}
            size="sm"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={height}
            onChange={(event) => setHeight(event.target.value)}
            className="tabular-nums"
          />
        </Field>
        <Field className="w-auto gap-1">
          <FieldLabel htmlFor={`${id}-unit`} className={LABEL}>
            Unit
          </FieldLabel>
          <NativeSelect
            id={`${id}-unit`}
            size="sm"
            value={unit}
            onChange={(event) => {
              const next = event.target.value as SizeUnit;
              // Keep the size, shown in the new unit.
              if (!problem) show(convert(draft, next));
              else setUnit(next);
            }}
          >
            {UNITS.map((u) => (
              <NativeSelectOption key={u.id} value={u.id}>
                {u.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {problem ? (
        <FieldError className="min-h-4 text-2xs">{problem}</FieldError>
      ) : (
        <FieldDescription className="min-h-4 text-2xs">{inPixels}</FieldDescription>
      )}
      <Field className="gap-1">
        <FieldTitle className={LABEL}>Common sizes</FieldTitle>
        <div className="flex flex-wrap gap-1">
          {SIZE_PRESETS.map((preset) => (
            <Button
              key={preset.label}
              variant="outline"
              size="2xs"
              tooltip={describeSize(preset.size)}
              aria-pressed={!problem && sameSize(draft, preset.size)}
              onClick={() => show(preset.size)}
              className="text-2xs aria-pressed:border-primary"
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </Field>
      {hasSlides && (
        <FieldDescription className="text-2xs">
          The slides keep their content. The chat gets a message asking the agent to lay them out again for the new
          size.
        </FieldDescription>
      )}
      {props.applied === "requested" && (
        <RequestStatus>Slides resized. Request added to the chat. Send it to lay the slides out again.</RequestStatus>
      )}
      {props.applied === "applied" && (
        <p role="status" className="text-2xs text-foreground">
          Slide size changed.
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        {running && <span className="mr-auto text-2xs text-muted-foreground">{SIZE_BUSY}.</span>}
        <Button variant="outline" size="xs" disabled={unchanged} onClick={() => show(current)}>
          Reset
        </Button>
        <Button
          size="xs"
          type="submit"
          disabled={!!problem || unchanged || running}
          // Said on the button too, while the agent is why it waits.
          tooltip={running ? SIZE_BUSY : undefined}
        >
          Apply
        </Button>
      </div>
    </form>
  );
}
