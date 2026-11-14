import { invoke } from "@tauri-apps/api/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChanges } from "../changesStore";
import type { DeckChanges, SlideChange, SlideStatus } from "../lib/api";
import { DEFAULT_DIVIDER } from "../lib/compare";
import { deckMode, useApp } from "../store";
import { lastError, toastTexts } from "../store/errors";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { placeElements } from "../test/intersection";
import { ChangesRail, ChangesView } from "./ChangesView";

const row = (
  status: SlideStatus,
  id: string,
  details: string[] = [],
  more: Partial<SlideChange> = {},
): SlideChange => ({
  key: status === "removed" ? `removed:${id}` : id,
  status,
  id: status === "removed" ? null : id,
  oldId: status === "added" ? null : id,
  details,
  moved: false,
  oldNumber: status === "added" ? null : 1,
  staged: false,
  moveStaged: false,
  ...more,
});

const LIST = [row("modified", "intro"), row("removed", "gone"), row("unchanged", "#2"), row("added", "outro")];

const changes = (overrides: Partial<DeckChanges> = {}): DeckChanges => ({
  tracking: "committed",
  branch: "main",
  detached: false,
  commit: { hash: "abc123", subject: "First draft" },
  stylesChanged: false,
  oldSize: null,
  slides: LIST,
  stylesStaged: false,
  stagedFiles: 0,
  stagedElsewhere: 0,
  hasUnstaged: true,
  ...overrides,
});

/** Gives the stage room, which jsdom's layout never does. */
function roomy() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private report: ResizeObserverCallback) {}
      observe(el: Element) {
        const entry = { target: el, contentRect: { width: 960, height: 540 } } as ResizeObserverEntry;
        this.report([entry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    },
  );
}

async function show(found: DeckChanges = changes()) {
  vi.mocked(invoke).mockResolvedValue(found);
  await act(async () => {
    render(
      <>
        <ChangesRail />
        <ChangesView />
      </>,
    );
  });
}

const rows = () => screen.getAllByTestId("change-row").map((r) => r.dataset.status);
const isComparing = () => screen.queryByTestId("slide-comparison") !== null;
const frames = () => [...document.querySelectorAll("iframe")].map((f) => f.getAttribute("src") ?? "");

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.unstubAllGlobals();
  roomy();
  useApp.setState({
    deck: deckFor(DECK_HTML),
    selected: "intro",
    editing: false,
    slideMode: "view",
    toasts: [],
  });
  useChanges.setState({
    changes: null,
    deck: null,
    picked: null,
    onlyChanges: false,
    divider: DEFAULT_DIVIDER,
    view: "split",
    loading: false,
    error: null,
  });
});

describe("Git mode", () => {
  it("is a mode of its own", () => {
    useApp.getState().setMode("git");
    expect(deckMode(useApp.getState())).toBe("git");
    useApp.getState().setMode("view");
    expect(deckMode(useApp.getState())).toBe("view");
  });
});

