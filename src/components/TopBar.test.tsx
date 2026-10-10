import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const save = vi.fn();
const openDialog = vi.fn();
const revealItemInDir = vi.fn();
const ask = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (...args: unknown[]) => ask(...args),
  save: (...args: unknown[]) => save(...args),
  open: (...args: unknown[]) => openDialog(...args),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: (...args: unknown[]) => revealItemInDir(...args) }));

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { TopBar } from "./TopBar";

const WORKSPACE = { path: "/decks", name: "decks" };
const OPENED = { path: "talk/deck.html", absolute: "/decks/talk/deck.html", kind: "deck" as const };

beforeEach(() => {
  invoke.mockReset();
  save.mockReset();
  openDialog.mockReset();
  revealItemInDir.mockReset();
  ask.mockReset();
  useApp.setState({ workspace: WORKSPACE, openedFile: OPENED, deck: deckFor(DECK_HTML), view: "slides", sidebarOpen: true, railOpen: true, codeDirty: false, presenting: false, error: null, imageExport: null });
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
    useApp.setState({ deck: null, openedFile: { path: "site/index.html", absolute: "/decks/site/index.html", kind: "webpage" } });
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
    useApp.setState({ deck: null, openedFile: { path: "site/index.html", absolute: "/decks/site/index.html", kind: "webpage" } });
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
    Array.from(document.querySelectorAll("header > button, header > nav")).map(
      (el) => el.getAttribute("aria-label") ?? el.getAttribute("title"),
    );

  it("puts the slide rail toggle first, then the breadcrumbs, then the file and folder actions", () => {
    render(<TopBar />);
    expect(order()).toEqual(["Hide slides", "Breadcrumbs", "Show in folder", "Close deck.html", "Hide sidebar"]);
  });

  it("leaves the deck's tools to the deck toolbar", () => {
    render(<TopBar />);
    for (const name of [/Present/, /Export/, "Slides", "HTML", "Slide size"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(document.querySelector("header input")).toBeNull();
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
