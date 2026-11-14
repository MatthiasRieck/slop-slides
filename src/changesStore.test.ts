import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { shownView, useChanges, visibleRows } from "./changesStore";
import type { DeckChanges, SlideChange, SlideStatus } from "./lib/api";
import { DEFAULT_DIVIDER } from "./lib/compare";
import { useApp } from "./store";
import { lastError, toastTexts } from "./store/errors";
import { DECK_HTML, deckFor } from "./test/fixtures";

const row = (status: SlideStatus, id: string): SlideChange => ({
  key: status === "removed" ? `removed:${id}` : id,
  status,
  id: status === "removed" ? null : id,
  oldId: status === "added" ? null : id,
  details: [],
  textChanges: [],
  moved: false,
  oldNumber: null,
  staged: false,
  moveStaged: false,
});

const changes = (...slides: SlideChange[]): DeckChanges => ({
  tracking: "committed",
  branch: "main",
  detached: false,
  commit: { hash: "abc123", subject: "First", time: 1_700_000_000 },
  stylesChanged: false,
  oldSize: null,
  slides,
  stylesStaged: false,
  stagedFiles: 0,
  stagedElsewhere: 0,
  hasUnstaged: true,
});

const answer = (value: DeckChanges) => vi.mocked(invoke).mockResolvedValue(value);
const DECK = "/decks/talk/deck.html";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
  useChanges.setState({
    changes: null,
    deck: null,
    picked: null,
    onlyChanges: false,
    divider: DEFAULT_DIVIDER,
    view: "split",
    flipped: false,
    textOpen: true,
    loading: false,
    error: null,
  });
  useApp.setState({ toasts: [] });
});

describe("refresh", () => {
  it.each([
    ["the selected slide when it changed", [row("modified", "other"), row("modified", "intro")], "intro"],
    [
      "the first change when the selected slide did not change",
      [row("unchanged", "intro"), row("removed", "gone"), row("added", "new")],
      "removed:gone",
    ],
    ["the selected slide when nothing changed", [row("unchanged", "a"), row("unchanged", "intro")], "intro"],
  ])("starts at %s", async (_, rows, picked) => {
    answer(changes(...rows));
    await useChanges.getState().refresh(DECK);
    expect(useChanges.getState().picked).toBe(picked);
  });

  it("stays on the picked row", async () => {
    answer(changes(row("modified", "a"), row("modified", "b")));
    await useChanges.getState().refresh(DECK);
    useChanges.getState().pick("b");
    await useChanges.getState().refresh(DECK);
    expect(useChanges.getState().picked).toBe("b");
  });

  it("moves on when the picked row is gone", async () => {
    answer(changes(row("modified", "a"), row("modified", "b")));
    await useChanges.getState().refresh(DECK);
    useChanges.getState().pick("b");
    answer(changes(row("modified", "a")));
    await useChanges.getState().refresh(DECK);
    expect(useChanges.getState().picked).toBe("a");
  });

  it("forgets the picked row of another deck", async () => {
    answer(changes(row("unchanged", "a"), row("modified", "b")));
    useChanges.setState({ deck: "/other.html", picked: "a" });
    await useChanges.getState().refresh(DECK);
    expect(useChanges.getState().picked).toBe("b");
  });

  it("ignores an answer that comes back after a newer one", async () => {
    let answerFirst: (value: DeckChanges) => void = () => {};
    vi.mocked(invoke).mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve as typeof answerFirst)));
    const first = useChanges.getState().refresh(DECK);
    answer(changes(row("added", "new")));
    await useChanges.getState().refresh(DECK);
    answerFirst(changes(row("added", "stale")));
    await first;
    expect(useChanges.getState().changes?.slides[0]?.id).toBe("new");
  });

  it("says what went wrong in the view, which offers to try again, not in a message", async () => {
    vi.mocked(invoke).mockRejectedValue("the deck is gone");
    await useChanges.getState().refresh(DECK);
    expect(useChanges.getState()).toMatchObject({ deck: DECK, error: "the deck is gone", loading: false });
    expect(lastError(useApp.getState())).toBeNull();
    answer(changes(row("modified", "a")));
    await useChanges.getState().refresh(DECK);
    expect(useChanges.getState()).toMatchObject({ error: null, loading: false });
    expect(useChanges.getState().changes?.slides).toHaveLength(1);
  });

  it("keeps what was read when reading it again fails", async () => {
    answer(changes(row("modified", "a")));
    await useChanges.getState().refresh(DECK);
    vi.mocked(invoke).mockRejectedValue("git is busy");
    await useChanges.getState().refresh(DECK);
    expect(useChanges.getState().error).toBe("git is busy");
    expect(useChanges.getState().changes?.slides).toHaveLength(1);
  });

  it("is loading until the answer is there, and shows nothing of another deck meanwhile", async () => {
    answer(changes(row("modified", "a")));
    await useChanges.getState().refresh("/decks/other/deck.html");
    let finish!: (value: DeckChanges) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const reading = useChanges.getState().refresh(DECK);
    expect(useChanges.getState()).toMatchObject({ deck: DECK, changes: null, picked: null, loading: true });
    finish(changes(row("modified", "b")));
    await reading;
    expect(useChanges.getState()).toMatchObject({ loading: false, picked: "b" });
  });
});

