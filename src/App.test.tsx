import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { preloadLazyParts } from "./components/lazy";
import { openSettings, showError, useApp } from "./store";
import { lastError } from "./store/errors";
import { DECK_HTML, deckFor } from "./test/fixtures";
import { appWindow, ask, requestClose } from "./test/tauri";
import { settle } from "./test/ui";

const WORKSPACE = { path: "/decks", name: "decks" };

// The parts loaded on first use are there, as they are in the app once it has been idle.
beforeAll(preloadLazyParts);

beforeEach(() => {
  useApp.setState({
    booted: true,
    workspace: null,
    openedFile: null,
    deck: null,
    slideMode: "view",
    sidebarOpen: true,
    railOpen: true,
    presenting: false,
    toasts: [],
    settingsSection: null,
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

  it("lays the workbench out in resizable panels, with a handle between each two", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML) });
    const { unmount } = render(<App />);
    // The window's (the deck beside the sidebar), and the deck's own (the rail beside the stage).
    expect(document.querySelectorAll("[data-slot=resizable-panel-group]")).toHaveLength(2);
    const panels = () => Array.from(document.querySelectorAll("[data-slot=resizable-panel]")).map((panel) => panel.id);
    expect(panels()).toEqual(["main", "rail", "stage", "sidebar"]);
    const handles = () => screen.getAllByRole("separator");
    expect(handles()).toHaveLength(2);
    for (const handle of handles()) expect(handle.getAttribute("data-slot")).toBe("resizable-handle");
    unmount();
    // Without a deck there is no rail to drag.
    useApp.setState({ deck: null });
    render(<App />);
    expect(panels()).toEqual(["main", "stage", "sidebar"]);
    expect(handles()).toHaveLength(1);
  });

  it("overlays the presenter", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML), presenting: true });
    render(<App />);
    expect(shown("presenter")).toBe(true);
    expect(shown("stage")).toBe(true);
  });

  it("opens the app's settings on their keyboard shortcuts with ?, on the start screen and in any mode", () => {
    const settings = () => screen.queryByRole("dialog", { name: "Settings" });
    const onShortcuts = () => screen.queryByRole("tab", { name: "Keyboard shortcuts", selected: true }) !== null;
    const { unmount } = render(<App />);
    expect(settings()).toBeNull();
    fireEvent.keyDown(document.body, { key: "?" });
    expect(onShortcuts()).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(settings()).toBeNull();
    unmount();
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML) });
    render(<App />);
    fireEvent.keyDown(document.body, { key: "?" });
    expect(onShortcuts()).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(settings()).toBeNull();
    act(() => useApp.getState().setMode("git"));
    fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
    expect(onShortcuts()).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    // Without a deck too.
    act(() => useApp.setState({ deck: null }));
    fireEvent.keyDown(document.body, { key: "?" });
    expect(onShortcuts()).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(settings()).toBeNull();
  });

  it("shows the app's settings over whatever is open, on the section asked for", () => {
    const settings = () => screen.queryByRole("dialog", { name: "Settings" });
    render(<App />);
    act(() => openSettings());
    expect(settings()).toBeTruthy();
    expect(screen.getByRole("tab", { name: "General", selected: true })).toBeTruthy();
    act(() => useApp.getState().closeSettings());
    expect(settings()).toBeNull();
    act(() => useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML) }));
    act(() => openSettings("providers"));
    expect(screen.getByRole("tab", { name: "Providers", selected: true })).toBeTruthy();
    // Pressing beside the dialog leaves it open.
    const backdrop = document.querySelector("[data-slot=dialog-overlay]")!;
    fireEvent.pointerDown(backdrop, { pointerType: "mouse", button: 0 });
    fireEvent.click(backdrop);
    expect(settings()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(settings()).toBeNull();
  });

  it("opens the settings on Ctrl+, in an open folder", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML) });
    render(<App />);
    fireEvent.keyDown(document.body, { key: ",", ctrlKey: true });
    expect(screen.getByRole("tab", { name: "General", selected: true })).toBeTruthy();
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
    // The question is the app's own dialog: save, don't save, or stay.
    const closing = requestClose();
    const dialog = await screen.findByRole("alertdialog", { name: "Save the changes to deck.html?" });
    expect(dialog.textContent).toContain("Without saving, they are lost.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await closing).toBe(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    act(() => useApp.setState({ codeDirty: false }));
  });

  it("shows errors in a dismissible toast", async () => {
    render(<App />);
    const shownText = () => screen.queryByText("deck not found: x", { selector: "[data-slot=toast-title]" });
    expect(shownText()).toBeNull();
    act(() => showError("deck not found: x"));
    // The toaster shows it a moment later, among the notifications, as something that interrupts.
    await settle();
    const toast = shownText()!.closest("[data-slot=toast]")!;
    expect(toast.getAttribute("role")).toBe("alertdialog");
    expect(screen.getByRole("region", { name: "Notifications" }).contains(toast)).toBe(true);
    // (An error is read out as it shows; its toast is in a screen reader's reach once the focus is in the toasts.)
    const dismiss = toast.querySelector<HTMLElement>("[data-slot=toast-close]")!;
    expect(dismiss.getAttribute("aria-label")).toBe("Dismiss");
    fireEvent.click(dismiss);
    expect(lastError(useApp.getState())).toBeNull();
    await settle();
    expect(shownText()).toBeNull();
  });

  it("mounts one toaster, whatever is open", () => {
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML) });
    render(<App />);
    expect(document.querySelectorAll("[data-slot=toast-viewport]")).toHaveLength(1);
  });

  it("shows neither the start screen nor a folder until it knows what it starts with", () => {
    useApp.setState({ booted: false });
    render(<App />);
    expect(["home", "top-bar"].map(shown)).toEqual([false, false]);
    // A folder that was waiting shows as soon as it is open, without the start screen before it.
    act(() => useApp.setState({ workspace: WORKSPACE }));
    expect(["home", "top-bar"].map(shown)).toEqual([false, true]);
  });

  it("shows the start screen once it knows that no folder was waiting", () => {
    useApp.setState({ booted: false });
    render(<App />);
    act(() => useApp.setState({ booted: true }));
    expect(shown("home")).toBe(true);
  });
});

describe("lint status", () => {
  it("lints the deck as it opens, and again once a change to its file has settled", async () => {
    const refreshLint = vi.fn(async () => {});
    useApp.setState({ workspace: WORKSPACE, deck: deckFor(DECK_HTML), lint: null, lintError: null, refreshLint });
    render(<App />);
    expect(refreshLint).toHaveBeenCalledTimes(1);
    // The same deck read again is no change.
    act(() => useApp.setState({ deck: deckFor(DECK_HTML), lint: [] }));
    expect(refreshLint).toHaveBeenCalledTimes(1);
    act(() => useApp.setState({ deck: deckFor(DECK_HTML, "2") }));
    expect(refreshLint).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(refreshLint).toHaveBeenCalledTimes(2));
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
