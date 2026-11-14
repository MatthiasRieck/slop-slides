import { AlertTriangle, CheckCircle2, CircleAlert, Loader2, RefreshCw, Sparkles, XCircle } from "lucide-react";
import { useRef, useState } from "react";

import type { LintIssue } from "../lib/api";
import { basename, cn, plural } from "../lib/utils";
import { lintFixPrompt, useApp } from "../store";
import { Button } from "./Button";
import { Popover } from "./Popover";

const BASE = "flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium tabular-nums";

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
  const anchor = useRef<HTMLButtonElement>(null);
  const recheck = () => void useApp.getState().refreshLint();

  if (lint === null && error !== null) {
    return (
      <button
        type="button"
        aria-label="Lint: the check failed. Check again"
        title={`${file} could not be checked: ${error}\nClick to check again.`}
        onClick={recheck}
        className={cn(BASE, "text-warning hover:bg-accent")}
      >
        <CircleAlert className="size-4" />
        Check failed
      </button>
    );
  }

  if (lint === null) {
    return (
      <span
        role="status"
        title={`Checking ${file}…`}
        aria-label="Lint: checking"
        className={cn(BASE, "text-muted-foreground")}
      >
        <Loader2 className="size-4 animate-spin" />
      </span>
    );
  }

  if (lint.length === 0) {
    return (
      <button
        type="button"
        title={`${file} passes lint. Click to check again.`}
        aria-label="Lint OK"
        onClick={recheck}
        className={cn(BASE, "text-success hover:bg-accent")}
      >
        <CheckCircle2 className="size-4" />
      </button>
    );
  }

  const errors = lint.filter((i) => i.severity === "error").length;
  const summary = lintSummary(lint);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={`Lint: ${summary}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${summary} in ${file}. Click to see ${lint.length === 1 ? "it" : "them"}.`}
        onClick={() => setOpen((v) => !v)}
        className={cn(BASE, "hover:bg-accent", errors > 0 ? "text-destructive" : "text-warning", open && "bg-accent")}
      >
        {errors > 0 ? <XCircle className="size-4" /> : <AlertTriangle className="size-4" />}
        {plural(lint.length, "problem")}
      </button>
      {open && (
        <Popover
          anchor={anchor}
          placement="above"
          align="end"
          width={440}
          label="Problems in the deck file"
          onClose={() => setOpen(false)}
        >
          <LintIssues issues={lint} file={file} onDone={() => setOpen(false)} onRecheck={recheck} />
        </Popover>
      )}
    </>
  );
}

/** "1 error, 2 warnings". */
function lintSummary(issues: LintIssue[]): string {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  return [errors > 0 && plural(errors, "error"), warnings > 0 && plural(warnings, "warning")]
    .filter(Boolean)
    .join(", ");
}

/**
 * Every problem the lint found, errors first, each with its line: one on a slide goes to that
 * slide when pressed. Below them, the way to have the agent fix them and to check again.
 */
function LintIssues(props: { issues: LintIssue[]; file: string; onDone: () => void; onRecheck: () => void }) {
  const { issues, file } = props;
  const running = useApp((s) => s.running);
  const slides = useApp((s) => s.deck?.slides);
  const sorted = [...issues].sort(
    (a, b) => Number(b.severity === "error") - Number(a.severity === "error") || a.line - b.line,
  );
  const ask = () => {
    useApp.getState().fillComposer(lintFixPrompt(issues, file));
    props.onDone();
  };
  return (
    <>
      <p className="shrink-0 border-b px-3 py-2 text-xs font-medium">
        {lintSummary(issues)} in {file}
      </p>
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
                <button
                  type="button"
                  title="Go to this slide"
                  onClick={() => useApp.getState().select(issue.slide)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  {row}
                </button>
              ) : (
                <div className="flex items-start gap-2 px-2 py-1.5">{row}</div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t p-2">
        <Button variant="ghost" onClick={props.onRecheck}>
          <RefreshCw />
          Check again
        </Button>
        <Button
          variant="primary"
          data-autofocus
          disabled={running}
          title={
            running
              ? "The agent is at work; ask once it is done"
              : "Puts a message asking for the fixes in the chat, for you to send"
          }
          onClick={ask}
        >
          <Sparkles />
          Ask the agent to fix
        </Button>
      </div>
    </>
  );
}
