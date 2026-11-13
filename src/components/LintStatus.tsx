import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

import { basename, cn, plural } from "../lib/utils";
import { lintFixPrompt, useApp } from "../store";

/**
 * Lint result for the deck file, kept small: a checkmark, or the error and warning icons with their
 * counts. The tooltip lists the issues; clicking puts fix instructions in the chat.
 */
export function LintStatus() {
  const lint = useApp((s) => s.lint);
  const running = useApp((s) => s.running);
  const file = useApp((s) => basename(s.deck?.id ?? "") || "deck.html");
  const base = "flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium tabular-nums";

  if (lint === null) {
    return (
      <span
        role="status"
        title={`Checking ${file}…`}
        aria-label="Lint: checking"
        className={cn(base, "text-muted-foreground")}
      >
        <Loader2 className="size-4 animate-spin" />
      </span>
    );
  }

  const errors = lint.filter((i) => i.severity === "error").length;
  const warnings = lint.length - errors;
  if (lint.length === 0) {
    return (
      <button
        type="button"
        title={`${file} passes lint. Click to check again.`}
        aria-label="Lint OK"
        onClick={() => void useApp.getState().refreshLint()}
        className={cn(base, "text-success hover:bg-accent")}
      >
        <CheckCircle2 className="size-4" />
      </button>
    );
  }

  const summary = [errors > 0 && plural(errors, "error"), warnings > 0 && plural(warnings, "warning")]
    .filter(Boolean)
    .join(", ");
  const details = lint
    .slice(0, 8)
    .map((i) => `Line ${i.line}: ${i.message}`)
    .concat(lint.length > 8 ? [`…and ${lint.length - 8} more`] : [])
    .join("\n");
  return (
    <button
      type="button"
      disabled={running}
      aria-label={`Lint: ${summary}`}
      title={`${summary}\n${details}\n\nClick to ask the agent to fix ${lint.length === 1 ? "it" : "them"}.`}
      onClick={() => useApp.getState().fillComposer(lintFixPrompt(lint, file))}
      className={cn(base, "gap-2 hover:bg-accent disabled:opacity-40")}
    >
      {errors > 0 && (
        <span data-testid="lint-errors" className="flex items-center gap-1 text-destructive">
          <XCircle className="size-4" />
          {errors}
        </span>
      )}
      {warnings > 0 && (
        <span data-testid="lint-warnings" className="flex items-center gap-1 text-warning">
          <AlertTriangle className="size-4" />
          {warnings}
        </span>
      )}
    </button>
  );
}
