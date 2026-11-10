import { describe, expect, it } from "vitest";

import type { DeckChanges, SlideChange, SlideStatus } from "../../lib/api";
import {
  actionsOf,
  caption,
  changeCounts,
  comparable,
  contentMarkOf,
  describeRow,
  MARKS,
  marksOf,
  slideNumbers,
  stageTitle,
} from "./changeRows";

const row = (status: SlideStatus, id: string, more: Partial<SlideChange> = {}): SlideChange => ({
  key: status === "removed" ? `removed:${id}` : id,
  status,
  id: status === "removed" ? null : id,
  oldId: status === "added" ? null : id,
  details: [],
  moved: false,
  oldNumber: status === "added" ? null : 1,
  staged: false,
  moveStaged: false,
  ...more,
});

const changes = (overrides: Partial<DeckChanges> = {}): DeckChanges => ({
  tracking: "committed",
  commit: { hash: "abc123", subject: "First draft" },
  stylesChanged: false,
  oldSize: null,
  slides: [],
  stylesStaged: false,
  stagedFiles: 0,
  stagedElsewhere: 0,
  hasUnstaged: true,
  ...overrides,
});

describe("a row's marks", () => {
  it("marks what changed, and a move beside it, but only the change on the picture", () => {
    const both = row("modified", "a", { moved: true, oldNumber: 3 });
    expect(marksOf(both)).toEqual([MARKS.modified, MARKS.moved]);
    expect(describeRow(both)).toBe("modified and moved");
    expect(contentMarkOf(both)).toBe(MARKS.modified);
    expect(marksOf(row("moved", "b", { moved: true }))).toEqual([MARKS.moved]);
    expect(contentMarkOf(row("moved", "b", { moved: true }))).toBeNull();
    expect(marksOf(row("unchanged", "c"))).toEqual([]);
  });

  it("stages the slide for its change and the move for its move, which needs both versions", () => {
    const both = row("modified", "a", { moved: true, staged: true });
    expect(actionsOf(both, MARKS.modified)).toEqual({
      change: { kind: "slide", id: "a", oldId: "a" },
      noun: "this slide",
      staged: true,
    });
    expect(actionsOf(both, MARKS.moved)).toEqual({
      change: { kind: "move", id: "a", oldId: "a" },
      noun: "this move",
      staged: false,
    });
    expect(actionsOf(row("added", "new", { moved: true }), MARKS.moved)).toBeNull();
    expect(stageTitle({ staged: false, noun: "this move" })).toBe("Add this move to the next commit");
    expect(stageTitle({ staged: true, noun: "this move" })).toBe("Take this move out of the next commit");
  });
});

describe("the list of rows", () => {
  it("numbers the slides in the deck, skipping the removed ones", () => {
    const rows = [row("modified", "a"), row("removed", "b"), row("added", "c")];
    expect([...slideNumbers(rows)]).toEqual([
      ["a", 1],
      ["c", 2],
    ]);
  });

  it("counts each kind of change there is, moves among them", () => {
    const rows = [row("modified", "a", { moved: true }), row("modified", "b"), row("unchanged", "c")];
    expect(changeCounts(rows)).toEqual([
      { status: "modified", count: 2 },
      { status: "moved", count: 1 },
    ]);
    expect(changeCounts([row("unchanged", "c")])).toEqual([]);
  });

  it("compares the versions of a modified slide, or of any slide once the shared styles changed", () => {
    expect(comparable(row("modified", "a"), changes())).toBe(true);
    expect(comparable(row("unchanged", "a"), changes())).toBe(false);
    expect(comparable(row("unchanged", "a"), changes({ stylesChanged: true }))).toBe(true);
    expect(comparable(row("added", "a"), changes({ stylesChanged: true }))).toBe(false);
  });
});

describe("the caption under the slide", () => {
  const STYLES = " The deck's shared styles changed, so it may still look different.";
  it.each([
    [row("added", "a"), changes(), "New since the last commit."],
    [row("removed", "a"), changes(), "Removed since the last commit; this is how it looked."],
    [
      row("modified", "a", { details: ["speaker notes", "timing"], moved: true, oldNumber: 4 }),
      changes(),
      "Modified since the last commit. Changed: speaker notes, timing. It moved from slide 4.",
    ],
    [row("moved", "a", { moved: true, oldNumber: 2 }), changes(), "The same slide, moved from slide 2."],
    [row("unchanged", "a"), changes({ stylesChanged: true }), `No changes to this slide.${STYLES}`],
    [
      row("added", "a"),
      changes({ tracking: "notCommitted", stylesChanged: true }),
      `Not committed yet, so every slide is new; restoring takes it out.${STYLES}`,
    ],
  ])("says what %#. is", (shown, deck, text) => {
    expect(caption(shown, deck)).toBe(text);
  });
});
