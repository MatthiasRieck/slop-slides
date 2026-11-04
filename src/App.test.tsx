import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The panels have their own tests; here only the layout matters.
vi.mock("./components/Home", () => ({ Home: () => <div data-testid="stub-home" /> }));
vi.mock("./components/TopBar", () => ({ TopBar: () => <div data-testid="stub-top-bar" /> }));
vi.mock("./components/DeckSettings", () => ({ DeckSettings: () => <div data-testid="stub-settings" /> }));
vi.mock("./components/DeckToolbar", () => ({ DeckToolbar: () => <div data-testid="stub-deck-toolbar" /> }));
vi.mock("./components/SlideRail", () => ({ SlideRail: () => <div data-testid="stub-rail" /> }));
vi.mock("./components/Stage", () => ({ Stage: () => <div data-testid="stub-stage" /> }));
vi.mock("./components/Sidebar", () => ({ Sidebar: () => <div data-testid="stub-sidebar-tabs" /> }));
vi.mock("./components/FileViewer", () => ({ FileViewer: () => <div data-testid="stub-viewer" /> }));
vi.mock("./components/Presenter", () => ({ Presenter: () => <div data-testid="stub-presenter" /> }));

type DragDrop = { payload: DragDropPayload };
let dragDrop: ((event: DragDrop) => void) | null = null;
const unlistenDragDrop = vi.fn();
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: (event: DragDrop) => void) => {
      dragDrop = handler;
      return unlistenDragDrop;
    },
  }),
}));
vi.mock("./components/CodeView", () => ({
  CodeView: ({ active }: { active: boolean }) => <div data-testid="stub-code" data-active={String(active)} />,
}));

import { invoke } from "@tauri-apps/api/core";
import { App } from "./App";
import { catchDrops, type DragDropPayload } from "./lib/drop";
import { useApp } from "./store";
import { DECK_HTML, deckFor } from "./test/fixtures";

const WORKSPACE = { path: "/decks", name: "decks" };

beforeEach(() => {
  useApp.setState({
    workspace: null,
    openedFile: null,
    deck: null,
    view: "slides",
    slideMode: "view",
    sidebarOpen: true,
    railOpen: true,
    presenting: false,
    error: null,
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
    expect(["home", "rail", "stage", "code"].map(shown)).toEqual([false, false, false, false]);
  });

  it("shows the editor for an open deck", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML) });
    render(<App />);
    expect(["top-bar", "rail", "stage", "sidebar-tabs"].map(shown)).toEqual([true, true, true, true]);
    expect(["home", "viewer"].map(shown)).toEqual([false, false]);
  });

  it("shows the settings in the place of the slide in Settings mode", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML), slideMode: "settings" });
    render(<App />);
    expect(screen.getByTestId("stub-settings")).toBeTruthy();
    expect(screen.queryByTestId("stub-stage")).toBeNull();
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

describe("files dropped on the window", () => {
  const openDroppedDecks = vi.fn(async () => {});
  beforeEach(() => {
    dragDrop = null;
    unlistenDragDrop.mockReset();
    openDroppedDecks.mockClear();
    useApp.setState({ openDroppedDecks });
  });

  it("open the decks among the files nothing where they landed took", async () => {
    const stop = catchDrops((paths) => paths.filter((p) => !p.endsWith(".png")));
    try {
      render(<App />);
      await vi.waitFor(() => expect(dragDrop).not.toBeNull());
      const paths = ["/tmp/a.png", "/talks/q3/deck.html"];
      act(() => dragDrop!({ payload: { type: "drop", paths, position: { x: 10, y: 10 } } }));
      expect(openDroppedDecks).toHaveBeenCalledWith(["/talks/q3/deck.html"]);
      openDroppedDecks.mockClear();
      act(() => dragDrop!({ payload: { type: "drop", paths: ["/tmp/b.png"], position: { x: 10, y: 10 } } }));
      expect(openDroppedDecks).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("are listened for on the start screen too, until the app goes", async () => {
    const { unmount } = render(<App />);
    expect(shown("home")).toBe(true);
    await vi.waitFor(() => expect(dragDrop).not.toBeNull());
    unmount();
    expect(unlistenDragDrop).toHaveBeenCalled();
  });
});
