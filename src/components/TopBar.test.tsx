import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ask, invoke, open as openDialog, revealItemInDir, save } from "../test/tauri";
import { TopBar } from "./TopBar";

const WORKSPACE = { path: "/decks", name: "decks" };
const OPENED = { path: "talk/deck.html", absolute: "/decks/talk/deck.html", kind: "deck" as const };

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
    view: "slides",
    editing: false,
    slideMode: "view",
    sidebarOpen: true,
    railOpen: true,
    codeDirty: false,
    presenting: false,
    error: null,
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
      expect(button("Undo").title).toBe("Undo chat: “Bigger title” (⌘Z)");
      expect(button("Redo").title).toBe("Redo “Move slides” (⇧⌘Z)");
      fireEvent.click(button("Undo"));
      fireEvent.click(button("Redo"));
      expect([undo, redo].map((f) => f.mock.calls.length)).toEqual([1, 1]);

      act(() => useApp.setState({ running: true }));
      expect(button("Undo").disabled).toBe(true);
      expect(button("Undo").title).toContain("once the agent is done");
    } finally {
      useApp.setState({ undo: realUndo, redo: realRedo, history: null, running: false });
    }
  });
});

describe("sidebar toggle", () => {
  it("hides and shows the sidebar", () => {
    render(<TopBar />);
    const hide = screen.getByRole("button", { name: "Hide sidebar" });
    expect(hide.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(hide);
    expect(useApp.getState().sidebarOpen).toBe(false);
    const show = screen.getByRole("button", { name: "Show sidebar" });
    expect(show.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(show);
    expect(useApp.getState().sidebarOpen).toBe(true);
  });
});

describe("workspace bar", () => {
  it("reveals the deck file in the file manager", () => {
    render(<TopBar />);
    fireEvent.click(screen.getByTitle("Show in folder"));
    expect(revealItemInDir).toHaveBeenCalledWith("/decks/talk/deck.html");
  });

  it("closes the open deck, back to the workspace with nothing open", async () => {
    render(<TopBar />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Close deck.html" })));
    expect(useApp.getState().deck).toBeNull();
    expect(useApp.getState().openedFile).toBeNull();
    expect(useApp.getState().workspace).toEqual(WORKSPACE);
    expect(invoke).not.toHaveBeenCalledWith("close_workspace");
  });

  it("closes an open page that is not a deck", async () => {
    useApp.setState({
      deck: null,
      openedFile: { path: "site/index.html", absolute: "/decks/site/index.html", kind: "webpage" },
    });
    render(<TopBar />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Close index.html" })));
    expect(useApp.getState().openedFile).toBeNull();
    expect(useApp.getState().workspace).toEqual(WORKSPACE);
  });

  it("keeps the deck open when unsaved HTML edits are not discarded", async () => {
    useApp.setState({ codeDirty: true });
    ask.mockResolvedValue(false);
    render(<TopBar />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Close deck.html" })));
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
    });
    render(<TopBar />);
    expect(screen.getByRole("navigation", { name: "Breadcrumbs" }).textContent).toBe("decks/site/index.html");
    expect(screen.queryByRole("button", { name: /Present/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide slides" })).toBeNull();
    fireEvent.click(screen.getByTitle("Show in folder"));
    expect(revealItemInDir).toHaveBeenCalledWith("/decks/site/index.html");
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toBeTruthy();
  });
});

describe("layout", () => {
  const order = () =>
    Array.from(document.querySelectorAll("header nav, header [role=tablist], header button:not([role=tab])")).map(
      (el) => el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.textContent,
    );

  it("puts the rail and the file (close, path, reveal) first, then the modes, undo / redo, lint, the deck's actions and the sidebar", () => {
    useApp.setState({ lint: [] });
    render(<TopBar />);
    expect(order()).toEqual([
      "Hide slides",
      "Close deck.html",
      "Breadcrumbs",
      "Show in folder",
      "Mode",
      "Undo",
      "Redo",
      "Lint OK",
      "Export",
      "Present",
      "Hide sidebar",
    ]);
  });

  it("shows the deck's title under its path", () => {
    render(<TopBar />);
    const title = screen.getByRole("heading", { level: 1 });
    expect(title.textContent).toBe(useApp.getState().deck!.title);
    const nav = screen.getByRole("navigation", { name: "Breadcrumbs" });
    expect(nav.className).toContain("text-2xs");
    expect(nav.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows only the path, at full size, for a file that is not a deck", () => {
    useApp.setState({
      deck: null,
      openedFile: { path: "site/index.html", absolute: "/decks/site/index.html", kind: "webpage" },
    });
    render(<TopBar />);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Breadcrumbs" }).className).toContain("text-sm");
  });

  it("shows export as an icon and lint as a checkmark", () => {
    useApp.setState({ lint: [] });
    render(<TopBar />);
    expect(screen.getByRole("button", { name: "Export" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "Lint OK" }).textContent).toBe("");
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
    Array.from(screen.getByRole("navigation", { name: "Breadcrumbs" }).querySelectorAll("span > span:last-child")).map(
      (el) => el.textContent,
    );

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
    expect(screen.queryByTitle("Show in folder")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Close/ })).toBeNull();
  });
});
