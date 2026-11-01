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
    view: "slides",
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
    expect(tabs()).toEqual(["View", "Edit", "Narration", "Notes", "Settings", "Git", "HTML"]);
    expect(selected()).toEqual(["View"]);
  });

  it.each([
    ["Edit", "edit"],
    ["Narration", "narration"],
    ["Settings", "settings"],
    ["HTML", "code"],
  ])("switches to %s and back to View", (name, mode) => {
    render(<ModeTabs />);
    fireEvent.click(tab(name));
    expect(deckMode(useApp.getState())).toBe(mode);
    expect(selected()).toEqual([name]);
    fireEvent.click(tab("View"));
    expect(deckMode(useApp.getState())).toBe("view");
    expect(selected()).toEqual(["View"]);
  });

  it("leaves edit mode when switching to another mode", () => {
    render(<ModeTabs />);
    fireEvent.click(tab("Edit"));
    fireEvent.click(tab("Narration"));
    expect(useApp.getState()).toMatchObject({ editing: false, slideMode: "narration" });
  });

  it("cannot edit a locked slide, and says why", () => {
    useApp.setState({ deck: deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`)) });
    render(<ModeTabs />);
    expect(tab("Edit").disabled).toBe(true);
    expect(tab("Edit").title).toContain("locked");
    expect(tab("Narration").disabled).toBe(false);
  });

  it("has only View, Settings, Git and HTML for a deck without slides", () => {
    useApp.setState({ deck: { ...deckFor(DECK_HTML), slides: [] }, selected: null });
    render(<ModeTabs />);
    const enabled = screen.getAllByRole("tab").filter((t) => !(t as HTMLButtonElement).disabled);
    expect(enabled.map((t) => t.textContent)).toEqual(["View", "Settings", "Git", "HTML"]);
  });

  describe("the Git tab", () => {
    beforeEach(() => {
      useChanges.setState({ repository: null });
    });

    it("is not there for a deck outside a repository, or without git", async () => {
      inRepository(false);
      render(<ModeTabs />);
      await settled();
      expect(tabs()).toEqual(["View", "Edit", "Narration", "Notes", "Settings", "HTML"]);
    });

    it("shows up once the deck is found in a repository", async () => {
      render(<ModeTabs />);
      expect(tabs()).not.toContain("Git");
      await settled();
      expect(tabs()).toContain("Git");
    });

    it("shows up on coming back to the window after a git init", async () => {
      inRepository(false);
      render(<ModeTabs />);
      await settled();
      inRepository(true);
      await act(async () => {
        fireEvent.focus(window);
      });
      expect(tabs()).toContain("Git");
    });

    it("shows up after a git init by the agent", async () => {
      useApp.setState({ running: true });
      inRepository(false);
      render(<ModeTabs />);
      await settled();
      inRepository(true);
      await act(async () => useApp.setState({ running: false }));
      expect(tabs()).toContain("Git");
    });

    it("closes Git mode when the repository goes away", async () => {
      inRepository(true);
      render(<ModeTabs />);
      await settled();
      fireEvent.click(tab("Git"));
      expect(deckMode(useApp.getState())).toBe("git");
      inRepository(false);
      await act(async () => {
        fireEvent.focus(window);
      });
      expect(deckMode(useApp.getState())).toBe("view");
      expect(tabs()).not.toContain("Git");
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

  it("marks a slide that has narration", () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({
      deck: { ...deck, slides: deck.slides.map((s) => (s.id === "intro" ? { ...s, narration: "Hello." } : s)) },
    });
    render(<ModeTabs />);
    expect(screen.queryByTestId("has-narration")).not.toBeNull();
    expect(tab("Narration").title).toBe("Show this slide's narration");
  });

  it("shows no narration mark on a slide without narration", () => {
    render(<ModeTabs />);
    expect(screen.queryByTestId("has-narration")).toBeNull();
    expect(tab("Narration").title).toBe("Write narration for this slide");
  });

  it("shows an unsaved-changes dot on the HTML tab", () => {
    useApp.setState({ codeDirty: true });
    render(<ModeTabs />);
    expect(tab("HTML").querySelector('[title="Unsaved changes"]')).not.toBeNull();
  });

  it("explains the HTML tab with the deck's file name", () => {
    render(<ModeTabs />);
    expect(tab("HTML").title).toContain("deck.html");
  });
});
