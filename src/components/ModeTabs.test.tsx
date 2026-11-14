import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChanges } from "../changesStore";
import { deckMode, useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ModeTabs } from "./ModeTabs";

const tab = (name: string) => screen.getByRole("tab", { name }) as HTMLButtonElement;
const tabs = () => screen.getAllByRole("tab").map((t) => t.textContent);
const repositoryChecks = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "deck_in_repository").length;
const inRepository = (found: boolean) => {
  vi.mocked(invoke).mockImplementation(async () => found);
};
const settled = () => act(async () => {});
const selected = () =>
  screen
    .getAllByRole("tab")
    .filter((t) => t.getAttribute("aria-selected") === "true")
    .map((t) => t.textContent);

beforeEach(() => {
  localStorage.clear();
  useApp.setState({
    deck: deckFor(DECK_HTML),
    selected: "intro",
    editing: false,
    slideMode: "view",
    codeDirty: false,
    running: false,
  });
  vi.mocked(invoke).mockReset();
  inRepository(true);
  useChanges.setState({ repository: useApp.getState().deck?.id ?? null });
});

describe("ModeTabs", () => {
  it("lists the modes, with View selected", () => {
    render(<ModeTabs />);
    expect(tabs()).toEqual(["View", "Edit", "Changes"]);
    expect(selected()).toEqual(["View"]);
  });

  it("moves between the modes with the arrow keys, Tab stopping at the selected one", () => {
    render(<ModeTabs />);
    expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    tab("View").focus();
    fireEvent.keyDown(tab("View"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Edit"));
    fireEvent.keyDown(tab("Edit"), { key: "End" });
    expect(document.activeElement).toBe(tab("Changes"));
    fireEvent.keyDown(tab("Changes"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("View"));
    // Moving the focus changes no mode; a click (Enter, Space) does.
    expect(selected()).toEqual(["View"]);
    fireEvent.click(tab("Edit"));
    expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("leaves the focus where it is when a mode is pressed, for the keys that work there", () => {
    render(<ModeTabs />);
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    tab("Edit").dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it("leaves narration, notes and the HTML to the sidebar's tabs", () => {
    render(<ModeTabs />);
    for (const name of ["Narration", "Notes", "HTML"]) expect(screen.queryByRole("tab", { name })).toBeNull();
  });

  it.each([
    ["Edit", "edit"],
    ["Changes", "git"],
  ])("switches to %s and back to View", (name, mode) => {
    render(<ModeTabs />);
    fireEvent.click(tab(name));
    expect(deckMode(useApp.getState())).toBe(mode);
    expect(selected()).toEqual([name]);
    fireEvent.click(tab("View"));
    expect(deckMode(useApp.getState())).toBe("view");
    expect(selected()).toEqual(["View"]);
  });

  it("shows each mode as an icon over its label, highlighting the selected one", () => {
    render(<ModeTabs />);
    fireEvent.click(tab("Changes"));
    for (const t of screen.getAllByRole("tab")) {
      expect(t.querySelector("svg")).not.toBeNull();
      expect(t.className).toContain("flex-col");
      expect(t.classList.contains("text-primary")).toBe(t.textContent === "Changes");
      // Filled too, so the selected mode differs by more than the color of its text.
      expect(t.classList.contains("bg-primary/10")).toBe(t.textContent === "Changes");
    }
  });

  it("leaves edit mode when switching to another mode", () => {
    render(<ModeTabs />);
    fireEvent.click(tab("Edit"));
    fireEvent.click(tab("Changes"));
    expect(useApp.getState()).toMatchObject({ editing: false, slideMode: "git" });
  });

  it("has no Play tab: the deck plays on the timeline, in View and in Edit", () => {
    render(<ModeTabs />);
    expect(screen.queryByRole("tab", { name: "Play" })).toBeNull();
  });

  it("says in one short line what each mode is for, and the keys that go to it", () => {
    render(<ModeTabs />);
    expect(screen.getAllByRole("tab").map((t) => t.title)).toEqual([
      "View: present, play and comment (Ctrl+1)",
      "Edit: change slides, their order and timing (Ctrl+2)",
      "Changes: what changed since the last saved version (Git) (Ctrl+3)",
    ]);
    for (const t of screen.getAllByRole("tab")) expect(t.title.length).toBeLessThan(70);
  });

  it("enters Edit on a locked slide too, and says the slide is locked", () => {
    useApp.setState({ deck: deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`)) });
    render(<ModeTabs />);
    expect(tab("Edit").disabled).toBe(false);
    expect(tab("Edit").title).toBe("Edit: this slide is locked; unlock it to change it (Ctrl+2)");
    fireEvent.click(tab("Edit"));
    expect(deckMode(useApp.getState())).toBe("edit");
  });

  it("has no Settings tab: the deck's settings are a dialog", () => {
    render(<ModeTabs />);
    expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
  });

  it("shows only the icons, each still named, where the bar is short of room", () => {
    render(<ModeTabs compact />);
    const view = tab("View");
    expect(view.textContent).toBe("");
    expect(view.getAttribute("aria-label")).toBe("View");
    expect(view.title).toContain("View:");
  });

  it("has Edit for a deck without slides, to add the first one in", () => {
    useApp.setState({ deck: { ...deckFor(DECK_HTML), slides: [] }, selected: null });
    render(<ModeTabs />);
    const enabled = screen.getAllByRole("tab").filter((t) => !(t as HTMLButtonElement).disabled);
    expect(enabled.map((t) => t.textContent)).toEqual(["View", "Edit", "Changes"]);
  });

  describe("the Changes tab", () => {
    beforeEach(() => {
      useChanges.setState({ repository: null });
    });

    it("is not there for a deck outside a repository, or without git", async () => {
      inRepository(false);
      render(<ModeTabs />);
      await settled();
      expect(tabs()).toEqual(["View", "Edit"]);
    });

    it("shows up once the deck is found in a repository", async () => {
      render(<ModeTabs />);
      expect(tabs()).not.toContain("Changes");
      await settled();
      expect(tabs()).toContain("Changes");
    });

    it("shows up on coming back to the window after a git init", async () => {
      inRepository(false);
      render(<ModeTabs />);
      await settled();
      inRepository(true);
      await act(async () => {
        fireEvent.focus(window);
      });
      expect(tabs()).toContain("Changes");
    });

    it("shows up after a git init by the agent", async () => {
      useApp.setState({ running: true });
      inRepository(false);
      render(<ModeTabs />);
      await settled();
      inRepository(true);
      await act(async () => useApp.setState({ running: false }));
      expect(tabs()).toContain("Changes");
    });

    it("closes Changes mode when the repository goes away", async () => {
      inRepository(true);
      render(<ModeTabs />);
      await settled();
      fireEvent.click(tab("Changes"));
      expect(deckMode(useApp.getState())).toBe("git");
      inRepository(false);
      await act(async () => {
        fireEvent.focus(window);
      });
      expect(deckMode(useApp.getState())).toBe("view");
      expect(tabs()).not.toContain("Changes");
    });

    it("stops looking when closed", async () => {
      const { unmount } = render(<ModeTabs />);
      await settled();
      unmount();
      const before = repositoryChecks();
      fireEvent.focus(window);
      expect(repositoryChecks()).toBe(before);
    });
  });
});
