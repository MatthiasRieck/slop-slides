/**
 * A long session leaves nothing behind: switching slides and modes, opening and closing the
 * palette, the dialogs and the settings again and again, and opening one deck after another,
 * the window holds as many listeners, observers and timers after a hundred rounds as after one.
 * What a part adds as it mounts it takes away as it goes.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

import { App } from "../App";
import { closePalette, openPalette } from "../commands/palette";
import { preloadLazyParts } from "../components/lazy";
import { Tooltips } from "../components/Tooltip";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "./fixtures";
import { observerCount } from "./intersection";
import { invoke } from "./tauri";

// Every part is there, as in the app once it has been idle (the code editor takes a while to load here).
beforeAll(preloadLazyParts, 120_000);

/** Listeners on the window and the document, added less removed, by event type. */
function countListeners() {
  const live = new Map<string, number>();
  const targets = [window, document] as EventTarget[];
  const spies = targets.flatMap((target) => {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    return [
      vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
        live.set(type, (live.get(type) ?? 0) + 1);
        add(type, listener, options);
      }),
      vi.spyOn(target, "removeEventListener").mockImplementation((type, listener, options) => {
        live.set(type, (live.get(type) ?? 0) - 1);
        remove(type, listener, options);
      }),
    ];
  });
  return {
    /** The listeners added and not removed, by type; those at zero left out. */
    now: () => Object.fromEntries([...live].filter(([, n]) => n !== 0).sort()),
    stop: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

/** What the window holds: listeners on it, observers of what is in view, timers waiting. */
const holdings = (listeners: ReturnType<typeof countListeners>) => ({
  listeners: listeners.now(),
  observers: observerCount(),
  timers: vi.getTimerCount(),
});

const DECKS = [
  "/decks/a/deck.html",
  "/decks/b/deck.html",
  "/decks/c/deck.html",
  "/decks/d/deck.html",
  "/decks/e/deck.html",
];

beforeEach(() => {
  invoke.mockResolvedValue(null);
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  useApp.setState({
    booted: true,
    workspace: { path: "/decks", name: "decks" },
    openedFile: null,
    deck: { ...deckFor(DECK_HTML), id: DECKS[0]! },
    slideMode: "view",
    editing: false,
    sidebarOpen: true,
    sidebarMaximized: false,
    railOpen: true,
    timelineOpen: false,
    presenting: false,
    deckSettingsOpen: false,
    appSettingsOpen: false,
    shortcutHelpOpen: false,
    toasts: [],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Lets what a change started finish: renders, effects, debounces. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
}

/** One round of what a user does over and over in a long session. */
async function round(index: number) {
  const app = useApp.getState;
  const slides = app().deck!.slides;
  for (const slide of slides) act(() => app().select(slide.id));
  for (const editing of [true, false]) act(() => app().setEditing(editing));
  act(() => useApp.setState({ slideMode: "git" }));
  await settle();
  act(() => useApp.setState({ slideMode: "view" }));
  act(() => useApp.setState({ timelineOpen: true }));
  await settle();
  act(() => useApp.setState({ timelineOpen: false }));
  act(openPalette);
  await settle();
  act(closePalette);
  for (const open of [true, false]) {
    act(() => useApp.setState({ deckSettingsOpen: open }));
    act(() => useApp.setState({ appSettingsOpen: open }));
    act(() => useApp.setState({ shortcutHelpOpen: open }));
    await settle();
  }
  // Another deck, as opening one from the files does.
  act(() => useApp.setState({ deck: { ...deckFor(DECK_HTML, String(index)), id: DECKS[index % DECKS.length]! } }));
  await settle();
}

describe("a long session", () => {
  it("holds as many listeners, observers and timers after many rounds as after one", async () => {
    const listeners = countListeners();
    try {
      render(
        <>
          <App />
          <Tooltips />
        </>,
      );
      await settle();
      await round(0);
      await settle();
      const after1 = holdings(listeners);
      for (let i = 1; i <= 5; i++) await round(i);
      await settle();
      expect(holdings(listeners)).toEqual(after1);
      // And the window is still all there.
      expect(document.body.textContent).not.toMatch(/went wrong/i);
    } finally {
      listeners.stop();
    }
  }, 60_000);

  it("takes away every listener the window added once it is gone", async () => {
    const listeners = countListeners();
    try {
      // React listens on the document once, for good, as the first root mounts.
      render(<div />).unmount();
      const before = listeners.now();
      const { unmount } = render(
        <>
          <App />
          <Tooltips />
        </>,
      );
      await settle();
      await round(0);
      unmount();
      await settle();
      expect(listeners.now()).toEqual(before);
    } finally {
      listeners.stop();
    }
  }, 30_000);
});
