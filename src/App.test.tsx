import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
// The panels have their own tests; here only the layout matters.
vi.mock("./components/Home", () => ({ Home: () => <div data-testid="stub-home" /> }));
vi.mock("./components/TopBar", () => ({ TopBar: () => <div data-testid="stub-top-bar" /> }));
vi.mock("./components/SlideRail", () => ({ SlideRail: () => <div data-testid="stub-rail" /> }));
vi.mock("./components/Stage", () => ({ Stage: () => <div data-testid="stub-stage" /> }));
vi.mock("./components/Sidebar", () => ({ Sidebar: () => <div data-testid="stub-sidebar-tabs" /> }));
vi.mock("./components/FileViewer", () => ({ FileViewer: () => <div data-testid="stub-viewer" /> }));
vi.mock("./components/Presenter", () => ({ Presenter: () => <div data-testid="stub-presenter" /> }));
vi.mock("./components/CodeView", () => ({
  CodeView: ({ active }: { active: boolean }) => <div data-testid="stub-code" data-active={String(active)} />,
}));

import { App } from "./App";
import { useApp } from "./store";
import { DECK_HTML, deckFor } from "./test/fixtures";

const WORKSPACE = { path: "/decks", name: "decks" };

beforeEach(() => {
  useApp.setState({ workspace: null, openedFile: null, deck: null, view: "slides", sidebarOpen: true, railOpen: true, presenting: false, error: null });
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
    expect(["home", "rail", "stage", "code"].map(shown)).toEqual([false, false, false, false]);
  });

  it("shows the editor for an open deck", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML) });
    render(<App />);
    expect(["top-bar", "rail", "stage", "sidebar-tabs"].map(shown)).toEqual([true, true, true, true]);
    expect(["home", "viewer"].map(shown)).toEqual([false, false]);
  });

  it("keeps the HTML view mounted while showing slides, so unsaved edits survive", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML) });
    render(<App />);
    expect(screen.getByTestId("stub-code").dataset.active).toBe("false");
    act(() => useApp.getState().setView("code"));
    expect(screen.getByTestId("stub-code").dataset.active).toBe("true");
    expect(shown("stage")).toBe(false);
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

  it("shows errors in a dismissible toast", () => {
    render(<App />);
    expect(screen.queryByText("deck not found: x")).toBeNull();
    act(() => useApp.getState().setError("deck not found: x"));
    expect(screen.getByText("deck not found: x")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(useApp.getState().error).toBeNull();
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
});
