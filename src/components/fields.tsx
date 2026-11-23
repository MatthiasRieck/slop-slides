// The fields of the app's compact panels (export options, timing, slide size, the drawing
// inspector), composed from shadcn/ui's `Field`: one look for a control under its quiet label.
import { type ReactNode, useId } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { QUIET_LABEL } from "./styles";

/**
 * A control under its quiet label, the two filling their share of a row. `children` gets the id
 * the label points at, for the control to take; `invalid` marks the field as holding what cannot
 * be used.
 */
export function LabeledField(props: {
  label: ReactNode;
  invalid?: boolean;
  className?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <Field data-invalid={props.invalid || undefined} className={cn("min-w-0 flex-1 gap-1", props.className)}>
      <FieldLabel htmlFor={id} className={QUIET_LABEL}>
        {props.label}
      </FieldLabel>
      {props.children(id)}
    </Field>
  );
}

/**
 * A number to type under its label, kept as the text typed so that it can be checked before it
 * is used; `invalid` says the check failed.
 */
export function NumberField(props: {
  label: string;
  "aria-label"?: string;
  value: string;
  min?: number;
  max?: number;
  invalid?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <LabeledField label={props.label} invalid={props.invalid}>
      {(id) => (
        <Input
          id={id}
          size="sm"
          type="number"
          inputMode="decimal"
          aria-label={props["aria-label"]}
          aria-invalid={props.invalid || undefined}
          min={props.min}
          max={props.max}
          step="any"
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          className="tabular-nums"
        />
      )}
    </LabeledField>
  );
}

/** A checkbox with a title and a line saying what it does. */
export function CheckField(props: {
  title: string;
  description: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <Checkbox id={id} checked={props.checked} onCheckedChange={props.onChange} />
      <FieldContent>
        <FieldLabel htmlFor={id} className="text-xs">
          {props.title}
        </FieldLabel>
        <FieldDescription className="text-2xs">{props.description}</FieldDescription>
      </FieldContent>
    </Field>
  );
}
