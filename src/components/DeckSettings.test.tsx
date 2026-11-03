import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { DeckSettings } from "./DeckSettings";

const applyStyle = vi.fn(async () => {});
const resizeSlides = vi.fn(async () => {});
const setDeckTransition = vi.fn(async () => {});

beforeEach(() => {
  applyStyle.mockClear();
  resizeSlides.mockClear();
  setDeckTransition.mockClear();
  useApp.setState({
    deck: { ...deckFor(DECK_HTML), template: "swiss" },
    running: false,
    templates: [{ id: "swiss", title: "Swiss Design", builtin: true, path: null, slides: ["title"] }],
    applyStyle,
    resizeSlides,
    setDeckTransition,
  });
});

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

  it("fades between slides by default, and changes the deck's transition", () => {
    render(<DeckSettings />);
    expect(screen.getByRole("button", { name: "Fade" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Slide" }));
    expect(setDeckTransition).toHaveBeenCalledWith("slide");
    expect(screen.queryByTestId("own-transitions")).toBeNull();
  });

  it("shows the deck's transition and how many slides have their own", () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({
      deck: { ...deck, transition: "wipe", slides: deck.slides.map((s, i) => (i ? { ...s, transition: "zoom" } : s)) },
    });
    render(<DeckSettings />);
    expect(screen.getByRole("button", { name: "Wipe" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("own-transitions").textContent).toBe("2 slides have their own transition.");
  });
});
