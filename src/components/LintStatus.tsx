import { AlertTriangle, CheckCircle2, CircleAlert, RefreshCw, Sparkles, XCircle } from "lucide-react";
import { useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import type { LintIssue } from "../lib/api";
import { basename, cn, plural } from "../lib/utils";
import { lintFixPrompt, useApp } from "../store";

/**
 * Lint result for the deck file, in the stage's footer: a spinner while it is checked, a checkmark
 * when it passes (a click checks again), "Check failed" when the check itself went wrong (a click
 * tries again), or how many problems there are. That last one opens the list of them, with the
 * way to hand them to the agent.
 */
export function LintStatus() {
  const lint = useApp((s) => s.lint);
  const error = useApp((s) => s.lintError);
  const file = useApp((s) => basename(s.deck?.id ?? "") || "deck.html");
  const [open, setOpen] = useState(false);
  const ask = useRef<HTMLButtonElement>(null);
  const recheck = () => void useApp.getState().refreshLint();

  if (lint === null && error !== null) {
    return (
      <Button
        variant="ghost"
        size="xs"
        aria-label="Lint: the check failed. Check again"
        tooltip={
          <span className="whitespace-pre-line">{`${file} could not be checked: ${error}\nClick to check again.`}</span>
        }
        onClick={recheck}
        className="px-1.5 text-warning tabular-nums hover:text-warning"
      >
        <CircleAlert className="size-4" />
        Check failed
      </Button>
    );
  }

  if (lint === null) {
    return (
      <span title={`Checking ${file}…`} className="flex items-center px-1.5 py-1 text-muted-foreground">
        <Spinner aria-label="Lint: checking" />
      </span>
    );
  }

  if (lint.length === 0) {
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Lint OK"
        tooltip={`${file} passes lint. Click to check again.`}
        onClick={recheck}
        className="text-success hover:text-success"
      >
        <CheckCircle2 className="size-4" />
      </Button>
    );
  }

  const errors = lint.filter((i) => i.severity === "error").length;
  const summary = lintSummary(lint);
  // Its color says how bad it is, open or not.
  const tone =
    errors > 0
      ? "text-destructive hover:text-destructive aria-expanded:text-destructive"
      : "text-warning hover:text-warning aria-expanded:text-warning";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Lint: ${summary}`}
            tooltip={`${summary} in ${file}. Click to see ${lint.length === 1 ? "it" : "them"}.`}
            className={cn("px-1.5 tabular-nums", tone)}
          />
        }
      >
        {errors > 0 ? <XCircle className="size-4" /> : <AlertTriangle className="size-4" />}
        {plural(lint.length, "problem")}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        aria-label="Problems in the deck file"
        initialFocus={ask}
        className="max-h-[min(28rem,var(--available-height))] w-[440px] max-w-(--available-width) gap-0 p-0"
      >
        <LintIssues issues={lint} file={file} askRef={ask} onDone={() => setOpen(false)} onRecheck={recheck} />
      </PopoverContent>
    </Popover>
  );
}

/** How many of `issues` are errors, and how many warnings. */
function lintCounts(issues: LintIssue[]) {
  const errors = issues.filter((i) => i.severity === "error").length;
  return { errors, warnings: issues.length - errors };
}

/** "1 error, 2 warnings". */
function lintSummary(issues: LintIssue[]): string {
  const { errors, warnings } = lintCounts(issues);
  return [errors > 0 && plural(errors, "error"), warnings > 0 && plural(warnings, "warning")]
    .filter(Boolean)
    .join(", ");
}

/**
 * Every problem the lint found, errors first, each with its line: one on a slide goes to that
 * slide when pressed. Above them, how many there are of each kind; below them, the way to have
 * the agent fix them and to check again.
 */
function LintIssues(props: {
  issues: LintIssue[];
  file: string;
  /** The button the focus starts on. */
  askRef: React.Ref<HTMLButtonElement>;
  onDone: () => void;
  onRecheck: () => void;
}) {
  const { issues, file } = props;
  const running = useApp((s) => s.running);
  const slides = useApp((s) => s.deck?.slides);
  const { errors, warnings } = lintCounts(issues);
  const sorted = [...issues].sort(
    (a, b) => Number(b.severity === "error") - Number(a.severity === "error") || a.line - b.line,
  );
  const ask = () => {
    useApp.getState().fillComposer(lintFixPrompt(issues, file));
    props.onDone();
  };
  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
        <p className="mr-auto min-w-0 truncate text-xs font-medium">
          {lintSummary(issues)} in {file}
        </p>
        {errors > 0 && (
          <Badge variant="destructive" aria-hidden="true">
            <XCircle />
            {errors}
          </Badge>
        )}
        {warnings > 0 && (
          <Badge variant="outline" aria-hidden="true" className="text-warning">
            <AlertTriangle />
            {warnings}
          </Badge>
        )}
      </div>
      <ul aria-label="Problems" className="min-h-0 flex-1 overflow-y-auto p-1 text-xs">
        {sorted.map((issue, i) => {
          const onSlide = issue.slide !== null && slides?.some((s) => s.id === issue.slide);
          const row = (
            <>
              {issue.severity === "error" ? (
                <XCircle aria-label="Error" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              ) : (
                <AlertTriangle aria-label="Warning" className="mt-0.5 size-3.5 shrink-0 text-warning" />
              )}
              <span className="w-14 shrink-0 tabular-nums text-muted-foreground">Line {issue.line}</span>
              <span className="min-w-0 flex-1 break-words">
                {issue.message}
                {issue.slide && <span className="text-muted-foreground"> · slide {issue.slide}</span>}
              </span>
            </>
          );
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is rebuilt whole with every check
            <li key={i}>
              {onSlide ? (
                <Button
                  variant="ghost"
                  tooltip="Go to this slide"
                  tooltipSide="left"
                  onClick={() => useApp.getState().select(issue.slide)}
                  className="h-auto w-full items-start justify-start gap-2 px-2 py-1.5 text-left text-xs font-normal whitespace-normal"
                >
                  {row}
                </Button>
              ) : (
                <div className="flex items-start gap-2 px-2 py-1.5">{row}</div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t p-2">
        <Button variant="ghost" size="xs" onClick={props.onRecheck}>
          <RefreshCw data-icon="inline-start" />
          Check again
        </Button>
        <Button
          ref={props.askRef}
          size="xs"
          disabled={running}
          tooltip={
            running
              ? "The agent is at work; ask once it is done"
              : "Puts a message asking for the fixes in the chat, for you to send"
          }
          onClick={ask}
        >
          <Sparkles data-icon="inline-start" />
          Ask the agent to fix
        </Button>
      </div>
    </>
  );
}
