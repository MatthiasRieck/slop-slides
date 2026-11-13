import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { TimelineTools } from "./TimelineTools";

beforeEach(() => useApp.setState({ deck: deckFor(DECK_HTML), timelineOpen: false }));

describe("TimelineTools", () => {
  const toggle = () => screen.getByRole("button", { name: /the timeline under the slide$/ }) as HTMLButtonElement;

  it("is named for what it shows, its state in whether it is pressed in", () => {
    render(<TimelineTools collapsed={false} />);
    expect(toggle().textContent).toBe("Timeline");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle());
    expect(useApp.getState().timelineOpen).toBe(true);
    // The same word either way: "Shown" or "Hidden" would read as what pressing it does.
    expect(toggle().textContent).toBe("Timeline");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(toggle().getAttribute("aria-label")).toBe("Hide the timeline under the slide");
  });

  it("has nothing to show for a deck whose slides are all hidden", () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck: { ...deck, slides: deck.slides.map((s) => ({ ...s, hidden: true })) } });
    render(<TimelineTools collapsed={false} />);
    expect(toggle().disabled).toBe(true);
  });
});
