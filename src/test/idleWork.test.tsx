/**
 * A window left alone does nothing: with a deck open in each mode, and on the start screen, no
 * timer, interval or animation frame runs while nobody does anything. A clock, a poll or an
 * animation left going would show here as work done every frame or every second, for as long as
 * the app is open.
 */
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

import { App } from "../App";
import { preloadLazyParts } from "../components/lazy";
import { Tooltips } from "../components/Tooltip";
import { useApp } from "../store";
import type { AppState } from "../store/types";
import { DECK_HTML, deckFor } from "./fixtures";
import { invoke } from "./tauri";

const WORKSPACE = { path: "/decks", name: "decks" };

// Every part is there, as in the app once it has been idle (the code editor takes a while to load here).
beforeAll(preloadLazyParts, 120_000);

/** What the window schedules while `run` runs: timers, intervals and frames asked for, and those that ran. */
function scheduledDuring(run: () => void) {
  const counts = { timeouts: 0, intervals: 0, frames: 0, ran: 0 };
  const wrap = <F extends (...args: never[]) => unknown>(
    name: "setTimeout" | "setInterval" | "requestAnimationFrame",
    key: keyof typeof counts,
  ) => {
    const inner = window[name] as unknown as F;
    const spy = vi.spyOn(window, name).mockImplementation(((
      callback: (...a: unknown[]) => void,
      ...rest: unknown[]
    ) => {
      counts[key]++;
      return (inner as unknown as (...a: unknown[]) => number)(
        (...a: unknown[]) => {
          counts.ran++;
          callback(...a);
        },
        ...rest,
      );
    }) as never);
    return spy;
  };
  const spies = [
    wrap("setTimeout", "timeouts"),
    wrap("setInterval", "intervals"),
    wrap("requestAnimationFrame", "frames"),
  ];
  try {
    run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return counts;
}

/** A clock left going: a second's interval for as long as it is mounted. */
function Clock() {
  useEffect(() => {
    const timer = setInterval(() => {}, 1000);
    return () => clearInterval(timer);
  }, []);
  return null;
}

const NOTHING = { timeouts: 0, intervals: 0, frames: 0, ran: 0 };

beforeEach(() => {
  // The backend answers, with nothing to tell.
  invoke.mockResolvedValue(null);
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "Date",
      "performance",
    ],
  });
  useApp.setState({
    booted: true,
    workspace: WORKSPACE,
    openedFile: null,
    deck: deckFor(DECK_HTML),
    slideMode: "view",
    editing: false,
    sidebarOpen: true,
    sidebarMaximized: false,
    railOpen: true,
    timelineOpen: false,
    presenting: false,
    deckSettingsOpen: false,
    toasts: [],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Renders the window and lets what it starts with settle: loads, debounces, the first frames. */
async function settled(state: Partial<AppState> = {}, extra: React.ReactNode = null) {
  useApp.setState(state);
  render(
    <>
      <App />
      <Tooltips />
      {extra}
    </>,
  );
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
  }
}

describe("a window left alone", () => {
  it.each<[string, Partial<AppState>]>([
    ["the start screen", { workspace: null, deck: null }],
    ["a deck in View", { slideMode: "view" }],
    ["a deck in Edit", { editing: true }],
    ["a deck in Changes", { slideMode: "git" }],
    ["a deck with the timeline open", { timelineOpen: true }],
  ])("schedules nothing on %s", async (_name, state) => {
    await settled(state);
    // The window is there, not an error in its place.
    expect(document.body.textContent).not.toMatch(/went wrong/i);
    // The workbench is up around the deck (its slide list), or the start screen without one.
    expect(document.body.textContent?.includes("Slides · 3")).toBe(state.deck !== null);
    const counts = scheduledDuring(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(counts).toEqual(NOTHING);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is told apart from one where a clock was left going", async () => {
    await settled({}, <Clock />);
    expect(vi.getTimerCount()).toBe(1);
    expect(scheduledDuring(() => vi.advanceTimersByTime(5000)).ran).toBe(0);
  });
});
