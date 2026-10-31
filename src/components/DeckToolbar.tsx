import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, type Deck, errorMessage } from "../lib/api";
import { basename, cn } from "../lib/utils";
import { deckMode, lintFixPrompt, useApp } from "../store";
import { SlideSearch } from "./FindReplace";
import { NarrationPanel } from "./NarrationPanel";
import { NotesPanel } from "./NotesPanel";
import { SlideSizeButton } from "./SlideSize";
import { SlideTime } from "./SlideTime";

/**
 * The row under the top bar, which holds the tools of the mode the deck is in. In View and HTML
 * it has the title, the slide size and lint, and in View the search; in Narration and Notes, those.
 * The stage draws this row itself in Edit, whose tools work on the slide it shows, and adds a row
 * of its own under this one in View, for marks and comments.
 */
export function DeckToolbar() {
  const deck = useApp((s) => s.deck);
  const mode = useApp(deckMode);
  if (!deck || mode === "edit") return null;
  if (mode === "narration") return <NarrationPanel />;
  if (mode === "notes") return <NotesPanel />;
  return <DeckTools deck={deck} />;
}

function DeckTools({ deck }: { deck: Deck }) {
  const mode = useApp(deckMode);
  const [title, setTitle] = useState(deck.title);
  // Escape blurs the field, and blur commits; this keeps that blur from saving the edit.
  const cancelled = useRef(false);

  useEffect(() => setTitle(deck.title), [deck.title]);

  const commitTitle = async () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = title.trim();
    if (!next || next === deck.title) return setTitle(deck.title);
    try {
      useApp.getState().setDeck(await api.renameDeck(deck.id, next));
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

  return (
    <div role="toolbar" aria-label="Deck" className="flex h-10 shrink-0 items-center gap-2 border-b bg-background px-3">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            setTitle(deck.title);
            e.currentTarget.blur();
          }
        }}
        title={deck.path}
        aria-label="Deck title"
        className="min-w-0 max-w-md flex-1 truncate rounded-md bg-transparent px-1.5 py-1 text-sm font-medium outline-none hover:bg-accent focus:bg-accent"
      />
      <div className="flex-1" />
      {mode === "view" && <SlideTime deck={deck} />}
      {mode === "view" && <SlideSearch />}
      <SlideSizeButton />
      <LintStatus />
    </div>
  );
}

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
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-emerald-600 hover:bg-accent"
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
        errors > 0 ? "text-destructive" : "text-amber-600",
      )}
    >
      <Icon className="size-3.5" />
      Lint: {summary}
    </button>
  );
}