describe("the list", () => {
  beforeEach(async () => {
    answer(changes(row("modified", "a"), row("unchanged", "outro"), row("removed", "gone"), row("added", "b")));
    await useChanges.getState().refresh(DECK);
  });

  it("selects the slide picked, but a removed one has no slide to select", () => {
    useChanges.getState().pick("outro");
    expect(useApp.getState().selected).toBe("outro");
    useChanges.getState().pick("removed:gone");
    expect(useChanges.getState().picked).toBe("removed:gone");
    expect(useApp.getState().selected).toBe("outro");
  });

  it("steps through the rows and stops at the ends", () => {
    useChanges.getState().step(-1);
    expect(useChanges.getState().picked).toBe("a");
    useChanges.getState().step(1);
    useChanges.getState().step(1);
    expect(useChanges.getState().picked).toBe("removed:gone");
    useChanges.getState().step(1);
    useChanges.getState().step(1);
    expect(useChanges.getState().picked).toBe("b");
  });

  it("can leave the unchanged slides out, also when stepping", () => {
    useChanges.getState().setOnlyChanges(true);
    expect(visibleRows(useChanges.getState()).map((r) => r.key)).toEqual(["a", "removed:gone", "b"]);
    useChanges.getState().step(1);
    expect(useChanges.getState().picked).toBe("removed:gone");
  });

  it("moves off a row that gets left out", () => {
    useChanges.getState().pick("outro");
    useChanges.getState().setOnlyChanges(true);
    expect(useChanges.getState().picked).toBe("a");
  });
});

describe("checkRepository", () => {
  const OTHER = "/talks/other/deck.html";
  const found = (value: Promise<boolean>) => vi.mocked(invoke).mockReturnValue(value);

  it("remembers a deck in a repository, and forgets it when that is gone", async () => {
    found(Promise.resolve(true));
    await useChanges.getState().checkRepository(DECK);
    expect(useChanges.getState().repository).toBe(DECK);
    found(Promise.resolve(false));
    await useChanges.getState().checkRepository(DECK);
    expect(useChanges.getState().repository).toBeNull();
  });

  it("counts a failed check as no repository, without an error", async () => {
    useApp.setState({ toasts: [] });
    useChanges.setState({ repository: DECK });
    found(Promise.reject("the deck is gone"));
    await useChanges.getState().checkRepository(DECK);
    expect(useChanges.getState().repository).toBeNull();
    expect(lastError(useApp.getState())).toBeNull();
  });

  it("ignores an answer about a deck that is no longer open", async () => {
    useChanges.setState({ repository: DECK });
    found(Promise.resolve(false));
    await useChanges.getState().checkRepository(OTHER);
    expect(useChanges.getState().repository).toBe(DECK);
  });
});

