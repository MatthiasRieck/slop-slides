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
  includedCount,
  isClean,
  lockedChange,
  MARKS,
  marksOf,
  restoreActionOf,
  STYLES as STYLES_MARK,
  slideNumbers,
  stylesActions,
  suggestMessage,
} from "./changeRows";

const row = (status: SlideStatus, id: string, more: Partial<SlideChange> = {}): SlideChange => ({
  key: status === "removed" ? `removed:${id}` : id,
  status,
  id: status === "removed" ? null : id,
  oldId: status === "added" ? null : id,
  details: [],
  textChanges: [],
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
  commit: { hash: "abc123", subject: "First draft", time: 1_700_000_000 },
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
    expect(describeRow(both)).toBe("changed and moved");
    expect(contentMarkOf(both)).toBe(MARKS.modified);
    expect(marksOf(row("moved", "b", { moved: true }))).toEqual([MARKS.moved]);
    expect(contentMarkOf(row("moved", "b", { moved: true }))).toBeNull();
    expect(marksOf(row("unchanged", "c"))).toEqual([]);
  });

  it("includes the slide for its change and the move for its move, which needs both versions", () => {
    const both = row("modified", "a", { moved: true, staged: true });
    expect(actionsOf(both, MARKS.modified)).toEqual({
      change: { kind: "slide", id: "a", oldId: "a" },
      include: "Include in this version",
      staged: true,
      restore: restoreActionOf(MARKS.modified),
    });
    expect(actionsOf(both, MARKS.moved)).toEqual({
      change: { kind: "move", id: "a", oldId: "a" },
      include: "Include the move",
      staged: false,
      restore: restoreActionOf(MARKS.moved),
    });
    expect(actionsOf(row("added", "new", { moved: true }), MARKS.moved)).toBeNull();
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
    [row("added", "a"), changes(), "New since the last version."],
    [row("removed", "a"), changes(), "Removed since the last version; this is how it looked."],
    [
      row("modified", "a", { details: ["speaker notes", "timing"], moved: true, oldNumber: 4 }),
      changes(),
      "Changed since the last version. Also changed: speaker notes, timing. It moved from slide 4.",
    ],
    [row("moved", "a", { moved: true, oldNumber: 2 }), changes(), "The same slide, moved from slide 2."],
    [row("unchanged", "a"), changes({ stylesChanged: true }), `No changes to this slide.${STYLES}`],
    [
      row("added", "a"),
      changes({ tracking: "notCommitted", stylesChanged: true }),
      "No version of this deck is saved yet.",
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

  it("says what it did in words a slide maker uses, for the message with the Undo", () => {
    expect(restoreActionOf(MARKS.added).done).toBe("Took the new slide out");
    expect(restoreActionOf(MARKS.removed).done).toBe("The slide is back in the deck");
    expect(restoreActionOf(MARKS.modified).done).toBe("The slide is back as in the last version");
    expect(restoreActionOf(MARKS.moved).done).toBe("The slide is back where it was");
    expect(restoreActionOf(STYLES_MARK).done).toBe("The shared styles are back as in the last version");
    for (const mark of [MARKS.added, MARKS.removed, MARKS.modified, MARKS.moved, STYLES_MARK]) {
      const { title, done } = restoreActionOf(mark);
      expect(`${title} ${done}`).not.toMatch(/commit|stage|git/i);
    }
  });

  it("gives the shared styles their actions", () => {
    expect(stylesActions(true)).toEqual({
      change: { kind: "styles" },
      include: "Include the shared styles in this version",
      staged: true,
      restore: restoreActionOf(STYLES_MARK),
    });
  });
});

describe("the deck as a whole", () => {
  const unchanged = [row("unchanged", "a"), row("unchanged", "b")];
  const clean = { slides: unchanged, hasUnstaged: false };

  it("is clean when nothing differs from the last version and nothing waits for one", () => {
    expect(isClean(changes(clean))).toBe(true);
    expect(isClean(changes({ ...clean, stylesChanged: true }))).toBe(false);
    expect(isClean(changes({ ...clean, stagedFiles: 1 }))).toBe(false);
    expect(isClean(changes({ ...clean, hasUnstaged: true }))).toBe(false);
    expect(isClean(changes({ ...clean, slides: [row("modified", "a")] }))).toBe(false);
    expect(isClean(changes({ ...clean, slides: [row("unchanged", "a", { moved: true })] }))).toBe(false);
    expect(isClean(changes({ ...clean, tracking: "notCommitted" }))).toBe(false);
  });

  it("can be discarded all at once when a version has it and something changed", () => {
    expect(canDiscardAll(changes(clean))).toBe(false);
    expect(canDiscardAll(changes({ ...clean, hasUnstaged: true }))).toBe(false);
    expect(canDiscardAll(changes({ slides: [row("added", "a")] }))).toBe(true);
    expect(canDiscardAll(changes({ ...clean, stylesChanged: true }))).toBe(true);
    expect(canDiscardAll(changes({ slides: [row("unchanged", "a", { moved: true })] }))).toBe(true);
    expect(canDiscardAll(changes({ tracking: "notCommitted", slides: [row("added", "a")] }))).toBe(false);
  });

  it("says where the next version goes", () => {
    expect(branchLabel({ branch: "talks/q3", detached: false })).toBe("talks/q3");
    expect(branchLabel({ branch: null, detached: true })).toBe("Not on a branch");
    expect(branchLabel({ branch: null, detached: false })).toBeNull();
  });

  it("counts what is picked for the next version: slides, moves and the styles", () => {
    expect(includedCount(changes({ slides: [row("modified", "a")] }))).toBe(0);
    const picked = [row("modified", "a", { staged: true, moved: true, moveStaged: true }), row("added", "b")];
    expect(includedCount(changes({ slides: picked, stylesStaged: true }))).toBe(3);
  });

  it("finds the first changed slide that is locked", () => {
    const slides = [{ id: "a" }, { id: "b", locked: true }, { id: "c", locked: true }];
    expect(lockedChange(slides, changes({ slides: [row("modified", "a"), row("unchanged", "b")] }))).toBeNull();
    expect(lockedChange(slides, changes({ slides: [row("unchanged", "b"), row("modified", "c")] }))).toBe(3);
    expect(lockedChange(slides, changes({ slides: [row("unchanged", "b", { moved: true })] }))).toBe(2);
  });
});

describe("the message suggested for a version", () => {
  const some = [
    row("modified", "a"),
    row("modified", "b"),
    row("modified", "c", { moved: true }),
    row("added", "d"),
    row("removed", "e"),
    row("moved", "f", { moved: true }),
    row("unchanged", "g"),
  ];

  it("counts what changed, naming the slides once", () => {
    expect(suggestMessage(changes({ slides: some }))).toBe("Change 3 slides, add 1, remove 1, move 1");
    expect(suggestMessage(changes({ slides: [row("added", "a")] }))).toBe("Add 1 slide");
    expect(suggestMessage(changes({ slides: [row("removed", "a"), row("removed", "b")] }))).toBe("Remove 2 slides");
  });

  it("names a change to the shared styles", () => {
    expect(suggestMessage(changes({ slides: some.slice(0, 2), stylesChanged: true }))).toBe("Change 2 slides, restyle");
    expect(suggestMessage(changes({ stylesChanged: true }))).toBe("Update the shared styles");
  });

  it("names only what is picked, once something is", () => {
    const picked = [
      row("modified", "a", { staged: true }),
      row("modified", "b"),
      row("added", "c"),
      row("modified", "d", { moved: true, moveStaged: true }),
    ];
    expect(suggestMessage(changes({ slides: picked, stylesChanged: true }))).toBe("Change 1 slide, move 1");
    expect(suggestMessage(changes({ slides: [row("modified", "a")], stylesChanged: true, stylesStaged: true }))).toBe(
      "Update the shared styles",
    );
  });

  it("has words for a first version and for changes to other files alone", () => {
    expect(suggestMessage(changes({ tracking: "notCommitted", slides: [row("added", "a")] }))).toBe("First version");
    expect(suggestMessage(changes({ slides: [row("unchanged", "a")] }))).toBe("Update the deck");
  });
});
