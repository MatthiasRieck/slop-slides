import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { DeckSettings } from "./DeckSettings";

const applyStyle = vi.fn(async () => {});
const resizeSlides = vi.fn(async () => {});

beforeEach(() => {
  applyStyle.mockClear();
  resizeSlides.mockClear();
  useApp.setState({
    deck: { ...deckFor(DECK_HTML), template: "swiss" },
    running: false,
    templates: [{ id: "swiss", title: "Swiss Design", builtin: true, path: null, slides: ["title"] }],
    applyStyle,
    resizeSlides,
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
});
