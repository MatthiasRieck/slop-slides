import { type InputHTMLAttributes, type ReactNode, useEffect, useState } from "react";

import { stepNumber } from "../lib/arrange";
import { isMod } from "../lib/keys";

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
 * in the field for the next step. Keystrokes pass through `sanitize`, and only a text `parse`
 * takes, that differs from the value, is applied. Enter and Escape also call `onDone`, to hand
 * focus back.
 */
export function DraftInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onBlur" | "onKeyDown"> & {
    value: number | null;
    parse: (text: string) => number | null;
    sanitize: (text: string) => string;
    onChange: (value: number) => void;
    onDone: () => void;
  },
) {
  const { value, parse, sanitize, onChange, onDone, ...rest } = props;
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
