import { GitCompare, Loader2, RefreshCw } from "lucide-react";

import { useChanges } from "../changesStore";
import type { Deck } from "../lib/api";
import { useApp } from "../store";
import { Button } from "./Button";
import { ComparisonBar } from "./changes/ComparisonBar";
import { comparable } from "./changes/changeRows";
import { SlideArea } from "./changes/SlideArea";
import { useChangesKeyboard, useRefreshChanges } from "./changes/useChangesKeys";

export { ChangesRail } from "./changes/ChangesRail";

/**
 * The middle of Changes mode: the slide picked in the list, as it was in the last saved version
 * and as it is now. The list beside it is `ChangesRail`; both read ../changesStore.ts, and their
 * parts are in ./changes.
 */
export function ChangesView() {
  const deck = useApp((s) => s.deck);
  if (!deck) return null;
  return <Changes deck={deck} />;
}

function Changes({ deck }: { deck: Deck }) {
  const changes = useChanges((s) => (s.deck === deck.id ? s.changes : null));
  const error = useChanges((s) => (s.deck === deck.id ? s.error : null));
  const row = useChanges((s) => s.changes?.slides.find((r) => r.key === s.picked));
  useRefreshChanges(deck.id);
  useChangesKeyboard();

  if (error) {
    return (
      <Message title="Could not look for changes" role="alert">
        <span className="selectable whitespace-pre-wrap break-words">{error}</span>
        <Button className="mx-auto mt-3" onClick={() => void useChanges.getState().refresh(deck.id)}>
          <RefreshCw />
          Try again
        </Button>
      </Message>
    );
  }
  if (!changes) {
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center gap-2 bg-canvas text-xs text-muted-foreground"
      >
        <Loader2 className="size-3.5 animate-spin" />
        Looking for changes…
      </div>
    );
  }
  // Without a repository the mode is about to close; see ModeTabs.tsx.
  if (changes.tracking === "noRepository") return <div className="h-full bg-canvas" />;
  return (
    <div className="flex h-full flex-col">
      <ComparisonBar changes={changes} deck={deck.id} enabled={!!row && comparable(row, changes)} />
      {row ? (
        <SlideArea deck={deck} changes={changes} row={row} />
      ) : (
        <Message title="No slides">This deck has no slides, and its last version had none either.</Message>
      )}
    </div>
  );
}

function Message({ title, role, children }: { title: string; role?: "alert"; children: React.ReactNode }) {
  return (
    <div role={role} className="flex h-full flex-col items-center justify-center gap-2 bg-canvas p-6 text-center">
      <GitCompare className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      <div className="max-w-sm text-xs leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}
