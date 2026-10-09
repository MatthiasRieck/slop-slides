import { Ratio, RectangleHorizontal, RectangleVertical, Square } from "lucide-react";
import { useRef, useState } from "react";

import {
  convert,
  DEFAULT_SIZE,
  describeSize,
  formatSize,
  orientationOf,
  sameSize,
  SIZE_PRESETS,
  sizeProblem,
  toPixels,
  withOrientation,
  type Orientation,
  type SizeUnit,
  type SlideSize,
} from "../lib/slideSize";
import { cn } from "../lib/utils";
import { useApp } from "../store";
import { Popover } from "./Templates";

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

/** The deck's slide size in the top bar; opens a panel to change it. */
export function SlideSizeButton() {
  const size = useApp((s) => s.deck?.size) ?? DEFAULT_SIZE;
  const running = useApp((s) => s.running);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Slide size"
        aria-expanded={open}
        disabled={running}
        title={running ? "Wait for the agent to finish to change the slide size" : `Slide size: ${describeSize(size)}`}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        <Ratio className="size-3.5" />
        {formatSize(size)}
      </button>
      {open && (
        <Popover anchor={buttonRef} placement="below" width={320} label="Slide size" onClose={() => setOpen(false)}>
          <SlideSizePanel current={size} onDone={() => setOpen(false)} />
        </Popover>
      )}
    </>
  );
}

/**
 * Picks a slide size: an orientation, width and height in px, in or cm, or a common size.
 * Applying resizes every slide and, for a deck with slides, prepares a message asking the agent
 * to lay them out again.
 */
export function SlideSizePanel(props: { current: SlideSize; onDone: () => void }) {
  const current: SlideSize = { width: props.current.width, height: props.current.height, unit: props.current.unit };
  const [unit, setUnit] = useState<SizeUnit>(current.unit);
  const [width, setWidth] = useState(String(current.width));
  const [height, setHeight] = useState(String(current.height));
  const hasSlides = useApp((s) => (s.deck?.slides.length ?? 0) > 0);

  const draft: SlideSize = { width: Number(width), height: Number(height), unit };
  const problem = width.trim() === "" || height.trim() === "" ? "Enter a width and a height." : sizeProblem(draft);
  const orientation = problem ? null : orientationOf(draft);
  const unchanged = !problem && sameSize(draft, current);

  const show = (size: SlideSize) => {
    setUnit(size.unit);
    setWidth(String(size.width));
    setHeight(String(size.height));
  };

  const apply = () => {
    if (problem || unchanged) return;
    void useApp.getState().resizeSlides(draft);
    props.onDone();
  };

  const pixels = problem ? null : toPixels(draft);
  return (
    <form
      className="flex flex-col gap-3 p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <div className="text-sm font-medium">Slide size</div>
      <div className="grid grid-cols-3 gap-1 rounded-md border bg-muted p-0.5">
        {ORIENTATIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={orientation === id}
            disabled={!!problem}
            onClick={() => show(withOrientation(draft, id))}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded px-2 py-1 font-medium text-muted-foreground hover:text-foreground disabled:opacity-50",
              orientation === id && "bg-background text-foreground shadow-sm ring-1 ring-border",
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <SizeField label="Width" value={width} onChange={setWidth} />
        <span className="pb-1.5 text-muted-foreground">×</span>
        <SizeField label="Height" value={height} onChange={setHeight} />
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Unit</span>
          <select
            aria-label="Unit"
            value={unit}
            onChange={(event) => {
              const next = event.target.value as SizeUnit;
              // Keep the size, shown in the new unit.
              if (!problem) show(convert(draft, next));
              else setUnit(next);
            }}
            className="h-7 rounded-md border bg-background px-1.5"
          >
            {UNITS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p role={problem ? "alert" : undefined} className={cn("min-h-4 text-2xs", problem ? "text-destructive" : "text-muted-foreground")}>
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
          The slides keep their content. The chat gets a message asking the agent to lay them out again for the new size.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={props.onDone} className="rounded-md border px-2.5 py-1 font-medium hover:bg-accent">
          Cancel
        </button>
        <button
          type="submit"
          disabled={!!problem || unchanged}
          className="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          Apply
        </button>
      </div>
    </form>
  );
}

function SizeField(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-muted-foreground">{props.label}</span>
      <input
        aria-label={props.label}
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="h-7 w-full min-w-0 rounded-md border bg-background px-1.5 tabular-nums"
      />
    </label>
  );
}
