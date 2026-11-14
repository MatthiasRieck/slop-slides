import { ChevronDown } from "lucide-react";
import { type InputHTMLAttributes, type ReactNode, useEffect, useState } from "react";

import { useDropdown } from "../hooks/useDropdown";
import { stepNumber } from "../lib/arrange";
import { parseNumber } from "../lib/editTools";
import { isMod } from "../lib/keys";
import { cn } from "../lib/utils";
import { DropdownPanel } from "./Popover";

/** A text or number field filling its labelled column. */
export const inputClass = "h-7 w-full min-w-0 rounded-md border bg-background px-1.5 tabular-nums";
/** A select as wide as its longest choice. */
export const selectClass = "h-7 rounded-md border bg-background px-1.5";
/** A select filling its labelled column. */
export const wideSelectClass = "h-7 w-full min-w-0 rounded-md border bg-background px-1.5 text-xs";

/**
 * A control under its muted label, the two in one column; the label names the control. The
 * column fills its share of a row unless `className` lays it out otherwise.
 */
export function Field(props: { label: ReactNode; className?: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control comes in as children.
    <label className={props.className ?? "flex min-w-0 flex-1 flex-col gap-1"}>
      <span className="text-muted-foreground">{props.label}</span>
      {props.children}
    </label>
  );
}

/** A number to type under its label, kept as the text typed so it can be checked before use. */
export function NumberField(props: {
  label: ReactNode;
  "aria-label": string;
  value: string;
  min?: number;
  max?: number;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={props.label}>
      <input
        aria-label={props["aria-label"]}
        type="number"
        inputMode="decimal"
        min={props.min}
        max={props.max}
        step="any"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className={inputClass}
      />
    </Field>
  );
}

/** A checkbox with a title and a line saying what it does. */
export function CheckboxRow(props: {
  title: ReactNode;
  description: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
        className="mt-0.5"
      />
      <span className="flex flex-col">
        <span className="font-medium">{props.title}</span>
        <span className="text-2xs text-muted-foreground">{props.description}</span>
      </span>
    </label>
  );
}

/**
 * A number to type that applies on Enter or when the field loses focus; Escape puts the value
 * back. ↑ and ↓ take it one up or down (ten with Shift) and apply that at once, the focus staying
 * in the field for the next step; with `stepBy`, a step is that much (0.1 for a line height).
 * Keystrokes pass through `sanitize`, and only a text `parse` takes, that differs from the value,
 * is applied. Enter and Escape also call `onDone`, to hand focus back.
 */
export function DraftInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onBlur" | "onKeyDown"> & {
    value: number | null;
    parse: (text: string) => number | null;
    sanitize: (text: string) => string;
    stepBy?: number;
    onChange: (value: number) => void;
    onDone: () => void;
  },
) {
  const { value, parse, sanitize, stepBy, onChange, onDone, ...rest } = props;
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
    const stepped =
      from === null
        ? null
        : stepBy === undefined
          ? stepNumber(from, direction, large)
          : Number((from + direction * stepBy * (large ? 10 : 1)).toFixed(4));
    const next = stepped === null ? null : parse(String(stepped));
    if (next === null) return;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      placeholder="–"
      {...rest}
      value={draft}
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
}

/** One of the values a `NumberBox` offers to pick: a number, or with null, "none of mine" (the deck's own). */
export interface NumberPreset {
  value: number | null;
  /** What the list calls it; the number with the box's unit without one. */
  label?: string;
}

/**
 * A number of the selection, the same wherever one is set: a field to type any value into (see
 * `DraftInput`: Enter applies, ↑ and ↓ step), its `unit` after it, and with `presets` a small
 * list of the usual values to pick from. A null `value` shows a dash: there is none, or the
 * selected elements differ (the field still takes a value for all of them). `label` names it and
 * is its tooltip; disabled, the tooltip is `disabledReason`. A pick or a typed value calls
 * `onDone`, to hand the focus back.
 */
export function NumberBox(props: {
  label: string;
  value: number | null;
  unit?: string;
  min: number;
  max: number;
  /** How many places after the point it takes; none without it. */
  decimals?: number;
  stepBy?: number;
  presets?: readonly NumberPreset[];
  disabled?: boolean;
  disabledReason?: string;
  /** Sizes the field itself, as Tailwind width classes. */
  width?: string;
  id?: string;
  onChange: (value: number | null) => void;
  onDone: () => void;
}) {
  const { open, setOpen, ref } = useDropdown({ disabled: props.disabled });
  const decimals = props.decimals ?? 0;
  const allowed = props.min < 0 ? (decimals ? /[^\d.,-]/g : /[^\d-]/g) : decimals ? /[^\d.,]/g : /[^\d]/g;
  const name = (preset: NumberPreset) => preset.label ?? `${preset.value}${props.unit ? ` ${props.unit}` : ""}`;
  const pick = (value: number | null) => {
    setOpen(false);
    if (value !== props.value) props.onChange(value);
    props.onDone();
  };
  return (
    <div
      ref={ref}
      title={props.disabled && props.disabledReason ? props.disabledReason : props.label}
      className={cn(
        "relative flex h-6 shrink-0 items-center rounded-md border text-xs",
        props.disabled && "opacity-45",
      )}
    >
      <DraftInput
        id={props.id}
        aria-label={props.label}
        disabled={props.disabled}
        value={props.value}
        parse={(text) => parseNumber(text, props.min, props.max, decimals)}
        sanitize={(text) => text.replace(allowed, "")}
        stepBy={props.stepBy}
        onChange={props.onChange}
        onDone={props.onDone}
        className={cn(
          "h-full min-w-0 rounded-md bg-transparent pl-1 text-center text-foreground tabular-nums outline-none",
          props.width ?? "w-8",
        )}
      />
      {props.unit && <span className="pr-0.5 text-[10px] text-muted-foreground">{props.unit}</span>}
      {props.presets && (
        <button
          type="button"
          aria-label={`${props.label}: usual values`}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={props.disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen(!open)}
          className="flex h-full w-3.5 items-center justify-center rounded-r-md text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground"
        >
          <ChevronDown aria-hidden="true" className="size-2.5" />
        </button>
      )}
      {open && props.presets && (
        <DropdownPanel
          role="listbox"
          aria-label={`${props.label}: usual values`}
          data-ribbon-panel=""
          className="flex max-h-64 w-max min-w-full flex-col overflow-y-auto p-1 text-foreground"
        >
          {props.presets.map((preset) => (
            <button
              key={String(preset.value)}
              type="button"
              role="option"
              aria-selected={preset.value === props.value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(preset.value)}
              className={cn(
                "rounded px-2 py-0.5 text-left whitespace-nowrap tabular-nums hover:bg-accent",
                preset.value === props.value && "bg-primary/10 text-primary",
              )}
            >
              {name(preset)}
            </button>
          ))}
        </DropdownPanel>
      )}
    </div>
  );
}
