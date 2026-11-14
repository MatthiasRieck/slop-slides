import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChanges } from "../changesStore";
import { usePalette } from "../commands/palette";
import { loadRecent } from "../lib/commands";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { CommandPalette, paletteItems } from "./CommandPalette";
import { resetEditorState } from "./stage/editorState";

const DECK = deckFor(DECK_HTML);

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetEditorState();
  usePalette.setState({ open: true });
  useApp.setState({
    workspace: { path: "/decks/talk", name: "talk" },
    deck: DECK,
    selected: DECK.slides[0]!.id,
    editing: false,
    slideMode: "view",
    presenting: false,
    sidebarOpen: true,
    railOpen: true,
    overview: false,
    history: null,
  });
  useChanges.setState({ repository: null });
});

afterEach(() => {
  vi.useRealTimers();
});

const field = () => screen.getByRole("combobox", { name: "Find a command" });
const options = () => within(screen.getByRole("listbox", { name: "Commands" })).queryAllByRole("option");
const marked = () => options().find((option) => option.getAttribute("aria-selected") === "true");
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
const key = (name: string, more: KeyboardEventInit = {}) => fireEvent.keyDown(field(), { key: name, ...more });

describe("CommandPalette", () => {
  it("opens with its field focused over every command, with their menus and keys", () => {
    render(<CommandPalette />);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(document.activeElement).toBe(field());
    expect(options().length).toBeGreaterThan(50);
    const sidebar = options().find((option) => option.textContent?.includes("Sidebar"))!;
    expect(sidebar.textContent).toContain("View");
    expect(sidebar.textContent).toContain("Ctrl+\\");
    // On or off, it says which.
    expect(sidebar.textContent).toContain(", on");
  });

  it("narrows the list as the user types, by name or by menu, the best match first", () => {
    render(<CommandPalette />);
    type("zoom in");
    expect(marked()?.textContent).toContain("Zoom in");
    type("arrange group");
    expect(options()[0]!.textContent).toContain("Group");
    type("nothing like this at all");
    expect(options()).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toContain("No command matches");
  });

  it("greys out a command that cannot run now, saying why, and does not run it", () => {
    render(<CommandPalette />);
    type("changes");
    const changes = options().find((option) => option.textContent?.startsWith("Changes"))!;
    expect(changes.getAttribute("aria-disabled")).toBe("true");
    expect(changes.textContent).toContain("This deck is not kept with Git");
    fireEvent.click(changes);
    act(() => void vi.runAllTimers());
    expect(usePalette.getState().open).toBe(true);
    expect(useApp.getState().slideMode).toBe("view");
  });

  it("runs the command marked on Enter, once it has closed, and remembers it", () => {
    render(<CommandPalette />);
    type("sidebar");
    key("Enter");
    expect(usePalette.getState().open).toBe(false);
    act(() => void vi.runAllTimers());
    expect(useApp.getState().sidebarOpen).toBe(false);
    expect(loadRecent()).toEqual(["view.sidebar"]);
  });

  it("goes through the list with the arrow keys, round from the ends", () => {
    render(<CommandPalette />);
    type("zoom");
    const first = marked()!.textContent;
    key("ArrowDown");
    expect(marked()!.textContent).not.toBe(first);
    key("ArrowUp");
    expect(marked()!.textContent).toBe(first);
    key("ArrowUp");
    expect(marked()).toBe(options().at(-1));
    expect(field().getAttribute("aria-activedescendant")).toBe(marked()!.id);
  });

  it("runs a command clicked", () => {
    render(<CommandPalette />);
    type("slide list");
    fireEvent.click(options().find((option) => option.textContent?.includes("Slide list"))!);
    act(() => void vi.runAllTimers());
    expect(useApp.getState().railOpen).toBe(false);
  });

  it("lists the commands used last first, under Recent", () => {
    localStorage.setItem("slopslide.recentCommands", JSON.stringify(["present.windows"]));
    render(<CommandPalette />);
    expect(screen.getByText("Recent")).toBeTruthy();
    expect(options()[0]!.textContent).toContain("Present in windows");
  });

  it("goes to a slide by its number", () => {
    render(<CommandPalette />);
    type("2");
    expect(options()[0]!.textContent).toContain("Go to slide 2");
    key("Enter");
    act(() => void vi.runAllTimers());
    expect(useApp.getState().selected).toBe(DECK.slides[1]!.id);
    // Not past the last slide.
    expect(paletteItems(String(DECK.slides.length + 1)).some((item) => item.id === "slide.goto")).toBe(false);
  });

  it("closes on Escape and on its own keys", () => {
    const { unmount } = render(<CommandPalette />);
    key("P", { ctrlKey: true, shiftKey: true });
    expect(usePalette.getState().open).toBe(false);
    unmount();
    usePalette.setState({ open: true });
    render(<CommandPalette />);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(usePalette.getState().open).toBe(false);
  });
});
