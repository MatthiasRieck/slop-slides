import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The mode tabs, counted: each render of the bar renders them.
vi.mock("./ModeTabs", async (original) => {
  const actual = await original<typeof import("./ModeTabs")>();
  return { ...actual, ModeTabs: vi.fn(actual.ModeTabs) };
});

import type { HistoryEntry } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ask, invoke, open as openDialog, revealItemInDir, save } from "../test/tauri";
import { answerUnsaved } from "../test/unsaved";
import { ModeTabs } from "./ModeTabs";
import { TopBar } from "./TopBar";

const WORKSPACE = { path: "/decks", name: "decks" };
const OPENED = { path: "talk/deck.html", absolute: "/decks/talk/deck.html", kind: "deck" as const };

/** The open file's path and title, the button that opens its menu. */
const fileButton = () => document.querySelector<HTMLButtonElement>("header button[aria-haspopup=menu][title]")!;
const crumbsEl = () => document.querySelector<HTMLElement>("[data-breadcrumbs]")!;
const openFileMenu = () => fireEvent.click(fileButton());

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
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
    sidebarTab: "chat",
    railOpen: true,
    codeDirty: false,
    presenting: false,
    running: false,
    messages: [],
    toasts: [],
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

  it("says its shortcut in the tooltip, not in its name", () => {
    render(<TopBar />);
    expect(screen.getByRole("button", { name: "Hide slides" }).title).toBe("Hide slides (Ctrl+Shift+\\)");
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

  it("holds the sidebar's settings and shortcut buttons while the sidebar is hidden", () => {
    useApp.setState({ sidebarOpen: false, appSettingsOpen: false, shortcutHelpOpen: false });
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "App settings…" }));
    expect(useApp.getState().appSettingsOpen).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(useApp.getState().shortcutHelpOpen).toBe(true);
    act(() => useApp.setState({ sidebarOpen: true, appSettingsOpen: false, shortcutHelpOpen: false }));
    expect(screen.queryByRole("button", { name: "App settings…" })).toBeNull();
  });
});

describe("the sidebar toggle's mark", () => {
  const assistant = (status: "pending" | "resolved") => ({
    id: "a1",
    role: "assistant" as const,
    parts: [
      {
        kind: "approval" as const,
        status,
        approval: {
          id: "p1",
          title: "Run a command",
          reason: null,
          details: "ls",
          acceptLabel: "Allow once",
          decisions: ["accept" as const],
        },
      },
    ],
    status: "streaming" as const,
    thinking: false,
    error: null,
    costUsd: null,
    durationMs: null,
    createdAt: 1,
  });
  const mark = () => document.querySelector<HTMLElement>("header [data-attention]");

  it("is a spinner while the agent works with the chat out of sight", () => {
    useApp.setState({ sidebarOpen: false, running: true });
    render(<TopBar />);
    expect(mark()?.dataset.attention).toBe("working");
    expect(mark()?.getAttribute("aria-label")).toBe("The agent is working");
    expect(screen.getByRole("button", { name: "Show sidebar" }).title).toBe(
      "Show sidebar: the agent is working (Ctrl+\\)",
    );
    act(() => useApp.setState({ running: false }));
    expect(mark()).toBeNull();
    expect(screen.getByRole("button", { name: "Show sidebar" }).title).toBe("Show sidebar (Ctrl+\\)");
  });

  it("is a warning dot while the agent waits for an approval", () => {
    useApp.setState({ sidebarOpen: false, running: true, messages: [assistant("pending")] });
    render(<TopBar />);
    expect(mark()?.dataset.attention).toBe("approval");
    expect(mark()?.getAttribute("aria-label")).toBe("The agent is waiting for your approval");
    act(() => useApp.setState({ messages: [assistant("resolved")] }));
    expect(mark()?.dataset.attention).toBe("working");
  });

  it("has no chat button of its own: the chat is a tab of the sidebar", () => {
    useApp.setState({ sidebarOpen: false, sidebarTab: "files" });
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: /chat/i })).toBeNull();
    // The mode tabs stand alone, with nothing set off from them.
    expect(screen.queryByRole("separator")).toBeNull();
  });
});

