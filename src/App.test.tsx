import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The panels have their own tests; here only the layout matters.
vi.mock("./components/Home", () => ({ Home: () => <div data-testid="stub-home" /> }));
vi.mock("./components/TopBar", () => ({ TopBar: () => <div data-testid="stub-top-bar" /> }));
vi.mock("./components/DeckSettings", () => ({ DeckSettings: () => <div data-testid="stub-settings" /> }));
vi.mock("./components/NarrationTimeline", () => ({ NarrationTimeline: () => <div data-testid="stub-timeline" /> }));
vi.mock("./components/SlideRail", () => ({ SlideRail: () => <div data-testid="stub-rail" /> }));
vi.mock("./components/Stage", () => ({ Stage: () => <div data-testid="stub-stage" /> }));
vi.mock("./components/Sidebar", () => ({ Sidebar: () => <div data-testid="stub-sidebar-tabs" /> }));
vi.mock("./components/FileViewer", () => ({ FileViewer: () => <div data-testid="stub-viewer" /> }));
vi.mock("./components/Presenter", () => ({ Presenter: () => <div data-testid="stub-presenter" /> }));

import { invoke } from "@tauri-apps/api/core";
import { App, SIDEBAR_MAX_SIZE } from "./App";
import { openShortcutHelp, showError, useApp } from "./store";
import { lastError } from "./store/errors";
import { DECK_HTML, deckFor } from "./test/fixtures";
import { appWindow, ask, requestClose } from "./test/tauri";

const WORKSPACE = { path: "/decks", name: "decks" };

beforeEach(() => {
  useApp.setState({
    workspace: null,
    openedFile: null,
    deck: null,
    slideMode: "view",
    sidebarOpen: true,
    railOpen: true,
    presenting: false,
    toasts: [],
  });
});

// Stub ids are prefixed: react-resizable-panels sets data-testid to each panel's id.
const shown = (id: string) => screen.queryByTestId(`stub-${id}`) !== null;