describe("changing the repository", () => {
  const STYLES = { kind: "styles" } as const;
  const called = () => vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);

  it("reads the changes again after staging", async () => {
    answer(changes(row("modified", "a")));
    await useChanges.getState().stage(DECK, STYLES);
    expect(called()).toEqual(["stage_change", "deck_changes"]);
  });

  it("reports a failure, and still reads the changes again", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "unstage_change") throw "index.lock exists";
      return changes();
    });
    await useChanges.getState().unstage(DECK, STYLES);
    expect(lastError(useApp.getState())).toContain("index.lock exists");
    expect(called()).toContain("deck_changes");
  });

  /** Answers the commands of a discard: the deck it leaves, the files that went back, and what the history can undo. */
  const discards = (files: number, undo: string | null) =>
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "restore_change" || cmd === "restore_all_changes") {
        return { deck: deckFor(DECK_HTML), created: [], files };
      }
      if (cmd === "deck_history") return { undo: undo ? { label: undo, source: "deck" } : null, redo: null };
      if (cmd === "undo_deck")
        return { deck: deckFor(DECK_HTML, "2"), status: { undo: null, redo: null }, entry: null };
      return changes();
    });
  const toasts = () => useApp.getState().toasts;

  it("selects another slide when a discard took the selected one away", async () => {
    useApp.setState({ selected: "added" });
    discards(0, "Discard changes");
    await useChanges.getState().restore(DECK, { kind: "slide", id: "added", oldId: null }, "Took the new slide out");
    expect(useApp.getState().selected).toBe("intro");
  });

  it("says what a discard did, and takes it back from the message", async () => {
    discards(0, "Discard changes");
    await useChanges.getState().restore(DECK, { kind: "slide", id: "intro", oldId: "intro" }, "The slide is back");
    expect(toastTexts(useApp.getState(), "success")).toEqual(["The slide is back"]);
    expect(toasts()[0]?.action?.label).toBe("Undo");
    expect(called()).not.toContain("undo_deck");
    toasts()[0]?.action?.run();
    await vi.waitFor(() => expect(called()).toContain("undo_deck"));
  });

  it("offers no Undo when the deck's history has nothing of the discard to take back", async () => {
    // Only a file went back: the deck's text, which is all the history keeps, did not change.
    discards(1, "Edit slide");
    await useChanges.getState().restore(DECK, { kind: "slide", id: "intro", oldId: "intro" }, "The slide is back");
    expect(toastTexts(useApp.getState(), "success")).toEqual([
      "The slide is back, with 1 file it used (Undo does not bring files back)",
    ]);
    expect(toasts()[0]?.action).toBeUndefined();
  });

  it("does not undo something else when the deck changed after the discard", async () => {
    discards(0, "Discard changes");
    await useChanges.getState().restore(DECK, { kind: "slide", id: "intro", oldId: "intro" }, "The slide is back");
    discards(0, "Edit slide");
    toasts()[0]?.action?.run();
    await vi.waitFor(() => expect(lastError(useApp.getState())).toContain("cannot be undone"));
    expect(called()).not.toContain("undo_deck");
  });

  it("says nothing when the discard failed but that it did", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "restore_change") throw "This slide is locked";
      return changes();
    });
    await useChanges.getState().restore(DECK, { kind: "slide", id: "intro", oldId: "intro" }, "The slide is back");
    expect(toastTexts(useApp.getState(), "success")).toEqual([]);
    expect(lastError(useApp.getState())).toContain("locked");
    expect(called()).toContain("deck_changes");
  });

  it("says that it saved a version, in words without git's", async () => {
    answer({ ...changes(), commit: { hash: "def456", subject: "Fix", time: 1_700_000_500 } });
    expect(await useChanges.getState().commit(DECK, "Fix")).toBe(true);
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Saved a version"]);
    useApp.setState({ toasts: [] });
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "commit_changes") throw "no";
      return changes();
    });
    expect(await useChanges.getState().commit(DECK, "Fix")).toBe(false);
    expect(toastTexts(useApp.getState(), "success")).toEqual([]);
    expect(lastError(useApp.getState())).toContain("no");
  });

  it("commits everything: stages it all, then commits", async () => {
    answer(changes());
    expect(await useChanges.getState().commitAll(DECK, "Fix")).toBe(true);
    expect(called()).toEqual(["stage_all", "commit_changes", "deck_changes"]);
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Saved a version"]);
  });

  it("does not commit when staging everything failed", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "stage_all") throw "index.lock exists";
      return changes();
    });
    expect(await useChanges.getState().commitAll(DECK, "Fix")).toBe(false);
    expect(called()).not.toContain("commit_changes");
    expect(called()).toContain("deck_changes");
    expect(lastError(useApp.getState())).toContain("index.lock exists");
  });

  it("discards every change as one edit of the deck, selects a slide that is still there, and offers Undo", async () => {
    useApp.setState({ selected: "added" });
    discards(2, "Discard all changes");
    await useChanges.getState().restoreAll(DECK);
    expect(called().filter((cmd) => cmd === "restore_all_changes")).toHaveLength(1);
    expect(called()).toContain("deck_changes");
    expect(useApp.getState().selected).toBe("intro");
    expect(toastTexts(useApp.getState(), "success")).toEqual([
      "The deck is back as in the last version, with 2 files it used (Undo does not bring files back)",
    ]);
    expect(toasts()[0]?.action?.label).toBe("Undo");
  });
});

describe("the view of a slide that changed", () => {
  it("is split until another is picked", () => {
    expect(useChanges.getState().view).toBe("split");
    useChanges.getState().setView("before");
    expect(useChanges.getState().view).toBe("before");
  });

  it("flips to the other version while that is held, and to the slide as it was from the split view", () => {
    expect(shownView("split", false)).toBe("split");
    expect(shownView("split", true)).toBe("before");
    expect(shownView("before", true)).toBe("after");
    expect(shownView("after", true)).toBe("before");
  });

  it("lets go of a flip when another view is picked", () => {
    useChanges.getState().setFlipped(true);
    expect(useChanges.getState().flipped).toBe(true);
    useChanges.getState().setView("after");
    expect(useChanges.getState()).toMatchObject({ view: "after", flipped: false });
  });

  it("folds the list of changed words, and keeps it that way", () => {
    expect(useChanges.getState().textOpen).toBe(true);
    useChanges.getState().setTextOpen(false);
    expect(useChanges.getState().textOpen).toBe(false);
  });
});

describe("the divider", () => {
  it("keeps what is not changed, and resets", () => {
    useChanges.getState().setDivider({ angle: 30 });
    useChanges.getState().setDivider({ x: 0.2 });
    expect(useChanges.getState().divider).toEqual({ angle: 30, x: 0.2, y: 0.5 });
    useChanges.getState().resetDivider();
    expect(useChanges.getState().divider).toEqual(DEFAULT_DIVIDER);
  });
});
