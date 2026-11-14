import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { openLayer } from "../lib/layers";
import { type DesignChange, deckMode, useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { DeckSettings } from "./DeckSettings";

const applyStyle = vi.fn<() => Promise<DesignChange | null>>(async () => null);
const resizeSlides = vi.fn<() => Promise<DesignChange | null>>(async () => null);
const renameDeck = vi.fn(async (_title: string) => true);

beforeEach(() => {
  applyStyle.mockClear();
  resizeSlides.mockClear();
  renameDeck.mockReset().mockResolvedValue(true);
  useApp.setState({
    deck: { ...deckFor(DECK_HTML), template: "swiss" },
    running: false,
    editing: false,
    slideMode: "settings",
    settingsReturn: "view",
    templates: [{ id: "swiss", title: "Swiss Design", builtin: true, path: null, slides: ["title"] }],
    applyStyle,
    resizeSlides,
    renameDeck,
  });
});

const title = () => screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement;

describe("DeckSettings", () => {
  it("changes the slide size, for a new aspect ratio", () => {
    render(<DeckSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Square" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(resizeSlides).toHaveBeenCalledWith({ width: 1080, height: 1080, unit: "px" });
  });

  it("changes the deck's style", () => {
    render(<DeckSettings />);
    const style = screen.getByRole("button", { name: "Swiss Design style" });
    expect(style.getAttribute("aria-current")).toBe("true");
    fireEvent.click(style);
    expect(applyStyle).toHaveBeenCalledWith("swiss");
  });

  it("is called the deck's settings, apart from the app's", () => {
    render(<DeckSettings />);
    expect(screen.getByRole("region", { name: "Deck settings" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Deck settings");
  });

  describe("the way back", () => {
    it("is the Done button, to the mode the settings opened from", () => {
      useApp.setState({ slideMode: "view", editing: true });
      act(() => useApp.getState().openDeckSettings());
      expect(deckMode(useApp.getState())).toBe("settings");
      render(<DeckSettings />);
      const done = screen.getByRole("button", { name: "Done" });
      expect(done.title).toBe("Back to Edit (Esc)");
      fireEvent.click(done);
      expect(deckMode(useApp.getState())).toBe("edit");
    });

    it("is Escape too", () => {
      render(<DeckSettings />);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(deckMode(useApp.getState())).toBe("view");
    });

    it("leaves Escape to a field that has its own use for it", () => {
      render(<DeckSettings />);
      const field = screen.getByRole("spinbutton", { name: "Width" });
      field.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
      fireEvent.keyDown(field, { key: "Escape" });
      expect(deckMode(useApp.getState())).toBe("settings");
      // A field with no use for it lets it through.
      fireEvent.keyDown(field, { key: "Escape" });
      expect(deckMode(useApp.getState())).toBe("view");
    });

    it("closes what is open over the settings first", () => {
      render(<DeckSettings />);
      let closed = false;
      const gone = openLayer(() => {
        closed = true;
        gone();
      });
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(closed).toBe(true);
      expect(deckMode(useApp.getState())).toBe("settings");
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(deckMode(useApp.getState())).toBe("view");
    });

    it("takes no Escape once it is gone", () => {
      const { unmount } = render(<DeckSettings />);
      // Gone, the settings take no Escape any more.
      unmount();
      useApp.setState({ slideMode: "git" });
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(deckMode(useApp.getState())).toBe("git");
    });
  });

  describe("the title", () => {
    it("comes first, holding the deck's title", () => {
      render(<DeckSettings />);
      expect(title().value).toBe("Talk");
      const cards = screen.getByRole("region", { name: "Deck settings" }).querySelectorAll(".rounded-xl");
      expect(cards[0]!.contains(title())).toBe(true);
    });

    it("renames the deck on Enter, and on leaving the field", async () => {
      render(<DeckSettings />);
      fireEvent.change(title(), { target: { value: " Board update " } });
      await act(async () => fireEvent.keyDown(title(), { key: "Enter" }));
      expect(renameDeck).toHaveBeenLastCalledWith("Board update");
      fireEvent.change(title(), { target: { value: "Q3" } });
      await act(async () => fireEvent.blur(title()));
      expect(renameDeck).toHaveBeenLastCalledWith("Q3");
    });

    it("does not rename to the title the deck has", async () => {
      render(<DeckSettings />);
      await act(async () => fireEvent.blur(title()));
      fireEvent.change(title(), { target: { value: "Talk " } });
      await act(async () => fireEvent.keyDown(title(), { key: "Enter" }));
      expect(renameDeck).not.toHaveBeenCalled();
    });

    it("takes no empty title: Enter says so, leaving puts the title back", async () => {
      render(<DeckSettings />);
      fireEvent.change(title(), { target: { value: "" } });
      await act(async () => fireEvent.keyDown(title(), { key: "Enter" }));
      expect(title().getAttribute("aria-invalid")).toBe("true");
      await act(async () => fireEvent.blur(title()));
      expect(title().value).toBe("Talk");
      expect(title().getAttribute("aria-invalid")).toBeNull();
      expect(renameDeck).not.toHaveBeenCalled();
    });

    it("takes the typing back on Escape, staying in the settings", () => {
      render(<DeckSettings />);
      fireEvent.change(title(), { target: { value: "Other" } });
      fireEvent.keyDown(title(), { key: "Escape" });
      expect(title().value).toBe("Talk");
      expect(deckMode(useApp.getState())).toBe("settings");
      expect(renameDeck).not.toHaveBeenCalled();
    });

    it("puts the title back when the deck could not be renamed", async () => {
      renameDeck.mockResolvedValue(false);
      render(<DeckSettings />);
      fireEvent.change(title(), { target: { value: "Other" } });
      await act(async () => fireEvent.keyDown(title(), { key: "Enter" }));
      expect(title().value).toBe("Talk");
    });

    it("follows a title changed elsewhere", () => {
      render(<DeckSettings />);
      act(() => useApp.setState({ deck: { ...useApp.getState().deck!, title: "Renamed by the agent" } }));
      expect(title().value).toBe("Renamed by the agent");
    });
  });
});
