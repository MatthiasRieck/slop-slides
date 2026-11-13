import { Check, ChevronRight, Loader2, X } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { slideNumbers } from "../../lib/slideNumbers";
import { cn, workspaceChatFileUrl } from "../../lib/utils";
import { useApp } from "../../store";
import { describeTool, editedIds, editedSlide, stepsLabel, type ToolPart, toolArguments } from "./toolCalls";

/** Tool calls of a finished reply that followed one another, as one line that unfolds into them. */
export const ToolSteps = memo(function ToolSteps({ tools }: { tools: ToolPart[] }) {
  const [open, setOpen] = useState(false);
  const failed = tools.some((tool) => tool.status === "error");
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        title={open ? "Hide the steps" : "Show each step"}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 self-start rounded-md text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        {failed && <X className="size-3.5 shrink-0 text-destructive" />}
        {stepsLabel(tools)}
      </button>
      {open && (
        <div className="flex min-w-0 flex-col gap-2 border-l pl-3">
          {tools.map((tool) => (
            <ToolRow key={tool.id} part={tool} />
          ))}
        </div>
      )}
    </div>
  );
});

/**
 * A tool call of the agent's; an edit of the deck's slide selects that slide when pressed. Its
 * arguments and output unfold beneath it.
 *
 * A transcript holds hundreds of these, and the deck changes with every save, in bursts while
 * the agent writes. So a row takes of the deck only what it shows, as plain values that stay the
 * same from one save to the next (the deck's id, the id of the slide it edited), and reads its
 * own edit once.
 */
export const ToolRow = memo(function ToolRow({ part }: { part: ToolPart }) {
  const deckId = useApp((s) => s.deck?.id ?? "");
  const { icon: Icon, label, target } = useMemo(() => describeTool(part, deckId), [part, deckId]);
  const edited = useMemo(() => editedIds(part, target, deckId), [part, target, deckId]);
  const slide = useApp((s) => (s.deck && edited.length > 0 ? editedSlide(edited, slideNumbers(s.deck.slides)) : null));
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-1">
        <ToolSummary part={part} icon={Icon} label={label} target={target} slide={slide} />
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} arguments and output of ${label}${target ? ` ${target}` : ""}`}
          title={open ? "Hide arguments and output" : "Show arguments and output"}
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

/** What a tool call was given and what it gave back, unfolded beneath its row. */
function ToolDetails({ part }: { part: ToolPart }) {
  const args = toolArguments(part);
  const images = part.images ?? [];
  return (
    <div className="selectable flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/40 p-2.5 text-xs">
      <ToolDetail title={`Arguments · ${part.name}`}>
        {args.length === 0 ? (
          <span className="text-muted-foreground">None</span>
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
      </ToolDetail>
      <ToolDetail title={part.status === "error" ? "Error" : "Output"}>
        {part.output ? (
          <ToolText text={part.output} error={part.status === "error"} />
        ) : (
          !images.length && (
            <span className="text-muted-foreground">{part.status === "running" ? "Running…" : "No output"}</span>
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

/** The line a tool call shows: what it did and to what, linked to the slide it edited. */
function ToolSummary(props: {
  part: ToolPart;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  target: string;
  slide: string | null;
}) {
  const { part, icon: Icon, label, target, slide } = props;
  return (
    <button
      type="button"
      disabled={!slide}
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
        {slide && <span className="font-mono text-[0.95em] text-foreground/80"> · #{slide}</span>}
      </span>
      {part.status === "done" && slide && <Check className="size-3 shrink-0 text-success" />}
    </button>
  );
}
