import { ArrowUpDown, type LucideIcon, Paintbrush, Pencil, Plus, Trash2 } from "lucide-react";

import type { Change, DeckChanges, SlideChange, SlideStatus } from "../../lib/api";

/** How a kind of change looks: its name, icon, and colors for its badge and its ring. */
export type Mark = { label: string; icon: LucideIcon; color: string; ring: string };

/** What each kind of change looks like, everywhere in Git mode. */
export const MARKS: Record<Exclude<SlideStatus, "unchanged">, Mark> = {
  added: { label: "Added", icon: Plus, color: "bg-success text-success-foreground", ring: "ring-success" },
  modified: { label: "Modified", icon: Pencil, color: "bg-warning text-warning-foreground", ring: "ring-warning" },
  removed: {
    label: "Removed",
    icon: Trash2,
    color: "bg-destructive text-destructive-foreground",
    ring: "ring-destructive",
  },
  moved: { label: "Moved", icon: ArrowUpDown, color: "bg-info text-info-foreground", ring: "ring-info" },
};

/** What the slides share (styles, fonts, scripts), which is no slide's change. */
export const STYLES: Mark = {
  label: "Styles",
  icon: Paintbrush,
  color: MARKS.modified.color,
  ring: MARKS.modified.ring,
};

/**
 * What putting a change back as committed is called, since it is not the same thing for each: it
 * brings a removed slide back, but takes a new one away. `destructive` when work goes with it.
 */
export interface RestoreAction {
  label: string;
  /** What it does, as the button's tooltip says it. */
  title: string;
  destructive: boolean;
}

/** What restoring a change with `mark` does. */
export function restoreActionOf(mark: Mark): RestoreAction {
  switch (mark) {
    case MARKS.added:
      return {
        label: "Discard new slide",
        title: "Take this slide out: the last commit does not have it",
        destructive: true,
      };
    case MARKS.removed:
      return { label: "Bring back", title: "Put this slide back in the deck, as it was committed", destructive: false };
    case MARKS.moved:
      return { label: "Undo move", title: "Put this slide back where it was at the last commit", destructive: false };
    case STYLES:
      return {
        label: "Discard changes",
        title: "Put the shared styles back as committed, losing what changed since",
        destructive: true,
      };
    default:
      return {
        label: "Discard changes",
        title: "Put this slide back as committed, losing what changed since",
        destructive: true,
      };
  }
}

/** A change to stage or restore, what the buttons' tooltips call it, whether it is staged, and what restoring it does. */
export interface MarkActions {
  change: Change;
  noun: string;
  staged: boolean;
  restore: RestoreAction;
}

/** The actions of what the slides share. */
export const stylesActions = (staged: boolean): MarkActions => ({
  change: { kind: "styles" },
  noun: "the shared styles",
  staged,
  restore: restoreActionOf(STYLES),
});

/** The marks of a row: a slide can have changed and moved. */
export function marksOf(row: SlideChange): Mark[] {
  const marks = row.status === "unchanged" ? [] : [MARKS[row.status]];
  return row.moved && row.status !== "moved" ? [...marks, MARKS.moved] : marks;
}

/** The mark on the slide's picture: what changed in it, which a move is not. */
export function contentMarkOf(row: SlideChange): Mark | null {
  return row.status === "unchanged" || row.status === "moved" ? null : MARKS[row.status];
}

/** The change a mark of a row stands for, to stage or restore it. */
export function actionsOf(row: SlideChange, mark: Mark): MarkActions | null {
  const { id, oldId } = row;
  const restore = restoreActionOf(mark);
  if (mark !== MARKS.moved)
    return { change: { kind: "slide", id, oldId }, noun: "this slide", staged: row.staged, restore };
  return id && oldId
    ? { change: { kind: "move", id, oldId }, noun: "this move", staged: row.moveStaged, restore }
    : null;
}

/** What changed about a row, in words: "modified and moved". */
export const describeRow = (row: SlideChange) =>
  marksOf(row)
    .map((mark) => mark.label.toLowerCase())
    .join(" and ");

/** Whether the two versions of a slide can differ to the eye. */
export function comparable(row: SlideChange, changes: DeckChanges) {
  if (!row.id || !row.oldId) return false;
  return row.status === "modified" || changes.stylesChanged;
}

/** Each row's number in the deck; removed slides have none. */
export function slideNumbers(rows: SlideChange[]) {
  const numbers = new Map<string, number>();
  for (const row of rows) if (row.id) numbers.set(row.key, numbers.size + 1);
  return numbers;
}

/** How many rows have each kind of change that some row has, in the order the header shows them. */
export function changeCounts(rows: SlideChange[]): { status: keyof typeof MARKS; count: number }[] {
  return (["modified", "added", "removed", "moved"] as const)
    .map((status) => ({
      status,
      count: rows.filter((row) => (status === "moved" ? row.moved : row.status === status)).length,
    }))
    .filter(({ count }) => count > 0);
}

/** What the Stage / Unstage button of a change says it does. */
export const stageTitle = ({ staged, noun }: Pick<MarkActions, "staged" | "noun">) =>
  staged ? `Take ${noun} out of the next commit` : `Add ${noun} to the next commit`;

/** What the slide shown is, in words. */
export function caption(row: SlideChange, changes: DeckChanges): string {
  const place = row.moved ? ` It moved from slide ${row.oldNumber}.` : "";
  const styles = changes.stylesChanged ? " The deck's shared styles changed, so it may still look different." : "";
  const also = row.details.length > 0 ? ` Changed: ${row.details.join(", ")}.` : "";
  if (changes.tracking === "notCommitted")
    return `Not committed yet, so every slide is new; discarding one takes it out.${styles}`;
  switch (row.status) {
    case "added":
      return "New since the last commit.";
    case "removed":
      return "Removed since the last commit; this is how it looked.";
    case "modified":
      return `Modified since the last commit.${also}${place}`;
    case "moved":
      return `The same slide, moved from slide ${row.oldNumber}.${styles}`;
    case "unchanged":
      return `No changes to this slide.${styles}`;
  }
}

/**
 * Whether the deck is as its last commit has it, with nothing staged or left to stage: there is
 * nothing to commit then.
 */
export function isClean(changes: DeckChanges): boolean {
  return (
    changes.tracking === "committed" &&
    !changes.stylesChanged &&
    changes.stagedFiles === 0 &&
    !changes.hasUnstaged &&
    changes.slides.every((row) => row.status === "unchanged" && !row.moved)
  );
}

/** Whether the deck differs from its last commit in a way that can be discarded all at once. */
export function canDiscardAll(changes: DeckChanges): boolean {
  if (changes.tracking !== "committed") return false;
  return changes.stylesChanged || changes.slides.some((row) => row.status !== "unchanged" || row.moved);
}

/** Where the next commit goes: the branch's name, or that it goes to none. */
export function branchLabel(changes: Pick<DeckChanges, "branch" | "detached">): string | null {
  if (changes.detached) return "Detached HEAD";
  return changes.branch;
}
