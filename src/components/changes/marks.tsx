import { AlertTriangle, GitBranch } from "lucide-react";

import { useChanges } from "../../changesStore";
import type { DeckChanges } from "../../lib/api";
import { cn } from "../../lib/utils";
import { branchLabel, type Mark, type MarkActions } from "./changeRows";

/** A kind of change in the header, with how many slides have it. Every badge has the same height and icon box. */
export function CountBadge(props: { mark: Mark; title: string; count?: number }) {
  const { icon: Icon, color } = props.mark;
  return (
    <span
      data-testid="count-badge"
      title={props.title}
      className={cn(
        "flex h-4 shrink-0 items-center gap-0.5 rounded px-1 text-2xs font-medium leading-none tabular-nums",
        color,
      )}
    >
      <Icon className="size-3 shrink-0" />
      {props.count}
    </span>
  );
}

/** The round icon of a kind of change. */
export function MarkBadge({ mark, small, className }: { mark: Mark; small?: boolean; className?: string }) {
  const { label, icon: Icon, color } = mark;
  return (
    <span
      data-testid="change-mark"
      title={label}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full shadow-md",
        small ? "size-4" : "size-6",
        color,
        className,
      )}
    >
      <Icon className={small ? "size-2.5" : "size-3.5"} />
    </span>
  );
}

/**
 * How versions are kept, for those who want to know: with Git, and on which branch the next one
 * goes. Quiet, since making slides needs neither word; a warning only when no branch is checked
 * out, as a version saved then is easy to lose.
 */
export function SavedWithGit({ changes, className }: { changes: DeckChanges; className?: string }) {
  const label = branchLabel(changes);
  if (!label) return null;
  return (
    <span
      data-testid="branch"
      title={
        changes.detached
          ? "Versions are saved with Git. An earlier version is checked out, not a branch: a version saved now is on no branch"
          : `Versions are saved with Git, on the branch ${label}`
      }
      className={cn(
        "flex min-w-0 items-center gap-1",
        changes.detached ? "font-medium text-warning" : "text-muted-foreground",
        className,
      )}
    >
      {changes.detached ? <AlertTriangle className="size-3 shrink-0" /> : <GitBranch className="size-3 shrink-0" />}
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * The checkbox that picks a change for the next version. With `text` it is a labelled row; without,
 * just the box, named by `actions.include` for screen readers and in its tooltip.
 */
export function IncludeCheckbox(props: { deck: string; actions: MarkActions; text?: string; className?: string }) {
  const { deck, actions, text, className } = props;
  const toggle = () => {
    const { stage, unstage } = useChanges.getState();
    void (actions.staged ? unstage : stage)(deck, actions.change);
  };
  const hint = actions.staged
    ? "The next version takes this in. Clear it to leave it out"
    : "Tick to save a version of only what is ticked. With nothing ticked, a version takes in everything";
  return (
    <label
      title={text ? hint : `${actions.include}. ${hint}`}
      className={cn("flex shrink-0 cursor-pointer items-center gap-1.5", className)}
    >
      <input
        type="checkbox"
        aria-label={text ? undefined : actions.include}
        checked={actions.staged}
        onChange={toggle}
        className="size-3.5 shrink-0 cursor-pointer accent-primary"
      />
      {text}
    </label>
  );
}
