import { Check, X } from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { Spinner } from "@/components/ui/spinner";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { useSeen } from "../../hooks/useSeen";
import { slideNumbers } from "../../lib/slideNumbers";
import { workspaceChatFileUrl } from "../../lib/utils";
import { useApp } from "../../store";
import { SECTION_HEADING } from "../styles";
import {
  describeTool,
  type EditLine,
  editedIds,
  editedSlide,
  editLines,
  stepsLabel,
  type ToolPart,
  textLanguage,
  toolArguments,
} from "./toolCalls";

/** The arguments of an edit that its changes are read from (see `editLines`). */
const EDIT_TEXTS = ["old_string", "new_string"];

/** Tool calls of a finished reply that followed one another, as one line that unfolds into them. */
export const ToolSteps = memo(function ToolSteps({ tools }: { tools: ToolPart[] }) {
  const [open, setOpen] = useState(false);
  const failed = tools.some((tool) => tool.status === "error");
  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger title={open ? "Hide the steps" : "Show each step"}>
          <TraceLine status={failed ? "error" : undefined} className="text-xs">
            {failed && (
              <TraceIcon>
                <X className="size-3.5" />
              </TraceIcon>
            )}
            <TraceTitle>{stepsLabel(tools)}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {tools.map((tool) => (
              <ToolRow key={tool.id} part={tool} />
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
});

/**
 * A tool call of the agent's, as a line of the reply's trace: pressed, its arguments and output
 * unfold beneath it; an edit of the deck's slide names that slide beside it, which selects it
 * when pressed.
 *
 * A transcript holds hundreds of these, and the deck changes with every save, in bursts while
 * the agent writes. So a row takes of the deck only what it shows, as plain values that stay the
 * same from one save to the next (the deck's id, the id of the slide it edited), and reads its
 * own edit once. For the same reason it has no tooltips: each would be a component more per row.
 */
export const ToolRow = memo(function ToolRow({ part }: { part: ToolPart }) {
  const deckId = useApp((s) => s.deck?.id ?? "");
  const { icon: Icon, label, target } = useMemo(() => describeTool(part, deckId), [part, deckId]);
  const edited = useMemo(() => editedIds(part, target, deckId), [part, target, deckId]);
  const slide = useApp((s) => (s.deck && edited.length > 0 ? editedSlide(edited, slideNumbers(s.deck.slides)) : null));
  const [open, setOpen] = useState(false);
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 items-center gap-1">
        <TraceCollapsibleTrigger
          aria-label={`${open ? "Hide" : "Show"} arguments and output of ${label}${target ? ` ${target}` : ""}`}
          title={open ? "Hide arguments and output" : "Show arguments and output"}
        >
          <TraceLine
            status={part.status === "running" ? "running" : part.status === "error" ? "error" : undefined}
            className="text-xs"
          >
            <TraceIcon>
              {part.status === "running" ? (
                <Spinner aria-hidden="true" className="size-3.5" />
              ) : part.status === "error" ? (
                <X className="size-3.5" />
              ) : (
                <Icon className="size-3.5" />
              )}
            </TraceIcon>
            <TraceTitle>
              {label}
              {target && <span className="font-mono text-[0.95em] text-foreground/80"> {target}</span>}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        {slide && (
          <Button
            variant="ghost"
            size="2xs"
            aria-label={`Go to the slide ${slide}`}
            onClick={() => useApp.getState().select(slide)}
            className="min-w-0 shrink font-mono font-normal text-muted-foreground"
          >
            <span className="truncate">· #{slide}</span>
            {part.status === "done" && <Check className="text-success" />}
          </Button>
        )}
      </div>
      <TraceCollapsibleContent>
        <ToolDetails part={part} />
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
});

/** What a tool call was given and what it gave back, unfolded beneath its row. */
function ToolDetails({ part }: { part: ToolPart }) {
  const edit = editLines(part);
  // An edit shows what it changed line by line, in place of the two texts it was given.
  const args = toolArguments(part).filter((arg) => !edit || !EDIT_TEXTS.includes(arg.name));
  const images = part.images ?? [];
  const path = typeof part.input.file_path === "string" ? part.input.file_path : "";
  const failed = part.status === "error";
  return (
    <div className="selectable flex min-w-0 flex-col gap-2 text-xs">
      <ToolDetail title={`Arguments · ${part.name}`}>
        {args.length === 0 && !edit && <span className="text-muted-foreground">None</span>}
        {args.map((arg) => (
          <ToolText
            key={arg.name}
            title={arg.name}
            text={arg.value}
            language={textLanguage(arg.name, arg.value, path)}
          />
        ))}
        {edit && <ToolDiff lines={edit} />}
      </ToolDetail>
      <ToolDetail title={failed ? "Error" : "Output"}>
        {part.output ? (
          <ToolText text={part.output} error={failed} language={failed ? "" : textLanguage("", part.output, "")} />
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
    <section className="flex min-w-0 flex-col gap-1.5">
      <h4 className={SECTION_HEADING}>{props.title}</h4>
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

/**
 * Text of a tool call as it was written, as a block of code to scroll and copy: an argument
 * under its name (`title`), or the output. What reads as JSON is colored as such, once it has
 * come near what shows; a text as long as a whole deck stays plain (see `useHighlightedCode`).
 */
function ToolText(props: { text: string; language: string; title?: string; error?: boolean }) {
  const { text, title, error } = props;
  const block = useRef<HTMLDivElement>(null);
  const lines = useHighlightedCode(text, props.language, useSeen(block));
  return (
    <CodeBlock ref={block} size="sm" variant={error ? "destructive" : "default"}>
      {title ? (
        <CodeBlockHeader>
          <CodeBlockTitle className="font-mono font-normal text-muted-foreground">{title}</CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton value={text} />
          </CodeBlockActions>
        </CodeBlockHeader>
      ) : (
        <CodeBlockActions>
          <CodeBlockCopyButton value={text} />
        </CodeBlockActions>
      )}
      <CodeBlockContent wrap tabIndex={0} className="max-h-60">
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a text that does not change
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/** What an edit took out and put in, line by line. */
function ToolDiff({ lines }: { lines: EditLine[] }) {
  return (
    <CodeBlock size="sm" aria-label="Changes">
      <CodeBlockHeader>
        <CodeBlockTitle className="font-normal text-muted-foreground">Changes</CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent wrap tabIndex={0} className="max-h-60 ps-6">
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines of an edit that does not change
          <CodeBlockLine key={index} variant={line.change}>
            {line.text}
          </CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}
