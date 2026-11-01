import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

import { basename, cn } from "../lib/utils";
import { lintFixPrompt, useApp } from "../store";

/** Lint result for the deck file. When it has issues, clicking puts fix instructions in the chat. */
export function LintStatus() {
  const lint = useApp((s) => s.lint);
  const running = useApp((s) => s.running);
  const file = useApp((s) => basename(s.deck?.id ?? "") || "deck.html");

  if (lint === null) {
    return (
      <span
        title={`Checking ${file}…`}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground"
      >
        <Loader2 className="size-3.5 animate-spin" />
        Lint
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
        onClick={() => void useApp.getState().refreshLint()}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-success hover:bg-accent"
      >
        <CheckCircle2 className="size-3.5" />
        Lint OK
      </button>
    );
  }

  const Icon = errors > 0 ? XCircle : AlertTriangle;
  const summary = [
    errors > 0 && `${errors} ${errors === 1 ? "error" : "errors"}`,
    warnings > 0 && `${warnings} ${warnings === 1 ? "warning" : "warnings"}`,
  ]
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
      title={`${details}\n\nClick to ask the agent to fix ${lint.length === 1 ? "it" : "them"}.`}
      onClick={() => useApp.getState().fillComposer(lintFixPrompt(lint, file))}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50",
        errors > 0 ? "text-destructive" : "text-warning",
      )}
    >
      <Icon className="size-3.5" />
      Lint: {summary}
    </button>
  );
}