describe("ChangesRail", () => {
  it("lists the slides with the removed ones among them, marked by what changed", async () => {
    await show();
    expect(rows()).toEqual(["modified", "removed", "unchanged", "added"]);
    expect(screen.getByRole("button", { name: "Slide 1, modified" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slide, removed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slide 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slide 3, added" })).toBeTruthy();
  });

  it("lifts every thumbnail off the rail with a shadow", async () => {
    await show();
    for (const name of ["Slide 1, modified", "Slide, removed", "Slide 2", "Slide 3, added"]) {
      expect(screen.getByRole("button", { name }).classList).toContain("shadow-thumbnail");
    }
  });

  it("loads a row's thumbnail only when the list shows it, and changes its ring without a transition", async () => {
    const inRow = (element: Element) => element.closest("[data-testid=change-row]") !== null;
    placeElements((element) => (inRow(element) ? 6 : 0));
    await show();
    const thumbnails = () => screen.getAllByTestId("change-row").flatMap((r) => [...r.querySelectorAll("iframe")]);
    expect(thumbnails()).toEqual([]);
    // The picked slide beside the list is not one of a list: it loads whatever the list does.
    expect(frames().length).toBeGreaterThan(0);
    for (const frame of document.querySelectorAll("iframe")) fireEvent.load(frame);
    act(() => placeElements(() => 0));
    expect(thumbnails().length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Slide 1, modified" }).className).not.toMatch(/transition/);
  });

  it("shows a removed slide from the commit, with its runtime brought up to date", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Slide, removed" }));
    const removed = frames().filter((src) => src.includes(".head"));
    expect(removed.length).toBeGreaterThan(0);
    expect(removed[0]).toContain("slide=gone");
    expect(removed[0]).toContain("v=abc123");
    expect(removed[0]).toContain("print");
  });

  it("counts the changes", async () => {
    await show();
    expect(screen.getByTitle("1 modified").textContent).toBe("1");
    expect(screen.getByTitle("1 modified").querySelector("svg")).toBeTruthy();
    expect(screen.getByTitle("1 removed")).toBeTruthy();
    expect(screen.queryByTitle("1 moved")).toBeNull();
  });

  it("draws every header badge at one height and icon size, with or without a count", async () => {
    await show(changes({ stylesChanged: true, slides: LIST }));
    const badges = screen.getAllByTestId("count-badge");
    expect(badges.map((badge) => badge.title)).toContain("The shared styles changed");
    expect(badges.length).toBeGreaterThan(1);
    const classesOf = (badge: HTMLElement) => ({
      height: badge.className.split(" ").filter((c) => /^h-/.test(c)),
      icon: badge
        .querySelector("svg")
        ?.getAttribute("class")
        ?.split(" ")
        .filter((c) => /^size-/.test(c)),
    });
    for (const badge of badges) expect(classesOf(badge)).toEqual(classesOf(badges[0]!));
    expect(classesOf(badges[0]!).height).toHaveLength(1);
  });

  it("can show only the slides that changed", async () => {
    await show();
    fireEvent.click(screen.getByTitle("Show only the slides that changed"));
    expect(rows()).toEqual(["modified", "removed", "added"]);
  });

  it("says when nothing changed", async () => {
    await show(changes({ slides: [row("unchanged", "intro")] }));
    fireEvent.click(screen.getByTitle("Show only the slides that changed"));
    expect(screen.getByText("No slide changed.")).toBeTruthy();
  });
});

describe("marks", () => {
  it("marks a change with an icon in the middle, not a word", async () => {
    await show();
    expect(screen.getAllByTestId("change-mark").map((m) => m.title)).toEqual(["Modified", "Removed", "Added"]);
    expect(screen.getAllByTestId("change-mark").every((m) => m.textContent === "")).toBe(true);
  });

  it("puts the move of a slide that changed in its own field under the picture", async () => {
    await show(changes({ slides: [row("modified", "intro", [], { moved: true, oldNumber: 3 })] }));
    expect(screen.getAllByTestId("change-mark").map((m) => m.title)).toEqual(["Modified", "Moved"]);
    const move = screen.getByTestId("move-row");
    expect(move.textContent).toContain("3 → 1");
    expect(move.querySelector("[title]")?.getAttribute("title")).toBe("Moved from slide 3 to slide 1");
    expect(within(move).getByRole("group", { name: "Moved" })).toBeTruthy();
    const picture = screen.getByRole("button", { name: "Slide 1, modified and moved" });
    expect(picture.contains(move)).toBe(false);
    expect(within(picture.parentElement as HTMLElement).queryByTestId("move-row")).toBeNull();
  });

  it("leaves the picture of a slide that only moved unmarked, with the move under it", async () => {
    await show(changes({ slides: [row("moved", "intro", [], { moved: true, oldNumber: 3 })] }));
    expect(screen.getAllByTestId("change-mark").map((m) => m.title)).toEqual(["Moved"]);
    expect(screen.getByTestId("move-row")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slide 1, moved" })).toBeTruthy();
  });

  it("marks the edit and the move staged each on their own", async () => {
    const both = { moved: true, oldNumber: 3 };
    await show(changes({ slides: [row("modified", "intro", [], { ...both, staged: true })] }));
    expect(screen.getAllByTestId("staged-mark")).toHaveLength(1);
    expect(within(screen.getByTestId("move-row")).queryByTestId("staged-mark")).toBeNull();
    expect(screen.getByRole("button", { name: "Slide 1, modified and moved, staged" })).toBeTruthy();
    cleanup();
    await show(changes({ slides: [row("modified", "intro", [], { ...both, moveStaged: true })] }));
    expect(screen.getAllByTestId("staged-mark")).toHaveLength(1);
    expect(within(screen.getByTestId("move-row")).getByTestId("staged-mark")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slide 1, modified and moved" })).toBeTruthy();
  });
});

describe("staging", () => {
  const sent = (cmd: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === cmd);
  const group = (name: string) => within(screen.getByRole("group", { name }));

  it("puts the buttons of a change in a row under the picture, which they leave in view", async () => {
    await show();
    const buttons = screen.getByRole("group", { name: "Modified" });
    expect([...buttons.children].map((part) => part.textContent)).toEqual(["Stage", "Discard changes"]);
    const picture = screen.getByRole("button", { name: "Slide 1, modified" });
    // Not over the thumbnail: after the box that holds it.
    expect(picture.parentElement!.contains(buttons)).toBe(false);
    expect(picture.parentElement!.nextElementSibling).toBe(buttons);
    // The mark itself sits in a corner of the picture.
    const mark = within(picture.parentElement!).getByTestId("change-mark");
    expect(mark.className).toContain("right-1");
    expect(mark.className).toContain("top-1");
  });

  it("names putting a change back by what it does to it, in red where work goes with it", async () => {
    await show(
      changes({
        stylesChanged: true,
        slides: [...LIST, row("moved", "moved", [], { moved: true, oldNumber: 1 })],
      }),
    );
    const undo = (name: string, label: string) => group(name).getByRole("button", { name: label });
    expect(undo("Modified", "Discard changes").className).toContain("text-destructive");
    expect(undo("Added", "Discard new slide").className).toContain("text-destructive");
    expect(undo("Removed", "Bring back").className).not.toContain("text-destructive");
    expect(undo("Moved", "Undo move").className).not.toContain("text-destructive");
    expect(undo("Styles", "Discard changes").className).toContain("text-destructive");
    expect(undo("Added", "Discard new slide").title).toBe(
      "Take this slide out: the last commit does not have it (Ctrl+Z undoes it)",
    );
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });

  it("gives an edit and a move their own buttons", async () => {
    await show(changes({ slides: [row("modified", "intro", [], { moved: true, oldNumber: 3 })] }));
    await act(async () => {
      fireEvent.click(group("Moved").getByRole("button", { name: "Stage" }));
    });
    expect(sent("stage_change")[0]?.[1]).toMatchObject({ change: { kind: "move" } });
    expect(group("Modified").getByRole("button", { name: "Stage" })).toBeTruthy();
  });

  it("stages a slide without having to pick it first", async () => {
    await show();
    await act(async () => {
      fireEvent.click(group("Added").getByRole("button", { name: "Stage" }));
    });
    expect(sent("stage_change")[0]?.[1]).toMatchObject({ change: { kind: "slide", id: "outro", oldId: null } });
    expect(useChanges.getState().picked).toBe("intro");
  });

  it("stages and restores a slide", async () => {
    await show();
    await act(async () => {
      fireEvent.click(group("Modified").getByRole("button", { name: "Stage" }));
    });
    expect(sent("stage_change")[0]?.[1]).toMatchObject({ change: { kind: "slide", id: "intro", oldId: "intro" } });
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "restore_change" ? { deck: deckFor(DECK_HTML), previous: "old", source: "new", created: [] } : changes(),
    );
    await act(async () => {
      fireEvent.click(group("Modified").getByRole("button", { name: "Discard changes" }));
    });
    expect(sent("restore_change")).toHaveLength(1);
    expect(sent("deck_history").length).toBeGreaterThan(0);
  });

  it("offers to unstage what is staged", async () => {
    await show(changes({ slides: [row("modified", "intro", [], { staged: true })] }));
    await act(async () => {
      fireEvent.click(group("Modified").getByRole("button", { name: "Unstage" }));
    });
    expect(sent("unstage_change")).toHaveLength(1);
  });

  it("stages and restores a move on its own", async () => {
    await show(changes({ slides: [row("moved", "intro", [], { moved: true, oldNumber: 3 })] }));
    expect(screen.queryByRole("group", { name: "Modified" })).toBeNull();
    await act(async () => {
      fireEvent.click(group("Moved").getByRole("button", { name: "Stage" }));
    });
    expect(sent("stage_change")[0]?.[1]).toMatchObject({ change: { kind: "move", id: "intro", oldId: "intro" } });
  });

  it("stages the shared styles", async () => {
    await show(changes({ stylesChanged: true }));
    await act(async () => {
      fireEvent.click(group("Shared styles").getByRole("button", { name: "Stage" }));
    });
    expect(sent("stage_change")[0]?.[1]).toMatchObject({ change: { kind: "styles" } });
  });

  it("lists a change to the shared styles above the slides, with its own buttons", async () => {
    await show(changes({ stylesChanged: true, slides: [row("unchanged", "intro")] }));
    const styles = within(screen.getByTestId("styles-row"));
    expect(screen.getByTitle("The shared styles changed")).toBeTruthy();
    expect(styles.queryByTestId("staged-mark")).toBeNull();
    await act(async () => {
      fireEvent.click(styles.getByRole("button", { name: "Stage" }));
    });
    expect(sent("stage_change")[0]?.[1]).toMatchObject({ change: { kind: "styles" } });
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "restore_change" ? { deck: deckFor(DECK_HTML), previous: "old", source: "new", created: [] } : changes(),
    );
    await act(async () => {
      fireEvent.click(styles.getByRole("button", { name: "Discard changes" }));
    });
    expect(sent("restore_change")[0]?.[1]).toMatchObject({ change: { kind: "styles" } });
  });

  it("marks staged styles, and says when only the styles changed", async () => {
    await show(changes({ stylesChanged: true, stylesStaged: true, slides: [row("unchanged", "intro")] }));
    expect(within(screen.getByTestId("styles-row")).getByTestId("staged-mark")).toBeTruthy();
    expect(within(screen.getByTestId("styles-row")).getByRole("button", { name: "Unstage" })).toBeTruthy();
    await act(async () => {
      useChanges.getState().setOnlyChanges(true);
    });
    expect(screen.getByText("No slide changed, only the shared styles.")).toBeTruthy();
    expect(screen.getByTestId("styles-row")).toBeTruthy();
  });

  it("lists no styles row while nothing of them changed", async () => {
    await show();
    expect(screen.queryByTestId("styles-row")).toBeNull();
    expect(screen.queryByTitle("The shared styles changed")).toBeNull();
  });

  it("does not restore a locked slide", async () => {
    const deck = deckFor(DECK_HTML.replace('id="intro"', 'id="intro" data-locked'));
    useApp.setState({ deck });
    await show();
    const discard = group("Modified").getByRole("button", { name: "Discard changes" }) as HTMLButtonElement;
    expect(discard.disabled).toBe(true);
    expect(discard.title).toBe("This slide is locked; unlock it first");
  });

  it("stages and restores slide by slide before a first commit too", async () => {
    await show(changes({ tracking: "notCommitted", commit: null, slides: [row("added", "intro")] }));
    expect(screen.getByRole("textbox", { name: "Commit message" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Stage all" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(group("Added").getByRole("button", { name: "Stage" }));
    });
    expect(sent("stage_change")[0]?.[1]).toMatchObject({ change: { kind: "slide", id: "intro", oldId: null } });
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "restore_change" ? { deck: deckFor(DECK_HTML), previous: "old", source: "new", created: [] } : changes(),
    );
    await act(async () => {
      fireEvent.click(group("Added").getByRole("button", { name: "Discard new slide" }));
    });
    expect(sent("restore_change")[0]?.[1]).toMatchObject({ change: { kind: "slide", id: "intro", oldId: null } });
  });

  it("offers nothing to stage for a deck outside a repository", async () => {
    await show(changes({ tracking: "noRepository", commit: null, slides: [row("added", "intro")] }));
    expect(screen.queryByRole("button", { name: "Stage" })).toBeNull();
  });
});

describe("committing", () => {
  const button = () => screen.getByRole("button", { name: /^Commit/ }) as HTMLButtonElement;
  const message = () => screen.getByRole("textbox", { name: "Commit message" }) as HTMLTextAreaElement;

  it("needs a message, and says so", async () => {
    await show(changes({ stagedFiles: 2 }));
    expect(button().textContent).toBe("Commit 2 files");
    expect(button().disabled).toBe(true);
    expect(button().title).toBe("Write a message to commit");
    fireEvent.change(message(), { target: { value: "Fix" } });
    expect(button().disabled).toBe(false);
    expect(button().title).toBe("Commit what is staged (Ctrl+Enter)");
    cleanup();
    await show(changes({ stagedFiles: 1 }));
    expect(button().textContent).toBe("Commit 1 file");
  });

  it("commits everything when nothing is staged", async () => {
    await show();
    expect(button().textContent).toBe("Commit all");
    expect(button().disabled).toBe(true);
    expect(button().title).toBe("Write a message to commit");
    fireEvent.change(message(), { target: { value: "Fix" } });
    expect(button().title).toBe("Stage everything in this deck and commit it (Ctrl+Enter)");
    await act(async () => {
      fireEvent.click(button());
    });
    const sent = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    expect(sent.indexOf("stage_all")).toBeGreaterThan(-1);
    expect(sent.indexOf("stage_all")).toBeLessThan(sent.indexOf("commit_changes"));
    expect(message().value).toBe("");
  });

  it("says that it committed, and which commit", async () => {
    await show(changes({ stagedFiles: 1 }));
    vi.mocked(invoke).mockResolvedValue(changes({ commit: { hash: "def456", subject: "Reword" } }));
    fireEvent.change(message(), { target: { value: "Reword" } });
    await act(async () => {
      fireEvent.click(button());
    });
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Committed def456"]);
  });

  it("stages and unstages everything with buttons that say so", async () => {
    await show(changes({ stagedFiles: 1 }));
    const stageAll = screen.getByRole("button", { name: "Stage all" });
    const unstageAll = screen.getByRole("button", { name: "Unstage all" });
    expect(stageAll.textContent).toBe("Stage all");
    expect(unstageAll.textContent).toBe("Unstage all");
    await act(async () => {
      fireEvent.click(stageAll);
      fireEvent.click(unstageAll);
    });
    const calls = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    expect(calls).toContain("stage_all");
    expect(calls).toContain("unstage_all");
    cleanup();
    await show(changes({ hasUnstaged: false, stagedFiles: 2, stagedElsewhere: 2 }));
    expect((screen.getByRole("button", { name: "Stage all" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Unstage all" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("discards every change at once, after asking", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Discard all…" }));
    const dialog = within(screen.getByRole("dialog", { name: "Discard all changes" }));
    expect(dialog.getByText(/abc123/)).toBeTruthy();
    expect(dialog.getByText(/Ctrl\+Z brings the changes back/)).toBeTruthy();
    // Cancel has the focus: Enter does not discard by accident.
    expect(document.activeElement).toBe(dialog.getByRole("button", { name: "Cancel" }));
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "restore_all_changes")).toBe(false);

    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "restore_all_changes"
        ? { deck: deckFor(DECK_HTML), previous: "old", source: "new", created: [] }
        : changes(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard all…" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Discard all changes" }));
    });
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "restore_all_changes")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not discard everything while a changed slide is locked, or before a first commit", async () => {
    useApp.setState({ deck: deckFor(DECK_HTML.replace('id="intro"', 'id="intro" data-locked')) });
    await show();
    const discard = screen.getByRole("button", { name: "Discard all…" }) as HTMLButtonElement;
    expect(discard.disabled).toBe(true);
    expect(discard.title).toBe("Slide 1 is locked; unlock it to discard its changes");
    cleanup();
    await show(changes({ tracking: "notCommitted", commit: null, slides: [row("added", "intro")] }));
    expect(screen.queryByRole("button", { name: "Discard all…" })).toBeNull();
  });

  it("commits and clears the message", async () => {
    await show(changes({ stagedFiles: 1 }));
    fireEvent.change(message(), { target: { value: "Reword the intro" } });
    await act(async () => {
      fireEvent.click(button());
    });
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "commit_changes");
    expect(call?.[1]).toMatchObject({ message: "Reword the intro" });
    expect(message().value).toBe("");
  });

  it("keeps the message when the commit fails, and says why", async () => {
    await show(changes({ stagedFiles: 1 }));
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "commit_changes") throw "hook said no";
      return changes({ stagedFiles: 1 });
    });
    fireEvent.change(message(), { target: { value: "Fix" } });
    await act(async () => {
      fireEvent.keyDown(message(), { key: "Enter", metaKey: true });
    });
    expect(message().value).toBe("Fix");
    expect(lastError(useApp.getState())).toContain("hook said no");
  });

  it("warns when the commit takes in files from elsewhere", async () => {
    await show(changes({ stagedFiles: 3, stagedElsewhere: 2 }));
    expect(screen.getByText(/Also commits 2 staged files/)).toBeTruthy();
  });
});

