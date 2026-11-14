import { invoke } from "@tauri-apps/api/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChanges } from "../changesStore";
import type { DeckChanges, SlideChange, SlideStatus } from "../lib/api";
import { DEFAULT_DIVIDER } from "../lib/compare";
import { deckMode, useApp } from "../store";
import { useConfirmQuestion } from "../store/confirm";
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
  textChanges: [],
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
  commit: { hash: "abc123", subject: "First draft", time: Math.round(Date.now() / 1000) - 2 * 86_400 },
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
  useConfirmQuestion.setState({ question: null, waiting: [] });
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
});

const sent = (cmd: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === cmd);
const group = (name: string) => within(screen.getByRole("group", { name }));
const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
/** Everything a user can read on the screen: the text, and what names and explains the controls. */
const words = () =>
  [
    document.body.textContent ?? "",
    ...[...document.querySelectorAll("[title], [aria-label], [placeholder]")].flatMap((element) => [
      element.getAttribute("title"),
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
    ]),
  ].join("\n");
/** Answers the commands of a discard, with a history that can undo it. */
const discards = (found: DeckChanges = changes()) =>
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "restore_change" || cmd === "restore_all_changes") {
      return { deck: deckFor(DECK_HTML), created: [], files: 0 };
    }
    if (cmd === "deck_history") return { undo: { label: "Discard changes", source: "deck" }, redo: null };
    return found;
  });

describe("Changes mode", () => {
  it("is a mode of its own", () => {
    useApp.getState().setMode("git");
    expect(deckMode(useApp.getState())).toBe("git");
    useApp.getState().setMode("view");
    expect(deckMode(useApp.getState())).toBe("view");
  });

  it("speaks of versions and changes, not of git's commits and staging", async () => {
    const both = { moved: true, oldNumber: 3, staged: true };
    await show(
      changes({
        stylesChanged: true,
        stagedFiles: 2,
        stagedElsewhere: 1,
        slides: [...LIST, row("modified", "x", ["speaker notes"], both)],
      }),
    );
    expect(words()).not.toMatch(/commit|stage|\bindex\b|HEAD|repository/i);
    // Git is named once per place, as how versions are kept, for those who want to know.
    expect(screen.getAllByTestId("branch")[0]!.title).toBe("Versions are saved with Git, on the branch main");
    cleanup();
    await show(changes({ tracking: "notCommitted", commit: null, slides: [row("added", "intro")] }));
    expect(words()).not.toMatch(/commit|stage|\bindex\b|HEAD|repository/i);
    cleanup();
    await show(changes({ slides: [row("unchanged", "intro")], hasUnstaged: false }));
    expect(words()).not.toMatch(/commit|stage|\bindex\b|HEAD|repository/i);
  });
});

