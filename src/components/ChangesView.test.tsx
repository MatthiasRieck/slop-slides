import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import { useChanges } from "../changesStore";
import type { DeckChanges, SlideChange, SlideStatus } from "../lib/api";
import { DEFAULT_DIVIDER } from "../lib/compare";
import { deckMode, useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
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
    view: "slides",
    editing: false,
    slideMode: "view",
    error: null,
    deckUndo: [],
    deckRedo: [],
  });
  useChanges.setState({ changes: null, deck: null, picked: null, onlyChanges: false, divider: DEFAULT_DIVIDER });
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

  it("shows both marks on a slide that changed and moved, and where it came from", async () => {
    await show(changes({ slides: [row("modified", "intro", [], { moved: true, oldNumber: 3 })] }));
    expect(screen.getAllByTestId("change-mark").map((m) => m.title)).toEqual(["Modified", "Moved"]);
    expect(screen.getByText("was 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slide 1, modified and moved" })).toBeTruthy();
  });

  it("marks a slide staged only once all of its changes are", async () => {
    const both = { moved: true, oldNumber: 3 };
    await show(changes({ slides: [row("modified", "intro", [], { ...both, staged: true })] }));
    expect(screen.queryByTestId("staged-mark")).toBeNull();
    cleanup();
    await show(changes({ slides: [row("modified", "intro", [], { ...both, staged: true, moveStaged: true })] }));
    expect(screen.getByTestId("staged-mark")).toBeTruthy();
  });
});

describe("staging", () => {
  const sent = (cmd: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === cmd);
  const group = (name: string) => within(screen.getByRole("group", { name }));

  it("puts stage on the left of the status icon and restore on its right", async () => {
    await show();
    const parts = [...screen.getByRole("group", { name: "Modified" }).children];
    expect(parts.map((part) => part.getAttribute("aria-label") ?? part.getAttribute("title"))).toEqual([
      "Stage",
      "Modified",
      "Restore",
    ]);
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
      fireEvent.click(group("Modified").getByRole("button", { name: "Restore" }));
    });
    expect(sent("restore_change")).toHaveLength(1);
    expect(useApp.getState().deckUndo.at(-1)).toEqual({ previous: "old", source: "new" });
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

  it("does not restore a locked slide", async () => {
    const deck = deckFor(DECK_HTML.replace('id="intro"', 'id="intro" data-locked'));
    useApp.setState({ deck });
    await show();
    expect((group("Modified").getByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("has nothing to stage slide by slide before a first commit", async () => {
    await show(changes({ tracking: "notCommitted", commit: null, slides: [row("added", "intro")] }));
    expect(group("Added").queryByRole("button", { name: "Stage" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Commit message" })).toBeTruthy();
  });
});

describe("committing", () => {
  const button = () => screen.getByRole("button", { name: /^Commit/ }) as HTMLButtonElement;
  const message = () => screen.getByRole("textbox", { name: "Commit message" }) as HTMLTextAreaElement;

  it("needs something staged and a message", async () => {
    await show();
    fireEvent.change(message(), { target: { value: "Fix" } });
    expect(button().disabled).toBe(true);
    cleanup();
    await show(changes({ stagedFiles: 2 }));
    expect(button().textContent).toBe("Commit 2 files");
    expect(button().disabled).toBe(true);
    fireEvent.change(message(), { target: { value: "Fix" } });
    expect(button().disabled).toBe(false);
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
    expect(useApp.getState().error).toContain("hook said no");
  });

  it("warns when the commit takes in files from elsewhere", async () => {
    await show(changes({ stagedFiles: 3, stagedElsewhere: 2 }));
    expect(screen.getByText(/Also commits 2 staged files/)).toBeTruthy();
  });

  it("stages and unstages everything", async () => {
    await show(changes({ stagedFiles: 1 }));
    await act(async () => {
      fireEvent.click(screen.getByTitle("Stage everything in this deck"));
      fireEvent.click(screen.getByTitle("Unstage everything in this deck's folder"));
    });
    const calls = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    expect(calls).toContain("stage_all");
    expect(calls).toContain("unstage_all");
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

  it("names what the picture does not show", async () => {
    await show(changes({ slides: [row("modified", "intro", ["speaker notes"])] }));
    expect(screen.getByText("Modified since the last commit. Changed: speaker notes.")).toBeTruthy();
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
    expect((screen.getByRole("slider", { name: "Feather" }) as HTMLInputElement).disabled).toBe(true);
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
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(useChanges.getState().picked).toBe("removed:gone");
    fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Feather in pixels" }), { key: "ArrowDown" });
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
      fireEvent.click(screen.getByTitle("Compare again"));
    });
    expect(calls()).toBe(3);
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(calls()).toBe(4);
  });

  it("explains a deck outside a repository", async () => {
    await show(changes({ tracking: "noRepository", commit: null, slides: [] }));
    expect(screen.getByText("This deck is not in a git repository")).toBeTruthy();
  });

  it("shows a deck never committed as all new", async () => {
    await show(changes({ tracking: "notCommitted", commit: null, slides: [row("added", "intro")] }));
    expect(screen.getByText("Not committed yet")).toBeTruthy();
    expect(screen.getByText("Not committed yet, so every slide is new.")).toBeTruthy();
    expect(isComparing()).toBe(false);
  });
});
