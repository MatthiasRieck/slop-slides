import { Check, ChevronRight, Loader2, X } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { slideNumber, slideNumbers } from "../../lib/slideNumbers";
import { cn, workspaceChatFileUrl } from "../../lib/utils";
import { useApp } from "../../store";
import { ApprovalCard } from "../Permissions";
import { foldUnchanged, lineDiff } from "./lineDiff";
import { slideLabel } from "./mentions";
import {
  describeTool,
  editedIds,
  editedSlide,
  partKey,
  type StepPart,
  stepFacts,
  stepsLabel,
  type TextEdit,
  type ToolPart,
  textEdits,
  toolArguments,
} from "./toolCalls";

/** No slides: what a group of steps is summed up against without a deck. */
const NO_SLIDES: ReadonlyMap<string, number> = new Map();

/** Whether two groups hold the same steps: a reply coming in lays its parts out anew with every word. */
const sameSteps = (a: { steps: StepPart[] }, b: { steps: StepPart[] }) =>
  a.steps.length === b.steps.length && a.steps.every((step, at) => step === b.steps[at]);

/**
 * Steps of a reply that followed one another, as one line that says what they did ("Edited 3
 * slides, read 2 files") and unfolds into them. While the reply comes in, the steps done gather
 * here; it renders again only when one joins them.
 *
 * What the steps did is read once; summing it up against the deck, which changes with every
 * save, then gives the same text from one save to the next.
 */
export const ToolSteps = memo(function ToolSteps({ steps }: { steps: StepPart[] }) {
  const [open, setOpen] = useState(false);
  const deckId = useApp((s) => s.deck?.id ?? "");
  const facts = useMemo(() => stepFacts(steps, deckId), [steps, deckId]);
  const label = useApp((s) => stepsLabel(facts, s.deck ? slideNumbers(s.deck.slides) : NO_SLIDES));
  const failed = facts.some((fact) => fact.failed);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        title={open ? "Hide the steps" : `Show each of the ${steps.length} steps`}
        onClick={() => setOpen(!open)}
        className="flex min-w-0 items-center gap-1.5 self-start rounded-md text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        {failed && <X className="size-3.5 shrink-0 text-destructive" />}
        <span className="min-w-0">{label}</span>
      </button>
      {open && (
        <div className="flex min-w-0 flex-col gap-2 border-l pl-3">
          {steps.map((step) =>
            step.kind === "tool" ? (
              <ToolRow key={step.id} part={step} />
            ) : (
              <ApprovalCard key={partKey(step)} part={step} />
            ),
          )}
        </div>
      )}
    </div>
  );
}, sameSteps);

/**
 * A tool call of the agent's; an edit of the deck's slide selects that slide when pressed. What
 * it was asked and what came of it unfold beneath it.
 *
 * A transcript holds hundreds of these, and the deck changes with every save, in bursts while
 * the agent writes. So a row takes of the deck only what it shows, as plain values that stay the
 * same from one save to the next (the deck's id, the id and number of the slide it edited), and
 * reads its own edit once.
 */