describe("ChangesRail", () => {
  it("lists the slides with the removed ones among them, marked by what changed", async () => {
    await show();
    expect(rows()).toEqual(["modified", "removed", "unchanged", "added"]);
    expect(screen.getByRole("button", { name: "Slide 1, changed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slide, removed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slide 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slide 3, new" })).toBeTruthy();
  });

  it("lifts every thumbnail off the rail with a shadow", async () => {
    await show();
    for (const name of ["Slide 1, changed", "Slide, removed", "Slide 2", "Slide 3, new"]) {
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
    expect(screen.getByRole("button", { name: "Slide 1, changed" }).className).not.toMatch(/transition/);
  });

  it("shows a removed slide from the last version, with its runtime brought up to date", async () => {
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
    expect(screen.getByTitle("1 changed").textContent).toBe("1");
    expect(screen.getByTitle("1 changed").querySelector("svg")).toBeTruthy();
    expect(screen.getByTitle("1 removed")).toBeTruthy();
    expect(screen.getByTitle("1 new")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Show only the slides that changed" }));
    expect(rows()).toEqual(["modified", "removed", "added"]);
    expect(screen.getByRole("button", { name: "Show every slide" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("says when nothing changed", async () => {
    await show(changes({ slides: [row("unchanged", "intro")] }));
    fireEvent.click(screen.getByRole("button", { name: "Show only the slides that changed" }));
    expect(screen.getByText("No slide changed.")).toBeTruthy();
  });
});

describe("marks", () => {
  it("marks a change with an icon in a corner of the picture, not a word", async () => {
    await show();
    expect(screen.getAllByTestId("change-mark").map((m) => m.title)).toEqual(["Changed", "Removed", "New"]);
    expect(screen.getAllByTestId("change-mark").every((m) => m.textContent === "")).toBe(true);
    const picture = screen.getByRole("button", { name: "Slide 1, changed" });
    const mark = within(picture.parentElement!).getByTestId("change-mark");
    expect(mark.className).toContain("right-1");
    expect(mark.className).toContain("top-1");
  });

  it("puts the move of a slide that changed in its own field under the picture", async () => {
    await show(changes({ slides: [row("modified", "intro", [], { moved: true, oldNumber: 3 })] }));
    expect(screen.getAllByTestId("change-mark").map((m) => m.title)).toEqual(["Changed", "Moved"]);
    const move = screen.getByTestId("move-row");
    expect(move.textContent).toContain("3 → 1");
    expect(move.querySelector("span[title]")?.getAttribute("title")).toBe("Moved from slide 3 to slide 1");
    const picture = screen.getByRole("button", { name: "Slide 1, changed and moved" });
    expect(picture.contains(move)).toBe(false);
    expect(within(picture.parentElement as HTMLElement).queryByTestId("move-row")).toBeNull();
  });

  it("leaves the picture of a slide that only moved unmarked, with the move under it", async () => {
    await show(changes({ slides: [row("moved", "intro", [], { moved: true, oldNumber: 3 })] }));
    expect(screen.getAllByTestId("change-mark").map((m) => m.title)).toEqual(["Moved"]);
    expect(screen.getByTestId("move-row")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slide 1, moved" })).toBeTruthy();
  });
});

describe("picking changes for a version", () => {
  it("has a checkbox on each changed slide and no buttons under it", async () => {
    await show();
    const list = within(screen.getByRole("list"));
    expect(list.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual([
      "Include slide 1 in this version",
      "Include the removed slide in this version",
      "Include slide 3 in this version",
    ]);
    // The list is pictures and checkboxes: what discards is beside the large slide.
    expect(list.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Slide 1, changed",
      "Slide, removed",
      "Slide 2",
      "Slide 3, new",
    ]);
    expect(list.queryByText(/Discard/)).toBeNull();
  });

  it("includes a slide without having to pick it first", async () => {
    await show();
    await act(async () => {
      fireEvent.click(box("Include slide 3 in this version"));
    });
    expect(sent("stage_change")[0]?.[1]).toMatchObject({ change: { kind: "slide", id: "outro", oldId: null } });
    expect(useChanges.getState().picked).toBe("intro");
  });

  it("shows what is included as ticked, and takes it out again", async () => {
    await show(
      changes({ stagedFiles: 1, slides: [row("modified", "intro", [], { staged: true }), row("added", "x")] }),
    );
    expect(box("Include slide 1 in this version").checked).toBe(true);
    expect(box("Include slide 2 in this version").checked).toBe(false);
    await act(async () => {
      fireEvent.click(box("Include slide 1 in this version"));
    });
    expect(sent("unstage_change")[0]?.[1]).toMatchObject({ change: { kind: "slide", id: "intro", oldId: "intro" } });
  });

  it("ticks a move apart from the slide's change", async () => {
    const both = { moved: true, oldNumber: 3 };
    await show(changes({ slides: [row("modified", "intro", [], { ...both, moveStaged: true })] }));
    expect(box("Include slide 1 in this version").checked).toBe(false);
    const move = box("Include the move of slide 1 in this version");
    expect(move.checked).toBe(true);
    expect(screen.getByTestId("move-row").contains(move)).toBe(true);
    await act(async () => {
      fireEvent.click(move);
    });
    expect(sent("unstage_change")[0]?.[1]).toMatchObject({ change: { kind: "move", id: "intro", oldId: "intro" } });
  });

  it("lists a change to the shared styles above the slides, with its own checkbox", async () => {
    await show(changes({ stylesChanged: true, slides: [row("unchanged", "intro")] }));
    const styles = within(screen.getByTestId("styles-row"));
    expect(styles.getByText("Shared styles")).toBeTruthy();
    expect(screen.getByTestId("styles-row").nextElementSibling?.getAttribute("data-testid")).toBe("change-row");
    await act(async () => {
      fireEvent.click(styles.getByRole("checkbox", { name: "Include the shared styles in this version" }));
    });
    expect(sent("stage_change")[0]?.[1]).toMatchObject({ change: { kind: "styles" } });
  });

  it("says when only the styles changed, and lists no styles row while nothing of them did", async () => {
    await show(changes({ stylesChanged: true, stylesStaged: true, slides: [row("unchanged", "intro")] }));
    const styles = within(screen.getByTestId("styles-row"));
    const tick = styles.getByRole("checkbox", {
      name: "Include the shared styles in this version",
    }) as HTMLInputElement;
    expect(tick.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show only the slides that changed" }));
    expect(screen.getByText("No slide changed, only the shared styles.")).toBeTruthy();
    cleanup();
    useChanges.setState({ onlyChanges: false });
    await show();
    expect(screen.queryByTestId("styles-row")).toBeNull();
  });

  it("ticks everything or nothing with one press", async () => {
    await show(changes({ stagedFiles: 1 }));
    const pick = within(screen.getByTestId("version-box"));
    await act(async () => {
      fireEvent.click(pick.getByRole("button", { name: "All" }));
      fireEvent.click(pick.getByRole("button", { name: "None" }));
    });
    expect(sent("stage_all")).toHaveLength(1);
    expect(sent("unstage_all")).toHaveLength(1);
    cleanup();
    await show(changes({ hasUnstaged: false, stagedFiles: 2, stagedElsewhere: 2 }));
    const none = within(screen.getByTestId("version-box"));
    expect((none.getByRole("button", { name: "All" }) as HTMLButtonElement).disabled).toBe(true);
    expect((none.getByRole("button", { name: "None" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the picked slide's actions", () => {
  it("are beside the caption of the large slide, said in full", async () => {
    await show();
    const actions = screen.getByRole("group", { name: "Changed" });
    expect(screen.getByRole("list").contains(actions)).toBe(false);
    expect(actions.parentElement!.textContent).toContain("Changed since the last version.");
    expect(within(actions).getByRole("checkbox", { name: "Include in this version" })).toBeTruthy();
    expect(within(actions).getByRole("button", { name: "Discard changes" })).toBeTruthy();
  });

  it("names putting a change back by what it does to it, in red where work goes with it", async () => {
    await show();
    const discard = group("Changed").getByRole("button", { name: "Discard changes" });
    expect(discard.className).toContain("text-destructive");
    fireEvent.click(screen.getByRole("button", { name: "Slide 3, new" }));
    expect(group("New").getByRole("button", { name: "Discard new slide" }).className).toContain("text-destructive");
    fireEvent.click(screen.getByRole("button", { name: "Slide, removed" }));
    const back = group("Removed").getByRole("button", { name: "Bring back" });
    expect(back.className).not.toContain("text-destructive");
    expect(back.title).toBe("Put this slide back in the deck, as it was in the last version");
    fireEvent.click(screen.getByRole("button", { name: "Slide 2" }));
    expect(screen.queryByRole("group", { name: /Changed|New|Removed|Moved/ })).toBeNull();
  });

  it("follows the slide picked: its tick is the list's tick", async () => {
    await show(changes({ stagedFiles: 1, slides: [row("modified", "intro", [], { staged: true })] }));
    const tick = group("Changed").getByRole("checkbox", { name: "Include in this version" }) as HTMLInputElement;
    expect(tick.checked).toBe(true);
    await act(async () => {
      fireEvent.click(tick);
    });
    expect(sent("unstage_change")).toHaveLength(1);
  });

  it("gives an edit and a move their own actions", async () => {
    await show(changes({ slides: [row("modified", "intro", [], { moved: true, oldNumber: 3 })] }));
    expect(group("Changed").getByRole("button", { name: "Discard changes" })).toBeTruthy();
    expect(group("Moved").getByRole("checkbox", { name: "Include the move" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(group("Moved").getByRole("checkbox", { name: "Include the move" }));
    });
    expect(sent("stage_change")[0]?.[1]).toMatchObject({ change: { kind: "move", id: "intro", oldId: "intro" } });
    discards();
    await act(async () => {
      fireEvent.click(group("Moved").getByRole("button", { name: "Undo move" }));
    });
    expect(sent("restore_change")[0]?.[1]).toMatchObject({ change: { kind: "move", id: "intro", oldId: "intro" } });
  });

  it("discards a slide's changes at once, and says so with a way back", async () => {
    await show();
    discards();
    await act(async () => {
      fireEvent.click(group("Changed").getByRole("button", { name: "Discard changes" }));
    });
    expect(sent("restore_change")[0]?.[1]).toMatchObject({ change: { kind: "slide", id: "intro", oldId: "intro" } });
    expect(toastTexts(useApp.getState(), "success")).toEqual(["The slide is back as in the last version"]);
    expect(useApp.getState().toasts[0]?.action?.label).toBe("Undo");
  });

  it("includes and discards the shared styles over the slide", async () => {
    await show(changes({ stylesChanged: true }));
    const styles = group("Shared styles");
    await act(async () => {
      fireEvent.click(styles.getByRole("checkbox", { name: "Include the shared styles in this version" }));
    });
    expect(sent("stage_change")[0]?.[1]).toMatchObject({ change: { kind: "styles" } });
    discards();
    await act(async () => {
      fireEvent.click(styles.getByRole("button", { name: "Discard changes" }));
    });
    expect(sent("restore_change")[0]?.[1]).toMatchObject({ change: { kind: "styles" } });
    expect(toastTexts(useApp.getState(), "success")).toEqual(["The shared styles are back as in the last version"]);
  });

  it("does not discard the changes of a locked slide, and says why", async () => {
    useApp.setState({ deck: deckFor(DECK_HTML.replace('id="intro"', 'id="intro" data-locked')) });
    await show();
    const discard = group("Changed").getByRole("button", { name: "Discard changes" }) as HTMLButtonElement;
    expect(discard.disabled).toBe(true);
    expect(discard.title).toBe("This slide is locked; unlock it first");
  });
});

describe("a deck with no version yet", () => {
  const first = () =>
    changes({ tracking: "notCommitted", commit: null, slides: [row("added", "intro"), row("added", "#2")] });

  it("explains itself once, calmly, in place of a mark and a red button on every slide", async () => {
    await show(first());
    const explained = within(screen.getByTestId("first-version"));
    expect(explained.getByText("Nothing saved yet")).toBeTruthy();
    expect(explained.getByText(/Save a first version of this deck/)).toBeTruthy();
    expect(screen.queryByTestId("change-mark")).toBeNull();
    expect(screen.queryByTestId("count-badge")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Discard/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show only the slides that changed" })).toBeNull();
    // The slides are plain pictures, not a list of additions.
    expect(screen.getByRole("button", { name: "Slide 1" }).className).not.toMatch(/ring-success/);
    expect(document.querySelector(".opacity-50")).toBeNull();
  });

  it("says so over the slide too, with nothing to compare", async () => {
    await show(first());
    expect(screen.getByText("No version saved yet")).toBeTruthy();
    expect(screen.getByText("No version of this deck is saved yet.")).toBeTruthy();
    expect(isComparing()).toBe(false);
  });

  it("saves the first version of everything, under a name it suggests", async () => {
    await show(first());
    const message = screen.getByRole("textbox", { name: "What changed" }) as HTMLTextAreaElement;
    expect(message.value).toBe("First version");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save first version" }));
    });
    const calls = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    expect(calls.indexOf("stage_all")).toBeGreaterThan(-1);
    expect(calls.indexOf("stage_all")).toBeLessThan(calls.indexOf("commit_changes"));
    expect(sent("commit_changes")[0]?.[1]).toMatchObject({ message: "First version" });
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Saved a version"]);
  });

  it("takes everything even when something was picked outside the app", async () => {
    await show({ ...first(), stagedFiles: 1 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save first version" }));
    });
    expect(sent("stage_all")).toHaveLength(1);
  });
});

describe("saving a version", () => {
  const button = () => screen.getByRole("button", { name: /^Save (version|1 change|what)/ }) as HTMLButtonElement;
  const message = () => screen.getByRole("textbox", { name: "What changed" }) as HTMLTextAreaElement;

  it("suggests a message from what changed, and never waits for one", async () => {
    await show();
    expect(message().value).toBe("Change 1 slide, add 1, remove 1");
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe("Save version");
    expect(button().title).toBe("Save a version of everything that changed in this deck (Ctrl+Enter)");
    await act(async () => {
      fireEvent.click(button());
    });
    const calls = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    expect(calls.indexOf("stage_all")).toBeGreaterThan(-1);
    expect(calls.indexOf("stage_all")).toBeLessThan(calls.indexOf("commit_changes"));
    expect(sent("commit_changes")[0]?.[1]).toMatchObject({ message: "Change 1 slide, add 1, remove 1" });
  });

  it("selects the suggestion on focus, so that typing replaces it, but not what was typed", async () => {
    await show();
    fireEvent.focus(message());
    expect([message().selectionStart, message().selectionEnd]).toEqual([0, message().value.length]);
    fireEvent.change(message(), { target: { value: "New pricing" } });
    message().setSelectionRange(3, 3);
    fireEvent.focus(message());
    expect([message().selectionStart, message().selectionEnd]).toEqual([3, 3]);
  });

  it("follows the changes until it is typed over", async () => {
    await show();
    vi.mocked(invoke).mockResolvedValue(changes({ slides: [row("added", "intro"), row("added", "#2")] }));
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(message().value).toBe("Add 2 slides");
    fireEvent.change(message(), { target: { value: "Mine" } });
    vi.mocked(invoke).mockResolvedValue(changes());
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(message().value).toBe("Mine");
  });

  it("falls back to the suggestion when the message is emptied", async () => {
    await show();
    fireEvent.change(message(), { target: { value: "  " } });
    expect(message().placeholder).toBe("Change 1 slide, add 1, remove 1");
    expect(button().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(sent("commit_changes")[0]?.[1]).toMatchObject({ message: "Change 1 slide, add 1, remove 1" });
  });

  it("saves only what is ticked once something is, and says how much", async () => {
    const picked = [row("modified", "intro", [], { staged: true }), row("added", "x")];
    await show(changes({ stagedFiles: 2, slides: picked }));
    expect(button().textContent).toBe("Save 1 change");
    expect(button().title).toBe("Save a version of only what is ticked (Ctrl+Enter)");
    expect(message().value).toBe("Change 1 slide");
    await act(async () => {
      fireEvent.click(button());
    });
    expect(sent("stage_all")).toHaveLength(0);
    expect(sent("commit_changes")).toHaveLength(1);
    cleanup();
    // Files picked outside the app, which no row stands for.
    await show(changes({ stagedFiles: 1 }));
    expect(button().textContent).toBe("Save what is ticked");
  });

  it("saves under the message typed, then suggests afresh", async () => {
    await show(changes({ stagedFiles: 1 }));
    fireEvent.change(message(), { target: { value: "Reword the intro" } });
    await act(async () => {
      fireEvent.click(button());
    });
    expect(sent("commit_changes")[0]?.[1]).toMatchObject({ message: "Reword the intro" });
    expect(message().value).toBe("Change 1 slide, add 1, remove 1");
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Saved a version"]);
  });

  it("keeps the message when saving fails, and says why", async () => {
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

  it("says when the version takes in files from elsewhere", async () => {
    await show(changes({ stagedFiles: 3, stagedElsewhere: 2 }));
    expect(screen.getByText("Also saves 2 included files outside this deck's folder.")).toBeTruthy();
  });

  it("discards every change at once, after asking in the app", async () => {
    await show();
    const question = () => useConfirmQuestion.getState().question;
    fireEvent.click(screen.getByRole("button", { name: "Discard all…" }));
    expect(question()).toMatchObject({
      title: "Discard all changes to this deck?",
      confirmLabel: "Discard all changes",
      destructive: true,
    });
    expect(question()!.message).toContain("“First draft”");
    expect(question()!.message).toContain("Ctrl+Z brings the slides' changes back, but not files");
    await act(async () => question()!.answer(false));
    expect(sent("restore_all_changes")).toHaveLength(0);

    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "restore_all_changes") return { deck: deckFor(DECK_HTML), created: [], files: 0 };
      if (cmd === "deck_history") return { undo: { label: "Discard all changes", source: "deck" }, redo: null };
      return changes();
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard all…" }));
    await act(async () => question()!.answer(true));
    await vi.waitFor(() =>
      expect(toastTexts(useApp.getState(), "success")).toEqual(["The deck is back as in the last version"]),
    );
    expect(sent("restore_all_changes")).toHaveLength(1);
    expect(useApp.getState().toasts[0]?.action?.label).toBe("Undo");
  });

  it("does not discard everything while a changed slide is locked", async () => {
    useApp.setState({ deck: deckFor(DECK_HTML.replace('id="intro"', 'id="intro" data-locked')) });
    await show();
    const discard = screen.getByRole("button", { name: "Discard all…" }) as HTMLButtonElement;
    expect(discard.disabled).toBe(true);
    expect(discard.title).toBe("Slide 1 is locked; unlock it to discard its changes");
  });
});

describe("how versions are kept", () => {
  it("is a quiet detail: Git and the branch, under the button and beside what is compared", async () => {
    await show(changes({ branch: "talks/q3" }));
    const shown = screen.getAllByTestId("branch");
    expect(shown.map((b) => b.textContent)).toEqual(["talks/q3", "talks/q3"]);
    expect(shown[0]!.title).toBe("Versions are saved with Git, on the branch talks/q3");
    expect(screen.getByTestId("version-box").lastElementChild).toBe(shown[0]);
    expect(shown[1]!.parentElement!.textContent).toContain("Since “First draft”, 2d ago");
  });

  it("warns when no branch is checked out, in plain words", async () => {
    await show(changes({ branch: null, detached: true }));
    const [first] = screen.getAllByTestId("branch");
    expect(first!.textContent).toBe("Not on a branch");
    expect(first!.className).toContain("text-warning");
    expect(first!.title).toContain("a version saved now is on no branch");
  });

  it("shows nothing where there is none to name", async () => {
    await show(changes({ branch: null, detached: false }));
    expect(screen.queryByTestId("branch")).toBeNull();
  });
});

describe("states", () => {
  it("says that nothing changed since the last version, by its name, with nothing to save", async () => {
    await show(changes({ slides: [row("unchanged", "intro"), row("unchanged", "#2")], hasUnstaged: false }));
    const clean = screen.getByTestId("no-changes");
    expect(clean.textContent).toContain("No changes since the last version");
    expect(clean.textContent).toContain("“First draft”, 2d ago");
    expect(within(clean).getByTitle("First draft (abc123)")).toBeTruthy();
    expect(within(clean).getByTestId("branch").textContent).toBe("main");
    expect(screen.queryByRole("textbox", { name: "What changed" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    // The slides are still there to look at.
    expect(rows()).toEqual(["unchanged", "unchanged"]);
  });

  it("keeps the way to save while something waits to be saved", async () => {
    await show(
      changes({ slides: [row("unchanged", "intro")], hasUnstaged: false, stagedFiles: 1, stagedElsewhere: 1 }),
    );
    expect(screen.queryByTestId("no-changes")).toBeNull();
    expect((screen.getByRole("textbox", { name: "What changed" }) as HTMLTextAreaElement).value).toBe(
      "Update the deck",
    );
  });

  it("says that it is looking for changes until they are there", async () => {
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
    expect(screen.getAllByRole("status").map((s) => s.textContent)).toEqual([
      "Looking for changes…",
      "Looking for changes…",
    ]);
    expect(screen.queryByRole("textbox", { name: "What changed" })).toBeNull();
    await act(async () => finish(changes()));
    expect(screen.queryByRole("status")).toBeNull();
    expect(isComparing()).toBe(true);
  });

  it("says what went wrong looking for them, and tries again when asked", async () => {
    vi.mocked(invoke).mockRejectedValue("fatal: not a git repository");
    await act(async () => {
      render(<ChangesView />);
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Could not look for changes");
    expect(alert.textContent).toContain("fatal: not a git repository");
    expect(lastError(useApp.getState())).toBeNull();
    vi.mocked(invoke).mockResolvedValue(changes());
    await act(async () => {
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(isComparing()).toBe(true);
  });
});

describe("ChangesView", () => {
  const view = (name: string) => within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name });
  const flip = () => screen.getByRole("button", { name: "Hold to see the other version" }) as HTMLButtonElement;
  const version = () => screen.getByTestId("single-version").dataset.version;
  const shown = () => [...screen.getByTestId("single-version").querySelectorAll("iframe")].map((f) => f.src);

  it("compares a changed slide, and names the version it compares with", async () => {
    await show();
    expect(isComparing()).toBe(true);
    const since = screen.getByText("Since “First draft”, 2d ago");
    expect(since.title).toBe("Compared with the last version: First draft (abc123)");
    const both = frames().filter((src) => src.includes("slide=intro"));
    expect(both.some((src) => src.includes(".head"))).toBe(true);
    expect(both.some((src) => src.includes(".file"))).toBe(true);
    // The halves go by the names of the buttons that show one of them.
    const halves = within(screen.getByTestId("slide-comparison"));
    expect(halves.getByText("Before")).toBeTruthy();
    expect(halves.getByText("After")).toBeTruthy();
  });

  it.each([
    ["Slide 3, new", "New since the last version."],
    ["Slide, removed", "Removed since the last version; this is how it looked."],
    ["Slide 2", "No changes to this slide."],
  ])("shows %s as it is, with nothing to slide across", async (name, text) => {
    await show();
    fireEvent.click(screen.getByRole("button", { name }));
    expect(isComparing()).toBe(false);
    expect(screen.getByText(text)).toBeTruthy();
    // One version only: nothing to switch between or to flip to.
    for (const name of ["Split", "Before", "After"]) expect((view(name) as HTMLButtonElement).disabled).toBe(true);
    expect(flip().disabled).toBe(true);
    expect(screen.queryByTestId("flip-surface")).toBeNull();
  });

  it("shows one version at a time when asked: before, or after", async () => {
    await show();
    expect(view("Split").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(view("Before"));
    expect(isComparing()).toBe(false);
    expect(view("Before").getAttribute("aria-pressed")).toBe("true");
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain(".head");
    expect(screen.getByTestId("version-name").textContent).toBe("Before.");
    fireEvent.click(view("After"));
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain(".file");
    expect(screen.getByTestId("version-name").textContent).toBe("After.");
    fireEvent.click(view("Split"));
    expect(isComparing()).toBe(true);
    expect(screen.queryByTestId("version-name")).toBeNull();
  });

  it("keeps the view going from slide to slide", async () => {
    await show(changes({ slides: [row("modified", "intro"), row("modified", "#2")] }));
    fireEvent.click(view("Before"));
    fireEvent.click(screen.getByRole("button", { name: "Slide 2, changed" }));
    expect(useChanges.getState().view).toBe("before");
    expect(isComparing()).toBe(false);
  });

  it("has no settings for the divider: it is dragged, and put back with a double click", async () => {
    await show();
    expect(screen.queryByRole("button", { name: "Divider" })).toBeNull();
    expect(screen.queryByRole("slider", { name: /Angle|Feather/ })).toBeNull();
    useChanges.getState().setDivider({ angle: 40, x: 0.1 });
    fireEvent.doubleClick(screen.getByRole("slider", { name: "Rotate the divider" }));
    expect(useChanges.getState().divider).toEqual(DEFAULT_DIVIDER);
  });

  it("flips to the other version in place while Space is held", async () => {
    await show();
    fireEvent.click(view("After"));
    expect(version()).toBe("after");
    fireEvent.keyDown(window, { key: " " });
    expect(version()).toBe("before");
    expect(shown()[0]).toContain(".head");
    expect(screen.getByTestId("version-name").textContent).toBe("Before.");
    expect(view("Before").getAttribute("aria-pressed")).toBe("true");
    // The key repeats while held: that does not flip back and forth.
    fireEvent.keyDown(window, { key: " ", repeat: true });
    expect(version()).toBe("before");
    fireEvent.keyUp(window, { key: " " });
    expect(version()).toBe("after");
    expect(useChanges.getState().view).toBe("after");
  });

  it("shows the slide as it was, whole, while Space is held over the split view", async () => {
    await show();
    fireEvent.keyDown(window, { key: " " });
    expect(isComparing()).toBe(false);
    expect(version()).toBe("before");
    fireEvent.keyUp(window, { key: " " });
    expect(isComparing()).toBe(true);
  });

  it("flips while its button or the slide is pressed, and lets go when the window is left", async () => {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    await show();
    fireEvent.click(view("Before"));
    expect(flip().title).toBe("Hold to see the other version (Space)");
    fireEvent.pointerDown(flip(), { button: 0, pointerId: 1 });
    expect(version()).toBe("after");
    expect(flip().getAttribute("aria-pressed")).toBe("true");
    fireEvent.pointerUp(flip());
    expect(version()).toBe("before");
    fireEvent.pointerDown(screen.getByTestId("flip-surface"), { button: 0, pointerId: 1 });
    expect(version()).toBe("after");
    fireEvent.pointerUp(screen.getByTestId("flip-surface"));
    expect(version()).toBe("before");
    // From the keyboard, on the button: Space and Enter hold it too.
    fireEvent.keyDown(flip(), { key: "Enter" });
    expect(version()).toBe("after");
    fireEvent.keyUp(flip(), { key: "Enter" });
    expect(version()).toBe("before");
    fireEvent.keyDown(window, { key: " " });
    fireEvent.blur(window);
    expect(version()).toBe("before");
  });

  it("leaves Space to the control it is pressed on, and to the message being typed", async () => {
    await show();
    fireEvent.keyDown(group("Changed").getByRole("button", { name: "Discard changes" }), { key: " " });
    expect(useChanges.getState().flipped).toBe(false);
    fireEvent.keyDown(screen.getByRole("checkbox", { name: "Include slide 1 in this version" }), { key: " " });
    expect(useChanges.getState().flipped).toBe(false);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "What changed" }), { key: " " });
    expect(useChanges.getState().flipped).toBe(false);
  });

  it("compares every slide once the shared styles changed", async () => {
    await show(changes({ stylesChanged: true }));
    fireEvent.click(screen.getByRole("button", { name: "Slide 2" }));
    expect(isComparing()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Slide 3, new" }));
    expect(isComparing()).toBe(false);
  });

  it("goes through the list with the arrow keys, but not while typing the message", async () => {
    await show();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "What changed" }), { key: "ArrowDown" });
    expect(useChanges.getState().picked).toBe("intro");
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(useChanges.getState().picked).toBe("removed:gone");
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(useChanges.getState().picked).toBe("intro");
  });

  it("compares again when the deck changes, when asked, and on coming back to the window", async () => {
    await show();
    const calls = () => sent("deck_changes").length;
    expect(calls()).toBe(1);
    await act(async () => {
      useApp.setState({ deck: deckFor(DECK_HTML, "2") });
    });
    expect(calls()).toBe(2);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Look for changes again" }));
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
});

describe("the words that changed", () => {
  const texts = [
    { where: "slide" as const, before: "Basic plan: $10 a month", after: "Basic plan: $12 a month" },
    { where: "notes" as const, before: "", after: "Mention the discount" },
    { where: "narration" as const, before: "Welcome everyone", after: "" },
  ];
  const edited = () =>
    changes({ slides: [row("modified", "intro", ["speaker notes"], { textChanges: texts }), row("modified", "#2")] });

  it("are listed under the slide, before and after, with the changed words marked", async () => {
    await show(edited());
    const list = within(screen.getByRole("region", { name: "Text changes" }));
    expect(list.getByRole("button", { name: /Text changes/ }).textContent).toContain("3 places");
    const [slide, notes, narration] = list.getAllByTestId("changed-text");
    expect(slide!.textContent).toContain("On the slide");
    expect([...slide!.querySelectorAll("dt")].map((name) => name.textContent)).toEqual(["Before", "After"]);
    const [before, after] = [...slide!.querySelectorAll("dd")];
    expect(before!.textContent).toBe("Basic plan: $10 a month");
    expect(after!.textContent).toBe("Basic plan: $12 a month");
    expect([...slide!.querySelectorAll("del")].map((word) => word.textContent)).toEqual(["$10"]);
    expect([...slide!.querySelectorAll("ins")].map((word) => word.textContent)).toEqual(["$12"]);
    // What no picture shows: the notes and the narration, with a side that has nothing saying so.
    expect(notes!.textContent).toContain("Speaker notes");
    expect(notes!.querySelector("dd")!.textContent).toBe("Nothing");
    expect(notes!.querySelector("ins")!.textContent).toBe("Mention the discount");
    expect(narration!.textContent).toContain("Narration");
    expect(narration!.querySelector("del")!.textContent).toBe("Welcome everyone");
  });

  it("fold away, and stay folded from slide to slide", async () => {
    await show(
      changes({
        slides: [
          row("modified", "intro", [], { textChanges: texts }),
          row("modified", "#2", [], { textChanges: texts.slice(0, 1) }),
        ],
      }),
    );
    const toggle = () => screen.getByRole("button", { name: /Text changes/ });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("changed-text")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Slide 2, changed" }));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toContain("1 place");
  });

  it("are not there for a slide whose words did not change", async () => {
    await show(edited());
    fireEvent.click(screen.getByRole("button", { name: "Slide 2, changed" }));
    expect(screen.queryByRole("region", { name: "Text changes" })).toBeNull();
  });
});
