import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Deck } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { SlideTime } from "./SlideTime";

const withTimes = (times: Record<string, number>): Deck => {
  const deck = deckFor(DECK_HTML);
  return { ...deck, slides: deck.slides.map((s) => ({ ...s, time: times[s.id] ?? 0 })) };
};
const field = () => screen.getByLabelText("Planned time") as HTMLInputElement;
const type = async (text: string) => {
  fireEvent.change(field(), { target: { value: text } });
  await act(async () => fireEvent.blur(field()));
};

beforeEach(() => {
  invoke.mockReset();
  useApp.setState({ deck: withTimes({}), selected: "intro" });
  invoke.mockImplementation(async () => useApp.getState().deck);
});

describe("SlideTime", () => {
  it("fits beside the notes when compact: its name only for screen readers, the deck's sum in its tooltip", () => {
    render(<SlideTime deck={withTimes({ intro: 60, outro: 30 })} compact />);
    expect(field().value).toBe("1:00");
    expect(screen.getByText("Planned time").className).toContain("sr-only");
    expect(screen.queryByTestId("deck-time")).toBeNull();
    expect(field().title).toContain("All slides shown: 1:30.");
  });

  it("saves the time typed for the selected slide", async () => {
    render(<SlideTime deck={withTimes({})} />);
    await type("1:30");
    expect(invoke).toHaveBeenCalledWith("set_slide_time", { id: expect.any(String), slide: "intro", seconds: 90 });
  });

  it("shows the slide's time and clears it", async () => {
    render(<SlideTime deck={withTimes({ intro: 75 })} />);
    expect(field().value).toBe("1:15");
    await type("");
    expect(invoke).toHaveBeenCalledWith("set_slide_time", expect.objectContaining({ seconds: 0 }));
  });

  it("does not save an unchanged time", async () => {
    render(<SlideTime deck={withTimes({ intro: 75 })} />);
    await type("1:15");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is labelled as the time planned, not as progress", () => {
    render(<SlideTime deck={withTimes({ intro: 75, outro: 645 })} />);
    expect(screen.getByText("Planned time")).toBeTruthy();
    expect(screen.getByTestId("deck-time").textContent).toBe("of 12:00 planned");
  });

  it("marks what is no time instead of throwing it away unseen", async () => {
    render(<SlideTime deck={withTimes({ intro: 75 })} />);
    expect(field().getAttribute("aria-invalid")).toBeNull();
    await type("soon");
    expect(invoke).not.toHaveBeenCalled();
    // It stays as typed, marked, and says what a time looks like.
    expect(field().value).toBe("soon");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    const problem = screen.getByRole("alert");
    expect(problem.textContent).toMatch(/1:30/);
    expect(field().getAttribute("aria-describedby")).toBe(problem.id);
    expect(field().className).toContain("ring-destructive");
    // Typing over it clears the mark; a time is saved as ever.
    fireEvent.change(field(), { target: { value: "2" } });
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => fireEvent.blur(field()));
    expect(invoke).toHaveBeenCalledWith("set_slide_time", expect.objectContaining({ seconds: 120 }));
  });

  it("Escape takes back what is no time", async () => {
    render(<SlideTime deck={withTimes({ intro: 75 })} />);
    await type("soon");
    fireEvent.keyDown(field(), { key: "Escape" });
    await act(async () => fireEvent.blur(field()));
    expect(field().value).toBe("1:15");
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("drops the mark with the slide it was typed for", async () => {
    const deck = withTimes({ intro: 75 });
    const { rerender } = render(<SlideTime deck={deck} />);
    await type("soon");
    act(() => useApp.setState({ selected: "outro" }));
    rerender(<SlideTime deck={deck} />);
    expect(field().value).toBe("");
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });

  it("cancels with Escape", async () => {
    render(<SlideTime deck={withTimes({ intro: 75 })} />);
    fireEvent.change(field(), { target: { value: "9" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    await act(async () => fireEvent.blur(field()));
    expect(invoke).not.toHaveBeenCalled();
    expect(field().value).toBe("1:15");
  });

  it("adds up the times of the slides shown", () => {
    const deck = withTimes({ intro: 60, outro: 30 });
    const { rerender } = render(<SlideTime deck={deck} />);
    expect(screen.getByTestId("deck-time").textContent).toBe("of 1:30 planned");
    const hidden = { ...deck, slides: deck.slides.map((s) => ({ ...s, hidden: s.id === "outro" })) };
    rerender(<SlideTime deck={hidden} />);
    expect(screen.getByTestId("deck-time").textContent).toBe("of 1:00 planned");
  });

  it("leaves the time of a locked slide alone", () => {
    const deck = withTimes({});
    render(<SlideTime deck={{ ...deck, slides: deck.slides.map((s) => ({ ...s, locked: true })) }} />);
    expect(field().disabled).toBe(true);
  });
});
