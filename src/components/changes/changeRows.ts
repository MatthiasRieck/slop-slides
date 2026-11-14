import { ArrowUpDown, type LucideIcon, Paintbrush, Pencil, Plus, Trash2 } from "lucide-react";

import type { Change, DeckChanges, SlideChange, SlideStatus } from "../../lib/api";
import { plural, relativeTime } from "../../lib/utils";

/** How a kind of change looks: its name, icon, and colors for its badge and its ring. */
export type Mark = { label: string; icon: LucideIcon; color: string; ring: string };

/** What each kind of change looks like, everywhere in Changes mode. */
export const MARKS: Record<Exclude<SlideStatus, "unchanged">, Mark> = {
  added: { label: "New", icon: Plus, color: "bg-success text-success-foreground", ring: "ring-success" },
  modified: { label: "Changed", icon: Pencil, color: "bg-warning text-warning-foreground", ring: "ring-warning" },
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
 * What putting a change back as it was in the last version is called, since it is not the same
 * thing for each: it brings a removed slide back, but takes a new one away. `destructive` when
 * work goes with it.
 */
export interface RestoreAction {
  label: string;
  /** What it does, as the button's tooltip says it. */
  title: string;
  /** What it did, as the message with the Undo says it. */
  done: string;
  destructive: boolean;
}

/** What restoring a change with `mark` does. */
export function restoreActionOf(mark: Mark): RestoreAction {
  switch (mark) {
    case MARKS.added:
      return {
        label: "Discard new slide",
        title: "Take this slide out: the last version does not have it",
        done: "Took the new slide out",
        destructive: true,
      };
    case MARKS.removed:
      return {
        label: "Bring back",
        title: "Put this slide back in the deck, as it was in the last version",
        done: "The slide is back in the deck",
        destructive: false,
      };
    case MARKS.moved:
      return {
        label: "Undo move",
        title: "Put this slide back where it was in the last version",
        done: "The slide is back where it was",
        destructive: false,
      };
    case STYLES:
      return {
        label: "Discard changes",
        title: "Put the shared styles back as in the last version, losing what changed since",
        done: "The shared styles are back as in the last version",
        destructive: true,
      };
    default:
      return {
        label: "Discard changes",
        title: "Put this slide back as in the last version, losing what changed since",
        done: "The slide is back as in the last version",
        destructive: true,
      };
  }
}

/** A change to include in the next version or to restore, what its controls call it, whether it is included, and what restoring it does. */
export interface MarkActions {
  change: Change;
  /** What the checkbox says it includes. */
  include: string;
  /** The index has it (git calls that staged): the next version takes it. */
  staged: boolean;
  restore: RestoreAction;
}

/** The actions of what the slides share. */
export const stylesActions = (staged: boolean): MarkActions => ({
  change: { kind: "styles" },
  include: "Include the shared styles in this version",
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

/** The change a mark of a row stands for, to include or restore it. */
export function actionsOf(row: SlideChange, mark: Mark): MarkActions | null {
  const { id, oldId } = row;
  const restore = restoreActionOf(mark);
  if (mark !== MARKS.moved) {
    return { change: { kind: "slide", id, oldId }, include: "Include in this version", staged: row.staged, restore };
  }
  return id && oldId
    ? { change: { kind: "move", id, oldId }, include: "Include the move", staged: row.moveStaged, restore }
    : null;
}

/** What changed about a row, in words: "changed and moved". */
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

/** What the slide shown is, in words. */
export function caption(row: SlideChange, changes: DeckChanges): string {
  const place = row.moved ? ` It moved from slide ${row.oldNumber}.` : "";
  const styles = changes.stylesChanged ? " The deck's shared styles changed, so it may still look different." : "";
  const also = row.details.length > 0 ? ` Also changed: ${row.details.join(", ")}.` : "";
  if (changes.tracking === "notCommitted") return "No version of this deck is saved yet.";
  switch (row.status) {
    case "added":
      return "New since the last version.";
    case "removed":
      return "Removed since the last version; this is how it looked.";
    case "modified":
      return `Changed since the last version.${also}${place}`;
    case "moved":
      return `The same slide, moved from slide ${row.oldNumber}.${styles}`;
    case "unchanged":
      return `No changes to this slide.${styles}`;
  }
}

/**
 * Whether the deck is as its last version has it, with nothing included or left to include:
 * there is nothing to save a version of then.
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

/** Whether the deck differs from its last version in a way that can be discarded all at once. */
export function canDiscardAll(changes: DeckChanges): boolean {
  if (changes.tracking !== "committed") return false;
  return changes.stylesChanged || changes.slides.some((row) => row.status !== "unchanged" || row.moved);
}

/** Where the next version goes: the branch's name, or that it goes to none. */
export function branchLabel(changes: Pick<DeckChanges, "branch" | "detached">): string | null {
  if (changes.detached) return "Not on a branch";
  return changes.branch;
}

/** The last version by its name and age: "“First draft”, 2d ago". */
export function lastVersion(commit: NonNullable<DeckChanges["commit"]>): string {
  return `“${commit.subject}”, ${relativeTime(commit.time * 1000)}`;
}

/** How many of the deck's changes are picked for the next version: slides, moves and the shared styles. */
export function includedCount(changes: Pick<DeckChanges, "slides" | "stylesStaged">): number {
  const slides = changes.slides.filter((row) => row.staged).length;
  const moves = changes.slides.filter((row) => row.moveStaged).length;
  return slides + moves + (changes.stylesStaged ? 1 : 0);
}

/**
 * A message for the next version, from what it takes in: "Change 3 slides, add 1, restyle". With
 * some changes picked it names those, else all of them. It is a start that can be typed over, so
 * that saving a version never waits for words.
 */
export function suggestMessage(changes: Pick<DeckChanges, "tracking" | "slides" | "stylesChanged" | "stylesStaged">) {
  if (changes.tracking === "notCommitted") return "First version";
  const picked = includedCount(changes) > 0;
  const rows = changes.slides;
  const taken = (row: SlideChange) => !picked || row.staged;
  const counts: [string, number][] = [
    ["change", rows.filter((row) => row.status === "modified" && taken(row)).length],
    ["add", rows.filter((row) => row.status === "added" && taken(row)).length],
    ["remove", rows.filter((row) => row.status === "removed" && taken(row)).length],
    // A slide that changed and moved is named as changed; its move counts when it is all that is taken.
    [
      "move",
      rows.filter((row) => row.moved && (picked ? row.moveStaged && !row.staged : row.status === "moved")).length,
    ],
  ];
  const parts = counts
    .filter(([, count]) => count > 0)
    // The first says what is counted, the others go without: "Change 3 slides, add 1".
    .map(([verb, count], at) => `${verb} ${at === 0 ? plural(count, "slide") : count}`);
  if (changes.stylesChanged && (!picked || changes.stylesStaged)) {
    parts.push(parts.length === 0 ? "update the shared styles" : "restyle");
  }
  const text = parts.length === 0 ? "update the deck" : parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The number of the first slide that changed and is locked, which keeps the deck from being discarded; null without one. */
export function lockedChange(slides: { id: string; locked?: boolean }[], changes: DeckChanges): number | null {
  const changed = new Set(changes.slides.filter((row) => row.status !== "unchanged" || row.moved).map((row) => row.id));
  const at = slides.findIndex((slide) => slide.locked && changed.has(slide.id));
  return at < 0 ? null : at + 1;
}
