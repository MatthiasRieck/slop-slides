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

/** A change to stage or restore, what the buttons' tooltips call it, and whether it is staged. */
export interface MarkActions {
  change: Change;
  noun: string;
  staged: boolean;
}

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
  if (mark !== MARKS.moved) return { change: { kind: "slide", id, oldId }, noun: "this slide", staged: row.staged };
  return id && oldId ? { change: { kind: "move", id, oldId }, noun: "this move", staged: row.moveStaged } : null;
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
    return `Not committed yet, so every slide is new; restoring takes it out.${styles}`;
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
