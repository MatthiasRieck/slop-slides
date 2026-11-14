import { ArrowLeftRight, RefreshCw } from "lucide-react";

import { type CompareView, shownView, useChanges } from "../../changesStore";
import type { DeckChanges } from "../../lib/api";
import { cn } from "../../lib/utils";
import { keepFocus, ToolButton } from "../Button";
import { lastVersion } from "./changeRows";
import { SavedWithGit } from "./marks";
import { holdToFlip } from "./useChangesKeys";

const VIEWS: { id: CompareView; label: string; title: string }[] = [
  { id: "split", label: "Split", title: "Before and after, split by a divider you can drag" },
  { id: "before", label: "Before", title: "The slide as it was in the last version" },
  { id: "after", label: "After", title: "The slide as it is now" },
];

/**
 * Over the slide: which version it is compared with, how the two show (split, or one of them),
 * and a button that, held, shows the other one in place. `enabled` while the slide picked has two
 * versions to show.
 */
export function ComparisonBar({ changes, deck, enabled }: { changes: DeckChanges; deck: string; enabled: boolean }) {
  const view = useChanges((s) => s.view);
  const flipped = useChanges((s) => s.flipped);
  const loading = useChanges((s) => s.loading);
  const { commit } = changes;
  const shown = shownView(view, enabled && flipped);
  return (
    <div className="relative z-20 flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-3 py-1 text-xs text-muted-foreground">
      <span
        className="min-w-24 flex-1 truncate"
        title={commit ? `Compared with the last version: ${commit.subject} (${commit.hash})` : undefined}
      >
        {commit ? `Since ${lastVersion(commit)}` : "No version saved yet"}
      </span>
      <SavedWithGit changes={changes} className="max-w-40 shrink-0" />
      <fieldset aria-label="Show" className="flex shrink-0 overflow-hidden rounded-md border">
        {VIEWS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={shown === option.id}
            disabled={!enabled}
            title={enabled ? option.title : "This slide has one version to show"}
            // The focus stays where it was, so that Space goes on flipping the slide.
            onMouseDown={keepFocus}
            onClick={() => useChanges.getState().setView(option.id)}
            className="px-2 py-1 font-medium enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-40 aria-pressed:enabled:bg-accent aria-pressed:enabled:text-foreground"
          >
            {option.label}
          </button>
        ))}
      </fieldset>
      <ToolButton
        variant="plain"
        label="Hold to see the other version"
        shortcut="space"
        disabled={!enabled}
        disabledReason="This slide has one version to show"
        active={enabled && flipped}
        {...holdToFlip()}
      >
        <ArrowLeftRight className="size-3.5" />
      </ToolButton>
      <ToolButton
        variant="plain"
        label="Look for changes again"
        onClick={() => void useChanges.getState().refresh(deck)}
      >
        <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
      </ToolButton>
    </div>
  );
}
