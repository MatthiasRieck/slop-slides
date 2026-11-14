import { RectangleHorizontal, RectangleVertical, Square } from "lucide-react";
import { useEffect, useState } from "react";

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
import { cn } from "../lib/utils";
import { type DesignChange, useApp } from "../store";
import { Button } from "./Button";
import { Field, NumberField, selectClass } from "./Field";
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

/**
 * The deck's slide size, in the deck's settings. `onPending` hears of a size typed or picked and
 * not applied yet (null once there is none), for the settings not to close on it without a word.
 */
export function SlideSizeSettings({ onPending }: { onPending?: (size: SlideSize | null) => void }) {
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
      onPending={onPending}
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
  onPending?: (size: SlideSize | null) => void;
}) {
  const current: SlideSize = { width: props.current.width, height: props.current.height, unit: props.current.unit };
  const [unit, setUnit] = useState<SizeUnit>(current.unit);
  const [width, setWidth] = useState(String(current.width));
  const [height, setHeight] = useState(String(current.height));
  const hasSlides = useApp((s) => (s.deck?.slides.length ?? 0) > 0);
  const running = useApp((s) => s.running);

  const draft: SlideSize = { width: Number(width), height: Number(height), unit };
  const problem = width.trim() === "" || height.trim() === "" ? "Enter a width and a height." : sizeProblem(draft);
  const orientation = problem ? null : orientationOf(draft);
  const unchanged = !problem && sameSize(draft, current);
  // A valid size that is not the deck's waits to be applied.
  const pending = problem || unchanged ? null : draft;
  const pendingKey = pending && `${pending.width}x${pending.height}${pending.unit}`;
  const { onPending } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: told again only when the size waiting changes
  useEffect(() => onPending?.(pending), [pendingKey, onPending]);
  useEffect(() => () => onPending?.(null), [onPending]);

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
  return (
    <form
      className="flex flex-col gap-3 p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        void apply();
      }}
    >
      <div className="font-medium">Slide size</div>
      <div className="grid grid-cols-3 gap-1 rounded-md border bg-muted p-0.5">
        {ORIENTATIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={orientation === id}
            disabled={!!problem}
            onClick={() => show(withOrientation(draft, id))}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded px-2 py-1 font-medium text-muted-foreground hover:text-foreground disabled:opacity-40",
              orientation === id && "bg-background text-foreground shadow-sm ring-1 ring-border",
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <NumberField label="Width" aria-label="Width" min={0} value={width} onChange={setWidth} />
        <span className="pb-1.5 text-muted-foreground">×</span>
        <NumberField label="Height" aria-label="Height" min={0} value={height} onChange={setHeight} />
        <Field label="Unit" className="flex flex-col gap-1">
          <select
            aria-label="Unit"
            value={unit}
            onChange={(event) => {
              const next = event.target.value as SizeUnit;
              // Keep the size, shown in the new unit.
              if (!problem) show(convert(draft, next));
              else setUnit(next);
            }}
            className={selectClass}
          >
            {UNITS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p
        role={problem ? "alert" : undefined}
        className={cn("min-h-4 text-2xs", problem ? "text-destructive" : "text-muted-foreground")}
      >
        {problem ?? (unit !== "px" && pixels ? `A ${pixels.width} × ${pixels.height} px canvas (96 px per inch).` : "")}
      </p>
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground">Common sizes</span>
        <div className="flex flex-wrap gap-1">
          {SIZE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              title={describeSize(preset.size)}
              aria-pressed={!problem && sameSize(draft, preset.size)}
              onClick={() => show(preset.size)}
              className={cn(
                "rounded-md border px-1.5 py-0.5 text-2xs hover:bg-accent",
                !problem && sameSize(draft, preset.size) && "border-primary text-foreground",
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
      {hasSlides && (
        <p className="text-2xs text-muted-foreground">
          The slides keep their content. The chat gets a message asking the agent to lay them out again for the new
          size.
        </p>
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
        <Button size="lg" disabled={unchanged} onClick={() => show(current)}>
          Reset
        </Button>
        <Button
          variant="primary"
          size="lg"
          type="submit"
          disabled={!!problem || unchanged || running}
          title={running ? SIZE_BUSY : undefined}
        >
          Apply
        </Button>
      </div>
    </form>
  );
}
