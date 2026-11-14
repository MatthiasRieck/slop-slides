import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import type { Deck } from "../../lib/api";
import {
  type ChosenSlides,
  chooseSlides,
  EXPORT_TITLES,
  type ExportChoices,
  type ExportFormat,
  loadChoices,
  type SlideRange,
  saveChoices,
} from "../../lib/exportOptions";
import { cn, plural } from "../../lib/utils";
import { useApp } from "../../store";
import { selectedSlide } from "../../store/slides";
import { Button } from "../Button";
import { Dialog, DialogActions } from "../Dialog";
import { CheckboxRow, inputClass } from "../Field";

/** What every export dialog works with: the choices remembered for its format, and the slides they come to. */
export interface ExportForm {
  format: ExportFormat;
  deck: Deck;
  choices: ExportChoices;
  change: (patch: Partial<ExportChoices>) => void;
  /** The first and last slide of a range, as typed. */
  from: string;
  to: string;
  setFrom: (from: string) => void;
  setTo: (to: string) => void;
  chosen: ChosenSlides;
}

/**
 * The export dialog's state for `format`: the choices last made for it (remembered again as they
 * change), and the slides of `deck` they come to, the current one being the slide selected.
 */
export function useExportForm(format: ExportFormat, deck: Deck): ExportForm {
  const [choices, setChoices] = useState(() => loadChoices(format));
  const current = useApp((s) => selectedSlide(s)?.id ?? null);
  const currentNumber = Math.max(1, deck.slides.findIndex((s) => s.id === current) + 1);
  // A range starts as the current slide to the last one: the usual "from here on".
  const [from, setFrom] = useState(String(currentNumber));
  const [to, setTo] = useState(String(deck.slides.length));
  useEffect(() => saveChoices(format, choices), [format, choices]);
  const chosen = chooseSlides(
    deck.slides,
    { range: choices.range, from, to, includeHidden: choices.includeHidden },
    current,
  );
  return {
    format,
    deck,
    choices,
    change: (patch) => setChoices((c) => ({ ...c, ...patch })),
    from,
    to,
    setFrom,
    setTo,
    chosen,
  };
}

/** One of a few choices side by side; the arrow keys go between them, as in any group of radios. */
export function Segmented<T extends string | number>(props: {
  label: string;
  name: string;
  options: readonly T[];
  labels: (value: T) => string;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      style={{ gridTemplateColumns: `repeat(${props.options.length}, minmax(0, 1fr))` }}
      className="grid gap-1 rounded-md border bg-muted p-0.5 text-xs"
    >
      {props.options.map((value) => (
        <label
          key={String(value)}
          className={cn(
            "flex cursor-pointer items-center justify-center rounded px-2 py-1 font-medium whitespace-nowrap text-muted-foreground hover:text-foreground has-focus-visible:ring-2 has-focus-visible:ring-primary/40",
            props.value === value && "bg-background text-foreground shadow-sm ring-1 ring-border",
          )}
        >
          <input
            type="radio"
            name={props.name}
            className="sr-only"
            checked={props.value === value}
            onChange={() => props.onChange(value)}
          />
          {props.labels(value)}
        </label>
      ))}
    </div>
  );
}

/** A labelled row of the dialog: the name on the left, the control beside it. */
export function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1">
      <span className="pt-1 text-muted-foreground">{props.label}</span>
      <div className="flex min-w-0 flex-col gap-1.5">{props.children}</div>
    </div>
  );
}

const RANGE_LABELS: Record<SlideRange, string> = { all: "All", current: "Current slide", range: "Range" };

/** Which slides go into the export: all, the current one, or a range; and whether hidden ones come along. */
export function SlideFields({ form }: { form: ExportForm }) {
  const { choices, change, deck } = form;
  const hidden = deck.slides.filter((s) => s.hidden).length;
  return (
    <>
      <Row label="Slides">
        <Segmented
          label="Slides"
          name={`export-range-${form.format}`}
          options={["all", "current", "range"] as const}
          labels={(value) => RANGE_LABELS[value]}
          value={choices.range}
          onChange={(range) => change({ range })}
        />
        {choices.range === "range" && (
          <div className="flex items-center gap-1.5">
            <input
              aria-label="First slide"
              type="number"
              inputMode="numeric"
              min={1}
              max={deck.slides.length}
              value={form.from}
              onChange={(event) => form.setFrom(event.target.value)}
              className={cn(inputClass, "w-16")}
            />
            <span className="text-muted-foreground">to</span>
            <input
              aria-label="Last slide"
              type="number"
              inputMode="numeric"
              min={1}
              max={deck.slides.length}
              value={form.to}
              onChange={(event) => form.setTo(event.target.value)}
              className={cn(inputClass, "w-16")}
            />
            <span className="text-muted-foreground">of {deck.slides.length}</span>
          </div>
        )}
      </Row>
      <Row label="">
        <CheckboxRow
          title="Include hidden slides"
          description={
            hidden === 0
              ? "This deck has no hidden slides."
              : `${plural(hidden, "slide is", "slides are")} hidden. Left out, as the show skips them.`
          }
          checked={choices.includeHidden}
          onChange={(includeHidden) => change({ includeHidden })}
        />
      </Row>
    </>
  );
}

/**
 * The export dialog every format has: its name on top, which slides, the format's own options
 * (`children`), a line saying what will be saved (or what is wrong, `problem`), and Cancel and
 * Save. Saving closes it; the export then shows its progress on the Export button.
 */
export function ExportShell(props: {
  form: ExportForm;
  /** What the export comes to, said when nothing is wrong: "12 slides, 1920 × 1080 px". */
  summary: string;
  problem: string | null;
  /** What Save says: "Save PDF…". */
  saveLabel: string;
  onSave: () => void;
  onClose: () => void;
  /** What goes under the buttons' line, beside them: a note on the format. */
  note?: ReactNode;
  children?: ReactNode;
}) {
  const title = EXPORT_TITLES[props.form.format];
  const problem = props.form.chosen.problem ?? props.problem;
  return (
    <Dialog label={title} size="md" title={title} onClose={props.onClose}>
      <form
        className="flex min-h-0 flex-col gap-3 text-xs"
        onSubmit={(event) => {
          event.preventDefault();
          if (!problem) props.onSave();
        }}
      >
        {/* The options scroll in a short window; what will be saved and the buttons stay in view. */}
        <div className="-mr-2 flex min-h-0 flex-col gap-3 overflow-y-auto pr-2">
          <SlideFields form={props.form} />
          {props.children}
          {props.note && <p className="text-2xs text-muted-foreground">{props.note}</p>}
        </div>
        <p
          role={problem ? "alert" : "status"}
          data-testid="export-summary"
          className={cn("min-h-4 text-xs", problem ? "text-destructive" : "text-muted-foreground")}
        >
          {problem ?? props.summary}
        </p>
        <DialogActions>
          <Button size="lg" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" type="submit" disabled={!!problem}>
            {props.saveLabel}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
