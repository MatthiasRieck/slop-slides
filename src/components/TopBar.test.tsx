import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ask, invoke, open as openDialog, revealItemInDir, save } from "../test/tauri";
import { settle, tooltipOf } from "../test/ui";
import { answerUnsaved } from "../test/unsaved";
import { TopBar } from "./TopBar";

const WORKSPACE = { path: "/decks", name: "decks" };
const OPENED = { path: "talk/deck.html", absolute: "/decks/talk/deck.html", kind: "deck" as const };

const crumbsEl = () => document.querySelector<HTMLElement>("[data-breadcrumbs]")!;
/** The open file's path and title, the button that opens its menu. */
const fileButton = () => crumbsEl().closest<HTMLButtonElement>("header button[aria-haspopup=menu]")!;
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
    sidebarTab: "chat",
    railOpen: true,
    codeDirty: false,
    presenting: false,
    running: false,
    messages: [],
    toasts: [],
    imageExport: null,
    settingsSection: null,
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
    expect(tooltipOf(screen.getByRole("button", { name: "Hide slides" }))).toBe("Hide slidesCtrl+Shift+\\");
  });
});

describe("undo and redo", () => {
  it("step through the deck's history, naming the change, and are off while the agent works", async () => {
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
      // Off, they still take the pointer and the focus, to say why.
      const off = (name: string) => button(name).getAttribute("aria-disabled") === "true";
      expect(off("Undo")).toBe(true);
      expect(off("Redo")).toBe(true);
      expect(tooltipOf(button("Undo"))).toBe("Nothing to undo");
      expect(tooltipOf(button("Redo"))).toBe("Nothing to redo");
      fireEvent.click(button("Undo"));
      expect(undo).not.toHaveBeenCalled();

      act(() =>
        useApp.setState({
          history: { undo: entry("Bigger title", "chat"), redo: entry("Move slides", "rail"), current: "v2" },
        }),
      );
      expect(off("Undo")).toBe(false);
      expect(tooltipOf(button("Undo"))).toBe("Undo chat: “Bigger title”Ctrl+Z");
      expect(tooltipOf(button("Redo"))).toBe("Redo “Move slides”Ctrl+Shift+Z");
      fireEvent.click(button("Undo"));
      fireEvent.click(button("Redo"));
      expect([undo, redo].map((f) => f.mock.calls.length)).toEqual([1, 1]);

      act(() => useApp.setState({ running: true }));
      expect(off("Undo")).toBe(true);
      expect(tooltipOf(button("Undo"))).toBe("Undo chat: “Bigger title”, once the agent is done");
      fireEvent.click(button("Undo"));
      expect(undo).toHaveBeenCalledOnce();
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
    // The spinner is the mark's, not a status of its own.
    expect(mark()?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(tooltipOf(screen.getByRole("button", { name: "Show sidebar" }))).toBe(
      "Show sidebar: the agent is workingCtrl+\\",
    );
    act(() => useApp.setState({ running: false }));
    expect(mark()).toBeNull();
    expect(tooltipOf(screen.getByRole("button", { name: "Show sidebar" }))).toBe("Show sidebarCtrl+\\");
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
      "Rename…",
      "Deck settings",
      "Show in folder",
      "Close deck",
      "Show in Files",
      "Open folder…",
      "Close folder",
    ]);
    const menu = screen.getByRole("menu");
    expect(
      Array.from(menu.querySelectorAll("[data-slot=dropdown-menu-label]")).map((label) => label.textContent),
    ).toEqual(["Deck", "Folder"]);
    // Each label names its group of choices.
    expect(
      within(menu)
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-labelledby")),
    ).toEqual(Array.from(menu.querySelectorAll("[data-slot=dropdown-menu-label]")).map((label) => label.id));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps room for the file's menu button, so the title does not vanish in a narrow window", () => {
    render(<TopBar />);
    expect(fileButton().parentElement!.className).toContain("min-w-24");
  });

  it("shows where the open file is, in the Files tab", () => {
    useApp.setState({ sidebarOpen: false, sidebarTab: "chat" });
    render(<TopBar />);
    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Show in Files/ }));
    expect(useApp.getState()).toMatchObject({ sidebarOpen: true, sidebarTab: "files" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("works its menu from the keyboard: the arrows go through it and Escape gives the focus back", async () => {
    const user = userEvent.setup();
    render(<TopBar />);
    fileButton().focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await settle();
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(items.at(-1));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await settle();
    expect(document.activeElement).toBe(fileButton());
  });

  it("picks a choice of its menu with Enter", async () => {
    const user = userEvent.setup();
    render(<TopBar />);
    fileButton().focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await settle();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(useApp.getState().slideMode).toBe("settings");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the deck's settings from the file's menu, remembering the mode to go back to", () => {
    useApp.setState({ editing: true });
    render(<TopBar />);
    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Deck settings/ }));
    expect(useApp.getState().slideMode).toBe("settings");
    expect(useApp.getState().settingsReturn).toBe("edit");
    expect(screen.queryByRole("menu")).toBeNull();
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
      // The path stays above it.
      expect(crumbsEl().textContent).toBe("decks/talk/deck.html");
    });

    it("keeps the focus in the field once the menu it came from is gone", async () => {
      const field = startRenaming();
      // The menu gives the focus back to its button as it closes; the button is gone, and the field keeps it.
      await settle();
      expect(titleField()).toBe(field);
      expect(document.activeElement).toBe(field);
      expect(invoke).not.toHaveBeenCalledWith("rename_deck", expect.anything());
    });

    it("keeps the focus in the field when something else had it before the menu opened", async () => {
      render(
        <>
          <textarea aria-label="Message" />
          <TopBar />
        </>,
      );
      // As where a click does not focus a button: the composer keeps the focus while the menu opens.
      const composer = screen.getByRole("textbox", { name: "Message" });
      composer.focus();
      openFileMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
      await settle();
      expect(titleField()).not.toBeNull();
      expect(document.activeElement).toBe(titleField());
      expect(invoke).not.toHaveBeenCalledWith("rename_deck", expect.anything());
    });

    it("keeps the focus in the field after an earlier popup opened from a field", async () => {
      render(
        <>
          <textarea aria-label="Message" />
          <TopBar />
        </>,
      );
      screen.getByRole("textbox", { name: "Message" }).focus();
      openFileMenu();
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await settle();
      (document.activeElement as HTMLElement).blur();
      openFileMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
      await settle();
      expect(document.activeElement).toBe(titleField());
    });

    it("still gives the focus back to the file button when the menu closes another way, also after a rename", async () => {
      render(<TopBar />);
      openFileMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
      fireEvent.keyDown(titleField()!, { key: "Escape" });
      await settle();
      const opener = fileButton();
      opener.focus();
      openFileMenu();
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await settle();
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(opener);
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
      const complaint = () => document.querySelector("[data-slot=tooltip-content]")?.textContent;
      expect(complaint()).toBe("A deck needs a title");
      expect(invoke).not.toHaveBeenCalledWith("rename_deck", expect.anything());
      // Typing again takes the complaint away.
      fireEvent.change(field, { target: { value: "B" } });
      expect(field.getAttribute("aria-invalid")).toBeNull();
      expect(complaint()).toBeUndefined();
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
      expect(labels()).toEqual(["Show in folder", "Close file", "Show in Files", "Open folder…", "Close folder"]);
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
      "Show in FilesThe folder's files, in the sidebar",
      "Show in folder",
      "Open folder…Work on the decks of another folderCtrl+O",
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

  it("puts the rail, the file's menu and undo / redo first, then the modes, the settings, the deck's actions and the sidebar", () => {
    useApp.setState({ lint: [], sidebarTab: "files", sidebarOpen: false });
    render(<TopBar />);
    // What the deck's actions are called is theirs to say (DeckActions); where they go is the bar's.
    expect(order()).toEqual([
      "Hide slides",
      expect.stringContaining("talk/deck.html"),
      "Undo",
      "Redo",
      "Mode",
      "Settings",
      expect.stringMatching(/^Export/),
      expect.stringMatching(/^Present/),
      expect.stringMatching(/present/i),
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

describe("the settings gear", () => {
  const gear = () => screen.getByRole("button", { name: "Settings" });

  it("sits immediately left of Export and opens the app's settings on General", () => {
    render(<TopBar />);
    expect(gear().nextElementSibling!.contains(screen.getByRole("button", { name: "Export" }))).toBe(true);
    expect(gear().nextElementSibling!.querySelector("button")).toBe(screen.getByRole("button", { name: "Export" }));
    expect(tooltipOf(gear())).toBe("SettingsCtrl+,");
    // A button that opens a dialog, not a toggle.
    expect(gear().hasAttribute("aria-pressed")).toBe(false);
    fireEvent.click(gear());
    expect(useApp.getState().settingsSection).toBe("general");
  });

  it("is there without a deck too, and with the sidebar open or closed", () => {
    useApp.setState({ deck: null, openedFile: null, sidebarOpen: false });
    render(<TopBar />);
    expect(gear().nextElementSibling).toBe(screen.getByRole("button", { name: "Show sidebar" }).parentElement);
    act(() => useApp.setState({ sidebarOpen: true }));
    expect(gear().nextElementSibling).toBeNull();
    fireEvent.click(gear());
    expect(useApp.getState().settingsSection).toBe("general");
  });

  it("goes with the bar when no folder is open", () => {
    useApp.setState({ workspace: null, deck: null });
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
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
    expect(tooltipOf(fileButton())).toBe("/decks");
  });

  it("says the whole path of the open file in the tooltip of its menu button", () => {
    render(<TopBar />);
    expect(tooltipOf(fileButton())).toBe("talk/deck.html");
    // One tooltip, not the browser's own beside it.
    expect(crumbsEl().hasAttribute("title")).toBe(false);
  });
});
