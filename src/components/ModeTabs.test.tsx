import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import { deckMode, useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ModeTabs } from "./ModeTabs";

const tab = (name: string) => screen.getByRole("tab", { name }) as HTMLButtonElement;
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
  });
});

describe("ModeTabs", () => {
  it("lists the modes, with View selected", () => {
    render(<ModeTabs />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "View",
      "Edit",
      "Narration",
      "Notes",
      "HTML",
    ]);
    expect(selected()).toEqual(["View"]);
  });

  it.each([
    ["Edit", "edit"],
    ["Narration", "narration"],
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

  it("has only View and HTML for a deck without slides", () => {
    useApp.setState({ deck: { ...deckFor(DECK_HTML), slides: [] }, selected: null });
    render(<ModeTabs />);
    const enabled = screen.getAllByRole("tab").filter((t) => !(t as HTMLButtonElement).disabled);
    expect(enabled.map((t) => t.textContent)).toEqual(["View", "HTML"]);
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