describe("the branch", () => {
  it("shows beside the commit compared with and over the commit message", async () => {
    await show(changes({ branch: "talks/q3" }));
    const shown = screen.getAllByTestId("branch");
    expect(shown.map((b) => b.textContent)).toEqual(["talks/q3", "talks/q3"]);
    expect(shown[0]!.title).toBe("On branch talks/q3: commits go here");
    expect(shown[0]!.parentElement!.querySelector('[aria-label="Commit message"]')).toBeTruthy();
    expect(shown[1]!.parentElement!.textContent).toContain("Since abc123");
  });

  it("warns when a commit is checked out instead of a branch", async () => {
    await show(changes({ branch: null, detached: true }));
    const [first] = screen.getAllByTestId("branch");
    expect(first!.textContent).toBe("Detached HEAD");
    expect(first!.className).toContain("text-warning");
    expect(first!.title).toContain("on no branch");
  });

  it("shows nothing where there is none to name", async () => {
    await show(changes({ branch: null, detached: false }));
    expect(screen.queryByTestId("branch")).toBeNull();
  });
});

describe("states", () => {
  it("says that there is nothing to commit, without a commit box", async () => {
    await show(changes({ slides: [row("unchanged", "intro"), row("unchanged", "#2")], hasUnstaged: false }));
    expect(screen.getByTestId("no-changes").textContent).toContain("No changes since abc123");
    expect(within(screen.getByTestId("no-changes")).getByTestId("branch").textContent).toBe("main");
    expect(screen.queryByRole("textbox", { name: "Commit message" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Commit/ })).toBeNull();
    // The slides are still there to look at.
    expect(rows()).toEqual(["unchanged", "unchanged"]);
  });

  it("keeps the commit box while something waits to be committed", async () => {
    await show(
      changes({ slides: [row("unchanged", "intro")], hasUnstaged: false, stagedFiles: 1, stagedElsewhere: 1 }),
    );
    expect(screen.queryByTestId("no-changes")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Commit message" })).toBeTruthy();
  });

  it("says that it is reading the changes until they are there", async () => {
    let finish!: (value: DeckChanges) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => {
      render(
        <>
          <ChangesRail />
          <ChangesView />
        </>,
      );
    });
    expect(screen.getAllByRole("status").map((s) => s.textContent)).toEqual(["Reading changes…", "Reading changes…"]);
    expect(screen.queryByRole("textbox", { name: "Commit message" })).toBeNull();
    await act(async () => finish(changes()));
    expect(screen.queryByRole("status")).toBeNull();
    expect(isComparing()).toBe(true);
  });

  it("says what went wrong reading them, and tries again when asked", async () => {
    vi.mocked(invoke).mockRejectedValue("fatal: not a git repository");
    await act(async () => {
      render(<ChangesView />);
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Could not read the changes");
    expect(alert.textContent).toContain("fatal: not a git repository");
    expect(lastError(useApp.getState())).toBeNull();
    vi.mocked(invoke).mockResolvedValue(changes());
    await act(async () => {
      fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(isComparing()).toBe(true);
  });
});

describe("ChangesView", () => {
  it("compares a modified slide, and shows the commit it compares with", async () => {
    await show();
    expect(isComparing()).toBe(true);
    expect(screen.getByText(/First draft/)).toBeTruthy();
    const shown = frames().filter((src) => src.includes("slide=intro"));
    expect(shown.some((src) => src.includes(".head"))).toBe(true);
    expect(shown.some((src) => src.includes(".file"))).toBe(true);
  });

  it.each([
    ["Slide 3, added", "New since the last commit."],
    ["Slide, removed", "Removed since the last commit; this is how it looked."],
    ["Slide 2", "No changes to this slide."],
  ])("shows %s as it is, with nothing to slide across", async (name, text) => {
    await show();
    fireEvent.click(screen.getByRole("button", { name }));
    expect(isComparing()).toBe(false);
    expect(screen.getByText(text)).toBeTruthy();
    // One version only: nothing to switch between, and no divider to set.
    for (const name of ["Split", "Before", "After", "Divider"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("shows one version at a time when asked: before, or after", async () => {
    await show();
    const view = (name: string) => within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name });
    expect(view("Split").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(view("Before"));
    expect(isComparing()).toBe(false);
    expect(view("Before").getAttribute("aria-pressed")).toBe("true");
    const shown = () => [...screen.getByTestId("single-version").querySelectorAll("iframe")].map((f) => f.src);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain(".head");
    expect(screen.getByText("Before (abc123).")).toBeTruthy();
    // The divider belongs to the split view.
    expect((screen.getByRole("button", { name: "Divider" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view("After"));
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain(".file");
    expect(screen.getByText("After (now).")).toBeTruthy();
    fireEvent.click(view("Split"));
    expect(isComparing()).toBe(true);
    expect(screen.queryByText("After (now).")).toBeNull();
  });

  it("keeps the view going from slide to slide", async () => {
    await show(changes({ slides: [row("modified", "intro"), row("modified", "#2")] }));
    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    fireEvent.click(screen.getByRole("button", { name: "Slide 2, modified" }));
    expect(useChanges.getState().view).toBe("before");
    expect(isComparing()).toBe(false);
  });

  it("keeps the divider's settings out of the bar, behind a button", async () => {
    await show();
    expect(screen.queryByRole("slider", { name: "Angle" })).toBeNull();
    const divider = screen.getByRole("button", { name: "Divider" });
    fireEvent.click(divider);
    expect(divider.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(screen.getByRole("dialog", { name: "Divider" })).getByRole("slider", { name: "Feather" }),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Divider" })).toBeNull();
  });

  it("compares every slide once the shared styles changed", async () => {
    await show(changes({ stylesChanged: true }));
    fireEvent.click(screen.getByRole("button", { name: "Slide 2" }));
    expect(isComparing()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Slide 3, added" }));
    expect(isComparing()).toBe(false);
  });

  it("sets the angle and the feather, by slider and by number", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Divider" }));
    fireEvent.change(screen.getByRole("slider", { name: "Angle" }), { target: { value: "30" } });
    expect(useChanges.getState().divider.angle).toBe(30);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Feather in pixels" }), { target: { value: "50" } });
    expect(useChanges.getState().divider.feather).toBe(50);
    expect(screen.getByTestId("comparison-after").dataset.mask).toContain("deg");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Feather in pixels" }), { target: { value: "9999" } });
    expect(useChanges.getState().divider.feather).toBe(400);
    fireEvent.click(screen.getByTitle("Put the divider back in the middle, without a feather"));
    expect(useChanges.getState().divider).toEqual(DEFAULT_DIVIDER);
  });

  it("goes through the list with the arrow keys, but not while typing a value", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Divider" }));
    const feather = screen.getByRole("spinbutton", { name: "Feather in pixels" });
    fireEvent.keyDown(feather, { key: "ArrowDown" });
    expect(useChanges.getState().picked).toBe("intro");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Commit message" }), { key: "ArrowDown" });
    expect(useChanges.getState().picked).toBe("intro");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(useChanges.getState().picked).toBe("removed:gone");
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(useChanges.getState().picked).toBe("intro");
  });

  it("compares again when the deck changes, when asked, and on coming back to the window", async () => {
    await show();
    const calls = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "deck_changes").length;
    expect(calls()).toBe(1);
    await act(async () => {
      useApp.setState({ deck: deckFor(DECK_HTML, "2") });
    });
    expect(calls()).toBe(2);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });
    expect(calls()).toBe(3);
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(calls()).toBe(4);
  });

  it("shows nothing for a deck that just left its repository", async () => {
    await show(changes({ tracking: "noRepository", commit: null, slides: [] }));
    expect(screen.queryByTestId("slide-comparison")).toBeNull();
    expect(screen.queryByText("No slides")).toBeNull();
  });

  it("shows a deck never committed as all new", async () => {
    await show(changes({ tracking: "notCommitted", commit: null, slides: [row("added", "intro")] }));
    expect(screen.getByText("Not committed yet")).toBeTruthy();
    expect(screen.getByText("Not committed yet, so every slide is new; discarding one takes it out.")).toBeTruthy();
    expect(isComparing()).toBe(false);
  });
});