describe("App", () => {
  it("shows the start screen until a folder is open", () => {
    render(<App />);
    expect(shown("home")).toBe(true);
    expect(shown("top-bar")).toBe(false);
  });

  it("shows the file viewer and the sidebar in a folder without an open deck", () => {
    useApp.setState({ workspace: WORKSPACE });
    render(<App />);
    expect(["top-bar", "viewer", "sidebar-tabs"].map(shown)).toEqual([true, true, true]);
    expect(["home", "rail", "stage"].map(shown)).toEqual([false, false, false]);
  });

  it("shows the editor for an open deck", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML) });
    render(<App />);
    expect(["top-bar", "rail", "stage", "sidebar-tabs"].map(shown)).toEqual([true, true, true, true]);
    expect(["home", "viewer"].map(shown)).toEqual([false, false]);
  });

  it("runs the sidebar the full height of the window, with the top bar only over the main area", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML) });
    render(<App />);
    const main = screen.getByTestId("main");
    const sidebar = screen.getByTestId("sidebar");
    expect(main.contains(screen.getByTestId("stub-top-bar"))).toBe(true);
    expect(main.contains(screen.getByTestId("rail"))).toBe(true);
    expect(main.contains(sidebar)).toBe(false);
    expect(sidebar.contains(screen.getByTestId("stub-sidebar-tabs"))).toBe(true);
    expect(main.parentElement).toBe(sidebar.parentElement);
  });

  it("lets the sidebar widen to two thirds of the window, not a fixed few pixels", () => {
    expect(SIDEBAR_MAX_SIZE).toBe("67%");
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML) });
    render(<App />);
    expect(screen.getByTestId("sidebar")).toBeTruthy();
  });

  it("shows the settings in the place of the slide in Settings mode", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML), slideMode: "settings" });
    render(<App />);
    expect(screen.getByTestId("stub-settings")).toBeTruthy();
    expect(screen.queryByTestId("stub-stage")).toBeNull();
  });

  it("shows the timeline under the slide in View and in Edit while it is open, whatever the sidebar shows", () => {
    useApp.setState({
      workspace: WORKSPACE,
      deck: deckFor(DECK_HTML),
      sidebarTabs: ["chat"],
      sidebarTab: "chat",
      timelineOpen: false,
    });
    render(<App />);
    expect(shown("timeline")).toBe(false);
    // The Narration tab does not bring it.
    act(() => useApp.getState().setSidebarTab("narration"));
    expect(["stage", "timeline"].map(shown)).toEqual([true, false]);
    act(() => useApp.getState().setTimelineOpen(true));
    expect(["stage", "timeline"].map(shown)).toEqual([true, true]);
    // It stays with the sidebar on another tab, or hidden, and from View to Edit and back.
    act(() => useApp.getState().setSidebarTab("chat"));
    expect(shown("timeline")).toBe(true);
    act(() => useApp.getState().setSidebarOpen(false));
    expect(shown("timeline")).toBe(true);
    act(() => useApp.getState().setMode("edit"));
    expect(shown("timeline")).toBe(true);
    // The settings and the changes have the place to themselves.
    for (const mode of ["settings", "git"] as const) {
      act(() => useApp.getState().setMode(mode));
      expect(shown("timeline")).toBe(false);
    }
    act(() => useApp.getState().setMode("view"));
    expect(shown("timeline")).toBe(true);
    act(() => useApp.getState().setTimelineOpen(false));
    expect(["stage", "timeline"].map(shown)).toEqual([true, false]);
  });

  // Closed panels stay mounted (collapsed), so reopening them does not reload their contents.
  const hidden = (panel: string) => screen.getByTestId(panel).getAttribute("aria-hidden") === "true";

  it("collapses and reopens the slide rail, keeping it mounted", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML) });
    render(<App />);
    expect(hidden("rail")).toBe(false);
    act(() => useApp.getState().setRailOpen(false));
    expect(hidden("rail")).toBe(true);
    expect(screen.getByTestId("rail").hasAttribute("inert")).toBe(true);
    expect(["rail", "stage", "sidebar-tabs"].map(shown)).toEqual([true, true, true]);
    act(() => useApp.getState().setRailOpen(true));
    expect(hidden("rail")).toBe(false);
    expect(useApp.getState().railOpen).toBe(true);
  });

  it("collapses and reopens the sidebar, keeping it mounted", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML) });
    render(<App />);
    act(() => useApp.getState().setSidebarOpen(false));
    expect(hidden("sidebar")).toBe(true);
    expect(["rail", "stage", "sidebar-tabs"].map(shown)).toEqual([true, true, true]);
    act(() => useApp.getState().setSidebarOpen(true));
    expect(hidden("sidebar")).toBe(false);
  });

  it("lays the maximized sidebar over the whole window, keeping it in its place in the layout", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML), sidebarMaximized: false });
    render(<App />);
    const body = screen.getByTestId("sidebar-body");
    expect(body.className).not.toContain("fixed");
    act(() => useApp.getState().setSidebarMaximized(true));
    expect(screen.getByTestId("sidebar-body")).toBe(body);
    expect(body.className).toContain("fixed inset-0");
    expect(screen.getByTestId("sidebar").contains(body)).toBe(true);
    expect(shown("stage")).toBe(true);
  });

  it("starts with a closed panel collapsed", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML), railOpen: false });
    render(<App />);
    expect(hidden("rail")).toBe(true);
    expect(useApp.getState().railOpen).toBe(false);
  });

  it("overlays the presenter", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML), presenting: true });
    render(<App />);
    expect(shown("presenter")).toBe(true);
    expect(shown("stage")).toBe(true);
  });

  it("offers the keyboard shortcuts in any mode of an open workspace, not on the start screen", () => {
    const help = () => screen.queryByRole("dialog", { name: "Keyboard shortcuts" });
    const { unmount } = render(<App />);
    fireEvent.keyDown(document.body, { key: "?" });
    expect(help()).toBeNull();
    unmount();
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML) });
    render(<App />);
    fireEvent.keyDown(document.body, { key: "?" });
    expect(help()).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(help()).toBeNull();
    act(() => useApp.getState().setMode("git"));
    fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
    expect(help()).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    // Without a deck too.
    act(() => useApp.setState({ deck: null }));
    act(() => openShortcutHelp());
    expect(help()).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
  });

  it("names its window after what is open, and asks before the window closes over unsaved edits", async () => {
    render(<App />);
    expect(appWindow.setTitle).toHaveBeenLastCalledWith("SlopSlide");
    act(() => useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML) }));
    expect(appWindow.setTitle).toHaveBeenLastCalledWith("Talk — decks");
    await act(async () => {});
    expect(await requestClose()).toBe(true);
    act(() => useApp.setState({ codeDirty: true }));
    ask.mockResolvedValue(false);
    expect(await requestClose()).toBe(false);
    ask.mockReset();
    act(() => useApp.setState({ codeDirty: false }));
  });

  it("shows errors in a dismissible toast", () => {
    render(<App />);
    expect(screen.queryByText("deck not found: x")).toBeNull();
    act(() => showError("deck not found: x"));
    expect(screen.getByRole("alert").textContent).toContain("deck not found: x");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(lastError(useApp.getState())).toBeNull();
    expect(screen.queryByText("deck not found: x")).toBeNull();
  });
});

describe("lint status", () => {
  it("re-lints the open deck whenever the deck file changes", async () => {
    const refreshLint = vi.fn(async () => {});
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML), refreshLint });
    render(<App />);
    expect(refreshLint).toHaveBeenCalledTimes(1);
    act(() => useApp.setState({ deck: deckFor(DECK_HTML) }));
    expect(refreshLint).toHaveBeenCalledTimes(1);
    act(() => useApp.setState({ deck: deckFor(DECK_HTML, "2") }));
    expect(refreshLint).toHaveBeenCalledTimes(2);
  });

  it("does not lint without an open deck", () => {
    const refreshLint = vi.fn(async () => {});
    useApp.setState({ refreshLint });
    render(<App />);
    expect(refreshLint).not.toHaveBeenCalled();
  });

  it("opens another window with Ctrl+N", () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "n", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "n" });
    expect(invoke).not.toHaveBeenCalledWith("new_window");
    vi.mocked(invoke).mockResolvedValue(undefined);
    const event = new KeyboardEvent("keydown", { key: "n", ctrlKey: true, cancelable: true });
    act(() => void window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith("new_window");
  });
});
