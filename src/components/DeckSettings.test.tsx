import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { openLayer } from "../lib/layers";
import { type DesignChange, useApp } from "../store";
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
    slideMode: "view",
    deckSettingsOpen: true,
    templates: [{ id: "swiss", title: "Swiss Design", builtin: true, path: null, slides: ["title"] }],
    applyStyle,
    resizeSlides,
    renameDeck,
  });
});

const isOpen = () => useApp.getState().deckSettingsOpen;

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

  it("is a dialog called the deck's settings, apart from the app's", () => {
    render(<DeckSettings />);
    expect(screen.getByRole("dialog", { name: "Deck settings" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Deck settings" })).toBeTruthy();
  });

  it("puts the deck's own style first, marked as the current one", () => {
    useApp.setState({
      templates: [
        { id: "plain", title: "Plain", builtin: true, path: null, slides: ["title"] },
        { id: "swiss", title: "Swiss Design", builtin: true, path: null, slides: ["title"] },
      ],
    });
    render(<DeckSettings />);
    const styles = screen.getAllByRole("button", { name: / style$/ });
    expect(styles[0]!.getAttribute("aria-label")).toBe("Swiss Design style");
    expect(styles[0]!.textContent).toContain("Current");
  });

  describe("closing", () => {
    it("is the Close button, the slide's mode staying as it was", () => {
      useApp.setState({ editing: true });
      render(<DeckSettings />);
      fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
      expect(isOpen()).toBe(false);
      expect(useApp.getState().editing).toBe(true);
    });

    it("is Escape too", () => {
      render(<DeckSettings />);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(isOpen()).toBe(false);
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
      expect(isOpen()).toBe(true);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(isOpen()).toBe(false);
    });

    it("asks about a slide size that is not applied yet, and loses nothing without a word", async () => {
      render(<DeckSettings />);
      fireEvent.click(screen.getByRole("button", { name: "Square" }));
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(isOpen()).toBe(true);
      expect(screen.getByRole("alert").textContent).toContain("Apply the new slide size?");
      fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(screen.queryByRole("alert")).toBeNull();

      fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
      resizeSlides.mockResolvedValueOnce("applied");
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply and close" })));
      expect(resizeSlides).toHaveBeenCalledWith({ width: 1080, height: 1080, unit: "px" });
      expect(isOpen()).toBe(false);
    });

    it("discards the size typed when the user says so", () => {
      render(<DeckSettings />);
      fireEvent.click(screen.getByRole("button", { name: "Square" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
      fireEvent.click(screen.getByRole("button", { name: "Discard size" }));
      expect(isOpen()).toBe(false);
      expect(resizeSlides).not.toHaveBeenCalled();
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
      expect(isOpen()).toBe(true);
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
