import { act, fireEvent, render, screen } from "@testing-library/react";
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

const row = (status: SlideStatus, id: string, details: string[] = []): SlideChange => ({
  key: status === "removed" ? `removed:${id}` : id,
  status,
  id: status === "removed" ? null : id,
  oldId: status === "added" ? null : id,
  details,
});

const LIST = [row("modified", "intro"), row("removed", "gone"), row("unchanged", "#2"), row("added", "outro")];

const changes = (overrides: Partial<DeckChanges> = {}): DeckChanges => ({
  tracking: "committed",
  commit: { hash: "abc123", subject: "First draft" },
  stylesChanged: false,
  oldSize: null,
  slides: LIST,
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
  useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", view: "slides", editing: false, slideMode: "view" });
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
