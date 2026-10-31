import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import type { Deck } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { SlideTime } from "./SlideTime";

const withTimes = (times: Record<string, number>): Deck => {
  const deck = deckFor(DECK_HTML);
  return { ...deck, slides: deck.slides.map((s) => ({ ...s, time: times[s.id] ?? 0 })) };
};
const field = () => screen.getByLabelText("Expected time for this slide") as HTMLInputElement;
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

  it("goes back to the time it had on what is no time", async () => {
    render(<SlideTime deck={withTimes({ intro: 75 })} />);
    await type("soon");
    expect(invoke).not.toHaveBeenCalled();
    expect(field().value).toBe("1:15");
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
    expect(screen.getByTestId("deck-time").textContent).toBe("of 1:30");
    const hidden = { ...deck, slides: deck.slides.map((s) => ({ ...s, hidden: s.id === "outro" })) };
    rerender(<SlideTime deck={hidden} />);
    expect(screen.getByTestId("deck-time").textContent).toBe("of 1:00");
  });

  it("leaves the time of a locked slide alone", () => {
    const deck = withTimes({});
    render(<SlideTime deck={{ ...deck, slides: deck.slides.map((s) => ({ ...s, locked: true })) }} />);
    expect(field().disabled).toBe(true);
  });
});