export const ToolRow = memo(function ToolRow({ part }: { part: ToolPart }) {
  const deckId = useApp((s) => s.deck?.id ?? "");
  const { icon: Icon, label, target } = useMemo(() => describeTool(part, deckId), [part, deckId]);
  const edited = useMemo(() => editedIds(part, target, deckId), [part, target, deckId]);
  const slide = useApp((s) => (s.deck && edited.length > 0 ? editedSlide(edited, slideNumbers(s.deck.slides)) : null));
  const number = useApp((s) => slideNumber(s.deck, slide));
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-1">
        <ToolSummary part={part} icon={Icon} label={label} target={target} slide={slide} number={number} />
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} details of ${label}${target ? ` ${target}` : ""}`}
          title={open ? "Hide the details" : "Show what was asked for and the result"}
          onClick={() => setOpen(!open)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        </button>
      </div>
      {open && <ToolDetails part={part} />}
    </div>
  );
});

/** What a tool call was asked for and what came of it, unfolded beneath its row. */
function ToolDetails({ part }: { part: ToolPart }) {
  const edits = useMemo(() => textEdits(part), [part]);
  // An edit shows as a before and after; the texts it was given need no listing again.
  const args = toolArguments(part).filter(
    (arg) => !edits || !["old_string", "new_string", "edits", "content"].includes(arg.name),
  );
  const images = part.images ?? [];
  return (
    <div className="selectable flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/40 p-2.5 text-xs">
      <ToolDetail title="Asked for">
        {args.length === 0 && !edits ? (
          <span className="text-muted-foreground">Nothing in particular</span>
        ) : (
          <dl className="flex min-w-0 flex-col gap-1.5">
            {args.map((arg) => (
              <div key={arg.name} className="min-w-0">
                <dt className="font-mono text-2xs text-muted-foreground">{arg.name}</dt>
                <dd>
                  <ToolText text={arg.value} />
                </dd>
              </div>
            ))}
          </dl>
        )}
        {edits?.map((edit, at) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the edits of a call keep their order
          <EditDiff key={at} edit={edit} />
        ))}
      </ToolDetail>
      <ToolDetail title={part.status === "error" ? "Error" : "Result"}>
        {part.output ? (
          <ToolText text={part.output} error={part.status === "error"} />
        ) : (
          !images.length && (
            <span className="text-muted-foreground">{part.status === "running" ? "Running…" : "Nothing to show"}</span>
          )
        )}
        {images.length > 0 && (
          <div className="flex min-w-0 flex-col gap-2">
            {images.map((path, i) => (
              <ToolImage key={path} path={path} alt={`Image ${i + 1} of ${images.length} the agent received`} />
            ))}
          </div>
        )}
      </ToolDetail>
    </div>
  );
}

/** What marks a line of a before-and-after, for the eye and for those who cannot tell the colors apart. */
const DIFF_LINE = {
  same: { mark: " ", className: "text-foreground/70" },
  removed: { mark: "−", className: "bg-destructive/10 text-destructive" },
  added: { mark: "+", className: "bg-success/10 text-success" },
} as const;

/**
 * One replacement an edit made, as a small before-and-after: the lines taken out in red, those
 * put in in green, two unchanged lines around each change and "⋯" for what lies between.
 */
function EditDiff({ edit }: { edit: TextEdit }) {
  const lines = useMemo(() => foldUnchanged(lineDiff(edit.before, edit.after)), [edit]);
  if (lines.length === 0) return <span className="text-muted-foreground">No change to the text</span>;
  return (
    <figure
      aria-label="Before and after"
      className="m-0 max-h-72 min-w-0 overflow-auto rounded-md border bg-background"
    >
      <pre className="min-w-max font-mono text-[0.95em] leading-relaxed">
        {lines.map((line, at) =>
          line === null ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a diff keep their order
            <div key={at} aria-hidden className="px-2 text-muted-foreground">
              ⋯
            </div>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a diff keep their order
            <div key={at} data-diff={line.kind} className={cn("flex gap-2 px-2", DIFF_LINE[line.kind].className)}>
              <span className="w-2 shrink-0 select-none" title={line.kind === "same" ? undefined : line.kind}>
                {DIFF_LINE[line.kind].mark}
              </span>
              <span className="whitespace-pre">{line.text || " "}</span>
            </div>
          ),
        )}
      </pre>
    </figure>
  );
}

/** A titled part of a tool call's details. */
function ToolDetail(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <h4 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{props.title}</h4>
      {props.children}
    </section>
  );
}

/** An image a tool gave the agent, as kept in the chat's session; the chat keeps only the newest. */
function ToolImage({ path, alt }: { path: string; alt: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return <span className="text-muted-foreground">This image is no longer kept.</span>;
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: a failed load is not an interaction
    <img
      src={workspaceChatFileUrl("", path)}
      alt={alt}
      loading="lazy"
      onError={() => setMissing(true)}
      className="max-h-96 max-w-full self-start rounded-md border bg-muted object-contain"
    />
  );
}

/** Text of a tool call as it was written, scrolling when long. */
function ToolText({ text, error }: { text: string; error?: boolean }) {
  return (
    <pre
      className={cn(
        "max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.95em] leading-relaxed",
        error ? "text-destructive" : "text-foreground/80",
      )}
    >
      {text}
    </pre>
  );
}

/** The line a tool call shows: what it did and to what, linked to the slide it edited, which it names by its number. */
function ToolSummary(props: {
  part: ToolPart;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  target: string;
  slide: string | null;
  /** The slide's number in the deck; 0 without one. */
  number: number;
}) {
  const { part, icon: Icon, label, target, slide, number } = props;
  return (
    <button
      type="button"
      disabled={!slide}
      title={slide && number > 0 ? `Go to ${slideLabel(number, slide)}` : undefined}
      onClick={() => slide && useApp.getState().select(slide)}
      className="flex min-w-0 items-center gap-2 rounded-md text-left text-xs text-muted-foreground enabled:hover:text-foreground"
    >
      {part.status === "running" ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
      ) : part.status === "error" ? (
        <X className="size-3.5 shrink-0 text-destructive" />
      ) : (
        <Icon className="size-3.5 shrink-0" />
      )}
      <span className="truncate">
        {label}
        {target && <span className="font-mono text-[0.95em] text-foreground/80"> {target}</span>}
        {slide && number > 0 && <span className="text-foreground/80"> · slide {number}</span>}
      </span>
      {part.status === "done" && slide && <Check className="size-3 shrink-0 text-success" />}
    </button>
  );
}
