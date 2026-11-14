import { AlertTriangle, CheckCircle2, CircleAlert, Code2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { useRef, useState } from "react";

import type { LintIssue } from "../lib/api";
import { basename, cn, plural } from "../lib/utils";
import { lintFixPrompt, showSuccess, useApp } from "../store";
import { Button, ToolButton } from "./Button";
import { Popover } from "./Popover";
import { AgentMark } from "./stage/SlideLayoutTools";

/**
 * The check of the deck file for problems, as a status in the row under the slide, always with
 * words: "Checking…" while it runs, "No problems" when it passes (a click checks again, and says
 * what came of it), "Check failed" when the check itself went wrong (a click tries again), or how
 * many problems there are. That last one opens the list of them, with the way to hand them to
 * the agent. `nameClass` is for the words beside the icon, which a narrow row hides.
 */
export function LintStatus({ nameClass }: { nameClass?: string }) {
  const lint = useApp((s) => s.lint);
  const error = useApp((s) => s.lintError);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  /** Checks again because the user asked, so the answer is said even when nothing changed. */
  const recheck = async () => {
    const checked = await useApp.getState().refreshLint();
    const found = useApp.getState().lint;
    if (!checked || !found) return;
    if (found.length === 0) showSuccess("No problems found in the deck");
    else showSuccess(`Checked again: ${plural(found.length, "problem")} in the deck`);
  };

  if (lint === null && error !== null) {
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label="The deck could not be checked. Check again"
        title={`The deck could not be checked for problems: ${error}\nClick to check again.`}
        onClick={() => void recheck()}
        className="text-warning"
      >
        <CircleAlert />
        <span className={nameClass}>Check failed</span>
      </Button>
    );
  }

  if (lint === null) {
    return (
      <span
        role="status"
        aria-label="Checking the deck for problems"
        title="Checking the deck for problems…"
        className="flex h-6 shrink-0 items-center gap-1 px-2 text-xs"
      >
        <Loader2 className="size-3.5 animate-spin" />
        <span className={nameClass}>Checking…</span>
      </span>
    );
  }

  if (lint.length === 0) {
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label="No problems"
        title="No problems found in the deck. Click to check again."
        onClick={() => void recheck()}
      >
        <CheckCircle2 className="text-success" />
        <span className={nameClass}>No problems</span>
      </Button>
    );
  }

  const errors = lint.filter((i) => i.severity === "error").length;
  const summary = lintSummary(lint);
  return (
    <>
      <Button
        ref={anchor}
        variant="ghost"
        size="sm"
        aria-label={`${plural(lint.length, "problem")} in the deck: ${summary}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${plural(lint.length, "problem")} in the deck (${summary}). Click to see ${lint.length === 1 ? "it" : "them"}.`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "font-medium tabular-nums",
          errors > 0 ? "text-destructive" : "text-warning",
          open && "bg-accent",
        )}
      >
        {errors > 0 ? <XCircle /> : <AlertTriangle />}
        {lint.length}
        <span className={nameClass}>{lint.length === 1 ? "problem" : "problems"}</span>
      </Button>
      {open && (
        <Popover
          anchor={anchor}
          placement="above"
          align="end"
          width={440}
          label="Problems in the deck"
          onClose={() => setOpen(false)}
        >
          <LintIssues issues={lint} onDone={() => setOpen(false)} onRecheck={() => void recheck()} />
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
 * Every problem the check found, errors first, each named by the slide it is on (by its number,
 * as everywhere else): pressing one goes to that slide, and the button at its end opens the line
 * in the deck's code, in the sidebar. Below them, the way to have the agent fix them and to check again.
 */
function LintIssues(props: { issues: LintIssue[]; onDone: () => void; onRecheck: () => void }) {
  const { issues } = props;
  const running = useApp((s) => s.running);
  const slides = useApp((s) => s.deck?.slides);
  const sorted = [...issues].sort(
    (a, b) => Number(b.severity === "error") - Number(a.severity === "error") || a.line - b.line,
  );
  const ask = () => {
    const file = basename(useApp.getState().deck?.id ?? "") || "deck.html";
    useApp.getState().fillComposer(lintFixPrompt(issues, file));
    props.onDone();
  };
  /** Shows the line the problem is on in the deck's code, on its slide when it has one. */
  const showInCode = (issue: LintIssue, onSlide: boolean) => {
    if (onSlide) useApp.getState().select(issue.slide);
    useApp.getState().revealCodeLine(issue.line);
    props.onDone();
  };
  return (
    <>
      <p className="shrink-0 border-b px-3 py-2 text-xs font-medium">
        {plural(issues.length, "problem")} in the deck: {lintSummary(issues)}
      </p>
      <ul aria-label="Problems" className="min-h-0 flex-1 overflow-y-auto p-1 text-xs">
        {sorted.map((issue, i) => {
          const number = issue.slide === null ? 0 : (slides?.findIndex((s) => s.id === issue.slide) ?? -1) + 1;
          const where = number > 0 ? `Slide ${number}` : "Deck";
          const row = (
            <>
              {issue.severity === "error" ? (
                <XCircle aria-label="Error" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              ) : (
                <AlertTriangle aria-label="Warning" className="mt-0.5 size-3.5 shrink-0 text-warning" />
              )}
              <span className="w-14 shrink-0 tabular-nums text-muted-foreground">{where}</span>
              <span className="min-w-0 flex-1 break-words">{issue.message}</span>
            </>
          );
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is rebuilt whole with every check
            <li key={i} className="flex items-start gap-1">
              {number > 0 ? (
                <button
                  type="button"
                  title="Go to this slide"
                  onClick={() => useApp.getState().select(issue.slide)}
                  className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  {row}
                </button>
              ) : (
                <div className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5">{row}</div>
              )}
              <ToolButton
                variant="panel"
                label={`Show line ${issue.line} in the code`}
                onClick={() => showInCode(issue, number > 0)}
                className="mt-0.5 shrink-0"
              >
                <Code2 className="size-3.5" />
              </ToolButton>
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
          data-autofocus
          disabled={running}
          title={
            running
              ? "The agent is at work: ask once it is done"
              : "Puts a message asking for the fixes in the chat, for you to send · asks the agent"
          }
          onClick={ask}
        >
          Fix the problems…
          <AgentMark />
        </Button>
      </div>
    </>
  );
}
