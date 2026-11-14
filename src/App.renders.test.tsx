import { act, render } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The workbench's parts, counted: each stub counts its renders.
const { counts, counted } = vi.hoisted(() => {
  const counts = { topBar: 0, rail: 0, stage: 0, sidebar: 0, palette: 0, home: 0 };
  /** A part that renders nothing and counts its renders under `name`. */
  const counted = (name: keyof typeof counts) => () => {
    counts[name]++;
    return null;
  };
  return { counts, counted };
});
vi.mock("./components/Home", () => ({ Home: counted("home") }));
vi.mock("./components/TopBar", () => ({ TopBar: counted("topBar") }));
vi.mock("./components/SlideRail", () => ({ SlideRail: counted("rail") }));
vi.mock("./components/Stage", () => ({ Stage: counted("stage") }));
vi.mock("./components/Sidebar", () => ({ Sidebar: counted("sidebar") }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: counted("palette") }));
vi.mock("./components/NarrationTimeline", () => ({ NarrationTimeline: () => null }));
vi.mock("./components/DeckSettings", () => ({ DeckSettings: () => null }));
vi.mock("./components/Presenter", () => ({ Presenter: () => null }));

import { App } from "./App";
import { closePalette, openPalette } from "./commands/palette";
import { preloadLazyParts } from "./components/lazy";
import { useApp } from "./store";
import { DECK_HTML, deckFor } from "./test/fixtures";

const WORKSPACE = { path: "/decks", name: "decks" };

beforeAll(preloadLazyParts);

beforeEach(() => {
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
  closePalette();
});

/** The renders of the top bar, the slide list, the stage and the sidebar while `act` runs. */
function rendersDuring(change: () => void) {
  const before = { ...counts };
  act(change);
  return {
    topBar: counts.topBar - before.topBar,
    rail: counts.rail - before.rail,
    stage: counts.stage - before.stage,
    sidebar: counts.sidebar - before.sidebar,
  };
}

const NONE = { topBar: 0, rail: 0, stage: 0, sidebar: 0 };

describe("the window's renders", () => {
  it("opens and closes the command palette without rendering the workbench", () => {
    render(<App />);
    const before = counts.palette;
    expect(rendersDuring(openPalette)).toEqual(NONE);
    expect(counts.palette).toBe(before + 1);
    expect(rendersDuring(closePalette)).toEqual(NONE);
  });

  it("shows and hides a dialog over the window without rendering the workbench", () => {
    render(<App />);
    expect(rendersDuring(() => useApp.setState({ deckSettingsOpen: true }))).toEqual(NONE);
    expect(rendersDuring(() => useApp.setState({ deckSettingsOpen: false }))).toEqual(NONE);
    expect(rendersDuring(() => useApp.setState({ presenting: true }))).toEqual(NONE);
  });

  it("opens and closes the panels beside the stage without rendering what is in them", () => {
    render(<App />);
    expect(rendersDuring(() => useApp.getState().setSidebarOpen(false))).toEqual(NONE);
    expect(rendersDuring(() => useApp.getState().setSidebarOpen(true))).toEqual(NONE);
    expect(rendersDuring(() => useApp.getState().setRailOpen(false))).toEqual(NONE);
    expect(rendersDuring(() => useApp.getState().setRailOpen(true))).toEqual(NONE);
    expect(rendersDuring(() => useApp.getState().setSidebarMaximized(true))).toEqual(NONE);
    expect(rendersDuring(() => useApp.getState().setTimelineOpen(true))).toEqual(NONE);
  });

  it("goes from View to Edit without rendering the top bar, the slide list or the sidebar from the window", () => {
    render(<App />);
    // The stage follows the mode itself (the stub does not); nothing else is rendered for it.
    expect(rendersDuring(() => useApp.getState().setMode("edit"))).toEqual(NONE);
    expect(rendersDuring(() => useApp.getState().setMode("view"))).toEqual(NONE);
  });

  it("renders nothing of the workbench from the window as the deck's content changes, and checks it again", () => {
    const lintChanged = vi.spyOn(useApp.getState(), "lintChanged");
    useApp.setState({ lintChanged });
    render(<App />);
    const checks = lintChanged.mock.calls.length;
    const edited = deckFor(DECK_HTML, "2");
    expect(rendersDuring(() => useApp.setState({ deck: edited }))).toEqual(NONE);
    expect(lintChanged.mock.calls.length).toBe(checks + 1);
  });
});