describe("earlier versions", () => {
  const entry = (id: string, label: string, source: HistoryEntry["source"], ago: number): HistoryEntry => ({
    id,
    label,
    source,
    time: Date.now() - ago,
  });

  it("lists the deck's versions, newest first, with who made them and when, and goes back to one", async () => {
    const restoreVersion = vi.fn(async () => true);
    const undo = vi.fn(async () => {});
    useApp.setState({ restoreVersion, undo, history: { undo: null, redo: null, current: "v3" } });
    invoke.mockImplementation(async (command: string) =>
      command === "deck_versions"
        ? {
            entries: [
              entry("v4", "Undone edit", "edit", 60_000),
              entry("v3", "Bigger title", "chat", 5 * 60_000),
              entry("v2", "Move slides", "rail", 10 * 60_000),
              entry("v1", "Opened", "open", 20 * 60_000),
            ],
            current: "v3",
          }
        : undefined,
    );
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Earlier versions" }));
    const list = await screen.findByRole("menu", { name: "Versions" });
    const rows = Array.from(list.querySelectorAll("[role=menuitem]"));
    expect(rows.map((row) => row.textContent)).toEqual([
      "Undone editYou · 1m ago · Undone",
      "Bigger titleAgent · 5m ago · Now",
      "Move slidesYou · 10m ago",
      "OpenedOpened · 20m ago",
    ]);
    expect(list.textContent).toContain("Today");
    expect((rows[1] as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(rows[2]!));
    expect(restoreVersion).toHaveBeenCalledWith("v2");
    const toast = useApp.getState().toasts.at(-1)!;
    expect(toast.text).toBe("Back to the version after “Move slides”");
    toast.action!.run();
    expect(undo).toHaveBeenCalled();
  });

  it("are not offered while the agent works", () => {
    useApp.setState({ running: true });
    render(<TopBar />);
    const button = screen.getByRole("button", { name: "Earlier versions" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Go back to an earlier version, once the agent is done");
  });
});

describe("workspace bar", () => {
  const labels = () =>
    screen.getAllByRole("menuitem").map((el) => el.firstElementChild?.nextElementSibling?.firstChild?.textContent);

  it("opens a menu from the file's path, with what is done to the deck and to the folder under a label each", () => {
    render(<TopBar />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(fileButton().getAttribute("aria-expanded")).toBe("false");
    openFileMenu();
    expect(fileButton().getAttribute("aria-expanded")).toBe("true");
    expect(labels()).toEqual([
      "New deck…",
      "Open deck…",
      "Open folder…",
      "Import PowerPoint…",
      "New window",
      "Rename…",
      "Deck settings…",
      "Duplicate deck",
      "Reveal in sidebar",
      "Show in folder",
      "Move deck to Trash…",
      "Close deck",
      "Close folder",
    ]);
    const menu = screen.getByRole("menu");
    expect(Array.from(menu.querySelectorAll("span.uppercase")).map((label) => label.textContent)).toEqual([
      "Deck",
      "Folder",
    ]);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps room for the file's menu button, so the title does not vanish in a narrow window", () => {
    render(<TopBar />);
    expect(fileButton().parentElement!.className).toContain("min-w-12");
    // It is what gives room first, before the undo buttons and the mode tabs.
    expect(fileButton().parentElement!.className).toContain("shrink");
    expect(fileButton().parentElement!.parentElement!.className).toContain("overflow-hidden");
  });

  it("shows where the open file is, in the Files tab", () => {
    useApp.setState({ sidebarOpen: false, sidebarTab: "chat" });
    render(<TopBar />);
    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Reveal in sidebar/ }));
    expect(useApp.getState()).toMatchObject({ sidebarOpen: true, sidebarTab: "files" });
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

  it("opens the deck's settings from the file's menu, as a dialog over the deck's mode", () => {
    useApp.setState({ editing: true, deckSettingsOpen: false });
    render(<TopBar />);
    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Deck settings…/ }));
    expect(useApp.getState()).toMatchObject({ deckSettingsOpen: true, editing: true });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("starts a new deck in the folder from the menu, in a dialog", () => {
    useApp.setState({ newDeckOpen: false, templates: [] });
    render(<TopBar />);
    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^New deck…/ }));
    const dialog = screen.getByRole("dialog", { name: "New deck" });
    expect(dialog.textContent).toContain("It goes in a new folder in decks.");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "What is the deck about?" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(useApp.getState().newDeckOpen).toBe(false);
  });

  it("opens a deck, and a new window, from the menu", async () => {
    openDialog.mockResolvedValue(null);
    invoke.mockResolvedValue(undefined);
    render(<TopBar />);
    openFileMenu();
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /^Open deck…/ })));
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ title: "Open a deck" }));
    openFileMenu();
    expect(screen.getByRole("menuitem", { name: /^New window/ }).textContent).toContain("Ctrl+N");
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /^New window/ })));
    expect(invoke).toHaveBeenCalledWith("new_window");
  });

  it("imports a PowerPoint file from the menu", async () => {
    const importPptx = vi.fn(async () => null);
    useApp.setState({ importPptx });
    openDialog.mockResolvedValue("/Users/me/q3.pptx");
    render(<TopBar />);
    openFileMenu();
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /^Import PowerPoint…/ })));
    expect(importPptx).toHaveBeenCalledWith("/Users/me/q3.pptx");
  });

  it("duplicates the deck, and moves it to the trash, from the menu", async () => {
    const duplicateDeck = vi.fn(async () => "/decks/talk-copy/deck.html");
    const trashDeck = vi.fn(async () => true);
    useApp.setState({ duplicateDeck, trashDeck });
    render(<TopBar />);
    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Duplicate deck/ }));
    expect(duplicateDeck).toHaveBeenCalledWith("/decks/talk/deck.html", { open: true });
    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Move deck to Trash…/ }));
    expect(trashDeck).toHaveBeenCalledWith("/decks/talk/deck.html", "Talk");
  });

  describe("renaming the deck", () => {
    const titleField = () => screen.queryByRole("textbox", { name: "Deck title" }) as HTMLInputElement | null;
    const startRenaming = () => {
      render(<TopBar />);
      openFileMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
      return titleField()!;
    };

    beforeEach(() => {
      invoke.mockImplementation(async (command: string, args?: { title?: string }) =>
        command === "rename_deck" ? { ...deckFor(DECK_HTML), title: args?.title } : undefined,
      );
    });

    it("turns the title into a field, holding the title, selected", () => {
      const field = startRenaming();
      expect(screen.queryByRole("menu")).toBeNull();
      expect(field.value).toBe("Talk");
      expect(document.activeElement).toBe(field);
      expect([field.selectionStart, field.selectionEnd]).toEqual([0, 4]);
      // The folder stays above it.
      expect(crumbsEl().textContent).toBe("decks/talk");
    });

    it("starts on a double-click of the title too", () => {
      render(<TopBar />);
      expect(fileButton().title).toBe("Talk: double-click to rename, click for the deck's menu");
      fireEvent.doubleClick(fileButton());
      expect(titleField()!.value).toBe("Talk");
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("takes the new title on Enter", async () => {
      const field = startRenaming();
      fireEvent.change(field, { target: { value: "  Board update " } });
      await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
      expect(invoke).toHaveBeenCalledWith("rename_deck", { id: "/decks/talk/deck.html", title: "Board update" });
      expect(titleField()).toBeNull();
      expect(document.querySelector("[data-deck-title]")!.textContent).toBe("Board update");
    });

    it("leaves the title as it was on Escape, which closes nothing else", () => {
      const field = startRenaming();
      fireEvent.change(field, { target: { value: "Other" } });
      // The field takes the key: `fireEvent` gives false for a key that was handled.
      expect(fireEvent.keyDown(field, { key: "Escape" })).toBe(false);
      expect(titleField()).toBeNull();
      expect(invoke).not.toHaveBeenCalledWith("rename_deck", expect.anything());
      expect(document.querySelector("[data-deck-title]")!.textContent).toBe("Talk");
    });

    it("takes no empty title: Enter says so and the field stays", async () => {
      const field = startRenaming();
      fireEvent.change(field, { target: { value: "   " } });
      await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
      expect(titleField()).not.toBeNull();
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.title).toBe("A deck needs a title");
      expect(invoke).not.toHaveBeenCalledWith("rename_deck", expect.anything());
      // Typing again takes the complaint away.
      fireEvent.change(field, { target: { value: "B" } });
      expect(field.getAttribute("aria-invalid")).toBeNull();
    });

    it("commits on leaving the field, and puts an emptied title back", async () => {
      let field = startRenaming();
      fireEvent.change(field, { target: { value: "Left" } });
      await act(async () => fireEvent.blur(field));
      expect(invoke).toHaveBeenCalledWith("rename_deck", { id: "/decks/talk/deck.html", title: "Left" });
      expect(titleField()).toBeNull();

      invoke.mockClear();
      openFileMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
      field = titleField()!;
      fireEvent.change(field, { target: { value: "" } });
      await act(async () => fireEvent.blur(field));
      expect(invoke).not.toHaveBeenCalledWith("rename_deck", expect.anything());
      expect(titleField()).toBeNull();
      expect(document.querySelector("[data-deck-title]")!.textContent).toBe("Left");
    });

    it("keeps the old title, and says why, when the deck cannot be renamed", async () => {
      invoke.mockImplementation(async (command: string) => {
        if (command === "rename_deck") throw "the deck file is read-only";
      });
      const field = startRenaming();
      fireEvent.change(field, { target: { value: "Other" } });
      await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
      expect(useApp.getState().toasts.map((toast) => toast.text)).toEqual(["the deck file is read-only"]);
      expect(titleField()!.value).toBe("Talk");
    });

    it("is over when another file opens", () => {
      startRenaming();
      act(() =>
        useApp.setState({
          openedFile: { path: "other/deck.html", absolute: "/decks/other/deck.html", kind: "deck" },
          deck: { ...deckFor(DECK_HTML), id: "/decks/other/deck.html", title: "Other" },
        }),
      );
      expect(titleField()).toBeNull();
      expect(document.querySelector("[data-deck-title]")!.textContent).toBe("Other");
    });

    it("is not offered for a file that is not a deck", () => {
      useApp.setState({
        deck: null,
        openedFile: { path: "site/index.html", absolute: "/decks/site/index.html", kind: "webpage" },
      });
      render(<TopBar />);
      openFileMenu();
      expect(screen.queryByRole("menuitem", { name: "Rename…" })).toBeNull();
      expect(labels().slice(5)).toEqual(["Reveal in sidebar", "Show in folder", "Close file", "Close folder"]);
      // A double-click does not rename it either.
      openFileMenu();
      fireEvent.doubleClick(fileButton());
      expect(titleField()).toBeNull();
    });
  });

  it("has no settings in the menu of a file that is not a deck", () => {
    useApp.setState({
      deck: null,
      openedFile: { path: "site/index.html", absolute: "/decks/site/index.html", kind: "webpage" },
    });
    render(<TopBar />);
    openFileMenu();
    expect(screen.queryByRole("menuitem", { name: /settings/i })).toBeNull();
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
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /^Close deck/ })));
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
      "New deck…In a new folder in decks",
      "Open deck…Ctrl+O",
      "Open folder…Ctrl+Shift+O",
      "Import PowerPoint…As a new deck in decks",
      "New windowCtrl+N",
      "Browse filesThe folder's files, in the sidebar",
      "Show in folder",
      "Close folderBack to the start screen",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Show in folder" }));
    expect(revealItemInDir).toHaveBeenCalledWith("/decks");
  });

  it("closes the folder, back to the start screen", async () => {
    render(<TopBar />);
    openFileMenu();
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /^Close folder/ })));
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
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /^Close folder/ })));
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
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /^Close file/ })));
    expect(useApp.getState().openedFile).toBeNull();
    expect(useApp.getState().workspace).toEqual(WORKSPACE);
  });

  it("keeps the deck open when the user stays for unsaved HTML edits", async () => {
    useApp.setState({ codeDirty: true });
    render(<TopBar />);
    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Close deck/ }));
    await act(async () => void (await answerUnsaved("cancel")));
    expect(ask).not.toHaveBeenCalled();
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

  it("puts the rail, the file's menu and undo / redo first, then the modes, the deck's actions and the sidebar", () => {
    useApp.setState({ lint: [], sidebarTab: "files", sidebarOpen: false });
    render(<TopBar />);
    // What the deck's actions are called is theirs to say (DeckActions); where they go is the bar's.
    expect(order()).toEqual([
      "Hide slides",
      "Talk: double-click to rename, click for the deck's menu",
      "Undo",
      "Earlier versions",
      "Redo",
      "Mode",
      expect.stringMatching(/^Export/),
      expect.stringMatching(/^Present/),
      expect.stringMatching(/present/i),
      "App settings…",
      "Keyboard shortcuts",
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

  it("shows export and leaves lint to the row under the slide", () => {
    useApp.setState({ lint: [] });
    render(<TopBar />);
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lint OK" })).toBeNull();
  });

  it("leaves the tools of each mode to the row below", () => {
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: "Find and replace" })).toBeNull();
    // No field either, until the deck is being renamed.
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

  it("goes from the workspace folder to the deck's own folder, without the deck.html every deck ends in", () => {
    render(<TopBar />);
    expect(crumbs()).toEqual(["decks", "talk"]);
    expect(screen.getByText("talk").getAttribute("aria-current")).toBe("page");
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

describe("renders", () => {
  const barRenders = () => vi.mocked(ModeTabs).mock.calls.length;

  it("renders as its width crosses where its room changes, not at every pixel of a drag", () => {
    let report: (width: number) => void = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          report = (width) =>
            callback(
              [{ contentRect: { width, height: 56 } } as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            );
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      render(<TopBar />);
      act(() => report(1100));
      const before = barRenders();
      for (let width = 1099; width >= 900; width--) act(() => report(width));
      expect(barRenders()).toBe(before);
      act(() => report(899));
      expect(barRenders()).toBe(before + 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows the sidebar's buttons as it closes without rendering the rest of the bar", () => {
    render(<TopBar />);
    const before = barRenders();
    act(() => useApp.setState({ sidebarOpen: false }));
    expect(screen.getByRole("button", { name: "Show sidebar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "App settings…" })).toBeTruthy();
    act(() => useApp.setState({ sidebarOpen: true }));
    expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();
    expect(barRenders()).toBe(before);
  });
});
