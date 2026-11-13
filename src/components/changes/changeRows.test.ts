import { describe, expect, it } from "vitest";

import type { DeckChanges, SlideChange, SlideStatus } from "../../lib/api";
import {
  actionsOf,
  branchLabel,
  canDiscardAll,
  caption,
  changeCounts,
  comparable,
  contentMarkOf,
  describeRow,
  isClean,
  MARKS,
  marksOf,
  restoreActionOf,
  STYLES as STYLES_MARK,
  slideNumbers,
  stageTitle,
  stylesActions,
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
  branch: "main",
  detached: false,
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
      restore: restoreActionOf(MARKS.modified),
    });
    expect(actionsOf(both, MARKS.moved)).toEqual({
      change: { kind: "move", id: "a", oldId: "a" },
      noun: "this move",
      staged: false,
      restore: restoreActionOf(MARKS.moved),
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
      `Not committed yet, so every slide is new; discarding one takes it out.${STYLES}`,
    ],
  ])("says what %#. is", (shown, deck, text) => {
    expect(caption(shown, deck)).toBe(text);
  });
});

describe("putting a change back", () => {
  it("is named by what it does to the change, and marked where work goes with it", () => {
    expect(restoreActionOf(MARKS.added)).toMatchObject({ label: "Discard new slide", destructive: true });
    expect(restoreActionOf(MARKS.removed)).toMatchObject({ label: "Bring back", destructive: false });
    expect(restoreActionOf(MARKS.modified)).toMatchObject({ label: "Discard changes", destructive: true });
    expect(restoreActionOf(MARKS.moved)).toMatchObject({ label: "Undo move", destructive: false });
    expect(restoreActionOf(STYLES_MARK)).toMatchObject({ label: "Discard changes", destructive: true });
    expect(restoreActionOf(STYLES_MARK).title).toContain("shared styles");
    expect(restoreActionOf(MARKS.added).title).toContain("Take this slide out");
  });

  it("gives the shared styles their actions", () => {
    expect(stylesActions(true)).toEqual({
      change: { kind: "styles" },
      noun: "the shared styles",
      staged: true,
      restore: restoreActionOf(STYLES_MARK),
    });
  });
});

describe("the deck as a whole", () => {
  const unchanged = [row("unchanged", "a"), row("unchanged", "b")];
  const clean = { slides: unchanged, hasUnstaged: false };

  it("is clean when nothing differs from the commit and nothing waits for one", () => {
    expect(isClean(changes(clean))).toBe(true);
    expect(isClean(changes({ ...clean, stylesChanged: true }))).toBe(false);
    expect(isClean(changes({ ...clean, stagedFiles: 1 }))).toBe(false);
    expect(isClean(changes({ ...clean, hasUnstaged: true }))).toBe(false);
    expect(isClean(changes({ ...clean, slides: [row("modified", "a")] }))).toBe(false);
    expect(isClean(changes({ ...clean, slides: [row("unchanged", "a", { moved: true })] }))).toBe(false);
    expect(isClean(changes({ ...clean, tracking: "notCommitted" }))).toBe(false);
  });

  it("can be discarded all at once when a commit has it and something changed", () => {
    expect(canDiscardAll(changes(clean))).toBe(false);
    expect(canDiscardAll(changes({ ...clean, hasUnstaged: true }))).toBe(false);
    expect(canDiscardAll(changes({ slides: [row("added", "a")] }))).toBe(true);
    expect(canDiscardAll(changes({ ...clean, stylesChanged: true }))).toBe(true);
    expect(canDiscardAll(changes({ slides: [row("unchanged", "a", { moved: true })] }))).toBe(true);
    expect(canDiscardAll(changes({ tracking: "notCommitted", slides: [row("added", "a")] }))).toBe(false);
  });

  it("says where the next commit goes", () => {
    expect(branchLabel({ branch: "talks/q3", detached: false })).toBe("talks/q3");
    expect(branchLabel({ branch: null, detached: true })).toBe("Detached HEAD");
    expect(branchLabel({ branch: null, detached: false })).toBeNull();
  });
});
