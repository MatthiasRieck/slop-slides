import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ask, invoke, open as openDialog, revealItemInDir, save } from "../test/tauri";
import { TopBar } from "./TopBar";

const WORKSPACE = { path: "/decks", name: "decks" };
const OPENED = { path: "talk/deck.html", absolute: "/decks/talk/deck.html", kind: "deck" as const };

/** The open file's path and title, the button that opens its menu. */
const fileButton = () => document.querySelector<HTMLButtonElement>("header button[aria-haspopup=menu][title]")!;
const crumbsEl = () => document.querySelector<HTMLElement>("[data-breadcrumbs]")!;
const openFileMenu = () => fireEvent.click(fileButton());

beforeEach(() => {
  invoke.mockReset();
  save.mockReset();
  openDialog.mockReset();
  revealItemInDir.mockReset();
  ask.mockReset();
  useApp.setState({
    workspace: WORKSPACE,
    openedFile: OPENED,
    deck: deckFor(DECK_HTML),
    editing: false,
    slideMode: "view",
    sidebarOpen: true,
    railOpen: true,
    codeDirty: false,
    presenting: false,
    toasts: [],
    imageExport: null,
  });
});

describe("slide rail toggle", () => {
  it("hides and shows the slide rail", () => {
    render(<TopBar />);
    const hide = screen.getByRole("button", { name: "Hide slides" });
    expect(hide.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(hide);
    expect(useApp.getState().railOpen).toBe(false);
    const show = screen.getByRole("button", { name: "Show slides" });
    expect(show.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(show);
    expect(useApp.getState().railOpen).toBe(true);
  });
});

describe("undo and redo", () => {
  it("step through the deck's history, naming the change, and are off while the agent works", () => {
    const undo = vi.fn().mockResolvedValue(undefined);
    const redo = vi.fn().mockResolvedValue(undefined);
    const { undo: realUndo, redo: realRedo } = useApp.getState();
    const entry = (label: string, source: HistoryEntry["source"]): HistoryEntry => ({
      id: label,
      label,
      source,
      time: 0,
    });
    useApp.setState({ undo, redo, history: { undo: null, redo: null, current: "v1" } });
    try {
      render(<TopBar />);
      const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button("Undo").disabled).toBe(true);
      expect(button("Redo").disabled).toBe(true);
      expect(button("Undo").title).toBe("Nothing to undo");

      act(() =>
        useApp.setState({
          history: { undo: entry("Bigger title", "chat"), redo: entry("Move slides", "rail"), current: "v2" },
        }),
      );
      expect(button("Undo").title).toBe("Undo chat: “Bigger title” (Ctrl+Z)");
      expect(button("Redo").title).toBe("Redo “Move slides” (Ctrl+Shift+Z)");
      fireEvent.click(button("Undo"));
      fireEvent.click(button("Redo"));
      expect([undo, redo].map((f) => f.mock.calls.length)).toEqual([1, 1]);

      act(() => useApp.setState({ running: true }));
      expect(button("Undo").disabled).toBe(true);
      expect(button("Undo").title).toBe("Undo chat: “Bigger title”, once the agent is done");
    } finally {
      useApp.setState({ undo: realUndo, redo: realRedo, history: null, running: false });
    }
  });
});

describe("sidebar toggle", () => {
  it("shows the closed sidebar from the bar, and leaves hiding the open one to the sidebar", () => {
    useApp.setState({ sidebarOpen: false });
    render(<TopBar />);
    const show = screen.getByRole("button", { name: "Show sidebar" });
    expect(show.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(show);
    expect(useApp.getState().sidebarOpen).toBe(true);
    expect(screen.queryByRole("button", { name: /sidebar/ })).toBeNull();
  });
});

describe("chat button", () => {
  it("opens the chat in the sidebar, and hides the sidebar when the chat is showing", () => {
    useApp.setState({ sidebarOpen: false, sidebarTab: "files" });
    render(<TopBar />);
    const show = screen.getByRole("button", { name: "Show chat" });
    expect(show.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(show);
    expect(useApp.getState()).toMatchObject({ sidebarOpen: true, sidebarTab: "chat" });
    const hide = screen.getByRole("button", { name: "Hide chat" });
    expect(hide.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(hide);
    expect(useApp.getState().sidebarOpen).toBe(false);
  });

  it("switches an open sidebar from the files to the chat", () => {
    useApp.setState({ sidebarOpen: true, sidebarTab: "files" });
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Show chat" }));
    expect(useApp.getState()).toMatchObject({ sidebarOpen: true, sidebarTab: "chat" });
  });

  it("is not there without a deck", () => {
    useApp.setState({ deck: null });
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: /chat/ })).toBeNull();
  });
});

describe("workspace bar", () => {
  it("opens a menu from the file's path to open the settings, close it or show it in the file manager", () => {
    render(<TopBar />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(fileButton().getAttribute("aria-expanded")).toBe("false");
    openFileMenu();
    expect(fileButton().getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getAllByRole("menuitem").map((el) => el.firstElementChild?.nextElementSibling?.firstChild?.textContent),
    ).toEqual(["Settings", "Close deck.html", "Show in folder", "Open folder…", "Close decks"]);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("works its menu from the keyboard: the arrows go through it and Escape gives the focus back", () => {
    render(<TopBar />);
    fileButton().focus();
    fireEvent.keyDown(fileButton(), { key: "Enter" });
    openFileMenu();
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: "End" });
    expect(document.activeElement).toBe(items.at(-1));
    fireEvent.keyDown(items.at(-1)!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(fileButton());
  });

  it("switches the deck to Settings mode from the file's menu and closes the menu", () => {
    render(<TopBar />);
    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Settings/ }));
    expect(useApp.getState().slideMode).toBe("settings");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("has no settings in the menu of a file that is not a deck", () => {
    useApp.setState({
      deck: null,
      openedFile: { path: "site/index.html", absolute: "/decks/site/index.html", kind: "webpage" },
    });
    render(<TopBar />);
    openFileMenu();
    expect(screen.queryByRole("menuitem", { name: /^Settings/ })).toBeNull();
  });

  it("reveals the deck file in the file manager and closes the menu", () => {
    render(<TopBar />);
    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Show in folder" }));
    expect(revealItemInDir).toHaveBeenCalledWith("/decks/talk/deck.html");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the open deck, back to the workspace with nothing open", async () => {
    render(<TopBar />);
    openFileMenu();
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Close deck.html" })));
    expect(useApp.getState().deck).toBeNull();
    expect(useApp.getState().openedFile).toBeNull();
    expect(useApp.getState().workspace).toEqual(WORKSPACE);
    expect(invoke).not.toHaveBeenCalledWith("close_workspace");
  });

  it("offers the folder's menu with no file open: show it, open another, or close it", async () => {
    useApp.setState({ deck: null, openedFile: null });
    render(<TopBar />);
    openFileMenu();
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Show in folder",
      "Open folder…Work on the decks of another folder",
      "Close decksBack to the start screen",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Show in folder" }));
    expect(revealItemInDir).toHaveBeenCalledWith("/decks");
  });

  it("closes the folder, back to the start screen", async () => {
    render(<TopBar />);
    openFileMenu();
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /^Close decks/ })));
    expect(invoke).toHaveBeenCalledWith("close_workspace");
    expect(useApp.getState()).toMatchObject({ workspace: null, deck: null, openedFile: null, chatKey: null });
  });

  it("opens another folder from the menu, closing this one first", async () => {
    openDialog.mockResolvedValue("/other");
    invoke.mockImplementation(async (command: string, args?: { path?: string }) =>
      command === "open_workspace" ? { path: args?.path, name: "other" } : undefined,
    );
    render(<TopBar />);
    openFileMenu();
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /^Open folder/ })));
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(invoke).toHaveBeenCalledWith("close_workspace");
    expect(useApp.getState().workspace).toEqual({ path: "/other", name: "other" });
    expect(useApp.getState().deck).toBeNull();
  });

  it("stays in the folder while the agent works and the user does not stop it", async () => {
    useApp.setState({ chatKey: OPENED.absolute, running: true });
    ask.mockResolvedValue(false);
    render(<TopBar />);
    openFileMenu();
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /^Close decks/ })));
    expect(ask).toHaveBeenCalledWith(
      "The agent is still working in the chat of deck.html. Stop it to go on?",
      expect.objectContaining({ okLabel: "Stop the agent" }),
    );
    expect(invoke).not.toHaveBeenCalledWith("close_workspace");
    expect(useApp.getState().workspace).toEqual(WORKSPACE);
    useApp.setState({ running: false, chatKey: null });
  });

  it("closes an open page that is not a deck", async () => {
    useApp.setState({
      deck: null,
      openedFile: { path: "site/index.html", absolute: "/decks/site/index.html", kind: "webpage" },
    });
    render(<TopBar />);
    openFileMenu();
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Close index.html" })));
    expect(useApp.getState().openedFile).toBeNull();
    expect(useApp.getState().workspace).toEqual(WORKSPACE);
  });

  it("keeps the deck open when unsaved HTML edits are not discarded", async () => {
    useApp.setState({ codeDirty: true });
    ask.mockResolvedValue(false);
    render(<TopBar />);
    openFileMenu();
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Close deck.html" })));
    expect(ask).toHaveBeenCalled();
    expect(useApp.getState().deck).not.toBeNull();
    expect(useApp.getState().openedFile).toEqual(OPENED);
  });

  it("renders nothing without a workspace", () => {
    useApp.setState({ workspace: null });
    const { container } = render(<TopBar />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the open page's path and no deck tools when it is not a deck", () => {
    useApp.setState({
      deck: null,
      openedFile: { path: "site/index.html", absolute: "/decks/site/index.html", kind: "webpage" },
      sidebarOpen: false,
    });
    render(<TopBar />);
    expect(crumbsEl().textContent).toBe("decks/site/index.html");
    expect(screen.queryByRole("button", { name: /Present/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide slides" })).toBeNull();
    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Show in folder" }));
    expect(revealItemInDir).toHaveBeenCalledWith("/decks/site/index.html");
    expect(screen.getByRole("button", { name: "Show sidebar" })).toBeTruthy();
  });
});

describe("layout", () => {
  const order = () =>
    Array.from(document.querySelectorAll("header [role=tablist], header button:not([role=tab])")).map(
      (el) => el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.textContent,
    );

  it("puts the rail, the file's menu and undo / redo first, then the modes and chat, the deck's actions and the sidebar", () => {
    useApp.setState({ lint: [], sidebarTab: "files", sidebarOpen: false });
    render(<TopBar />);
    expect(order()).toEqual([
      "Hide slides",
      "talk/deck.html",
      "Undo",
      "Redo",
      "Mode",
      "Show chat",
      "Export",
      "Present",
      "More ways to present",
      "Show sidebar",
    ]);
  });

  it("shows the deck's title under its path, both in the file's menu button", () => {
    render(<TopBar />);
    const title = document.querySelector<HTMLElement>("[data-deck-title]")!;
    expect(title.textContent).toBe(useApp.getState().deck!.title);
    expect(crumbsEl().className).toContain("text-2xs");
    expect(crumbsEl().compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fileButton().contains(title) && fileButton().contains(crumbsEl())).toBe(true);
  });

  it("shows only the path, at full size, for a file that is not a deck", () => {
    useApp.setState({
      deck: null,
      openedFile: { path: "site/index.html", absolute: "/decks/site/index.html", kind: "webpage" },
    });
    render(<TopBar />);
    expect(document.querySelector("[data-deck-title]")).toBeNull();
    expect(crumbsEl().className).toContain("text-sm");
  });

  it("shows export as an icon and leaves lint to the row under the slide", () => {
    useApp.setState({ lint: [] });
    render(<TopBar />);
    expect(screen.getByRole("button", { name: "Export" }).textContent).toBe("");
    expect(screen.queryByRole("button", { name: "Lint OK" })).toBeNull();
  });

  it("sets the chat button off from the mode tabs with a vertical separator", () => {
    render(<TopBar />);
    const separator = screen.getByRole("separator");
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator.previousElementSibling?.getAttribute("role")).toBe("tablist");
    expect(separator.nextElementSibling?.getAttribute("aria-label")).toMatch(/chat/);
  });

  it("leaves the tools of each mode to the row below", () => {
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: "Find and replace" })).toBeNull();
    expect(document.querySelector("header input")).toBeNull();
  });

  it("has no modes or deck actions without a deck", () => {
    useApp.setState({ deck: null });
    render(<TopBar />);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: /Export/ })).toBeNull();
    expect(screen.queryByText(/Lint/)).toBeNull();
  });
});

describe("breadcrumbs", () => {
  const crumbs = () =>
    Array.from(crumbsEl().querySelectorAll(":scope > span > span:last-child")).map((el) => el.textContent);

  it("goes from the workspace folder to the open file", () => {
    render(<TopBar />);
    expect(crumbs()).toEqual(["decks", "talk", "deck.html"]);
    expect(screen.getByText("deck.html").getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("decks").getAttribute("aria-current")).toBeNull();
  });

  it("shows a file at the workspace root", () => {
    useApp.setState({ deck: null, openedFile: { path: "notes.md", absolute: "/decks/notes.md", kind: "file" } });
    render(<TopBar />);
    expect(crumbs()).toEqual(["decks", "notes.md"]);
  });

  it("shows only the workspace when no file is open", () => {
    useApp.setState({ deck: null, openedFile: null });
    render(<TopBar />);
    expect(crumbs()).toEqual(["decks"]);
    expect(screen.getByText("decks").getAttribute("aria-current")).toBe("page");
    // The folder's own menu: to open another folder, or close this one.
    expect(fileButton().title).toBe("/decks");
  });
});
