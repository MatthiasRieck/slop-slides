import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import type { Deck } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { NARRATION_SAVE_DELAY, NarrationPanel } from "./NarrationPanel";

const setNarration = vi.fn(async (_slide: string, _text: string) => {});

function deckWith(narration: Record<string, string>, locked: string[] = []): Deck {
  const deck = deckFor(DECK_HTML);
  return {
    ...deck,
    slides: deck.slides.map((s) => ({ ...s, narration: narration[s.id] ?? "", locked: locked.includes(s.id) })),
  };
}

const box = () => screen.getByRole("textbox", { name: "Narration" }) as HTMLTextAreaElement;

beforeEach(() => {
  vi.useFakeTimers();
  setNarration.mockClear();
  useApp.setState({ deck: deckWith({ intro: "Welcome, everyone." }), selected: "intro", setNarration });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NarrationPanel", () => {
  it("shows the current slide's narration with its length", () => {
    render(<NarrationPanel />);
    expect(box().value).toBe("Welcome, everyone.");
    expect(screen.getByText(/Slide 1 of 3/)).toBeTruthy();
    expect(screen.getByText("2 words")).toBeTruthy();
    act(() => useApp.getState().select("outro"));
    expect(box().value).toBe("");
    expect(screen.getByText(/Slide 3 of 3/)).toBeTruthy();
  });

  it("saves once typing pauses", () => {
    render(<NarrationPanel />);
    fireEvent.change(box(), { target: { value: "Welcome" } });
    fireEvent.change(box(), { target: { value: "Welcome back" } });
    expect(setNarration).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(NARRATION_SAVE_DELAY));
    expect(setNarration.mock.calls).toEqual([["intro", "Welcome back"]]);
  });

  it("saves right away on blur and when switching slides", () => {
    render(<NarrationPanel />);
    fireEvent.change(box(), { target: { value: "First" } });
    fireEvent.blur(box());
    expect(setNarration.mock.calls).toEqual([["intro", "First"]]);
    fireEvent.change(box(), { target: { value: "Second" } });
    act(() => useApp.getState().select("outro"));
    expect(setNarration.mock.calls).toEqual([
      ["intro", "First"],
      ["intro", "Second"],
    ]);
    act(() => vi.advanceTimersByTime(NARRATION_SAVE_DELAY));
    expect(setNarration).toHaveBeenCalledTimes(2);
  });

  it("follows changes made elsewhere, but not while the user is typing", () => {
    render(<NarrationPanel />);
    act(() => useApp.setState({ deck: deckWith({ intro: "From the agent." }) }));
    expect(box().value).toBe("From the agent.");
    fireEvent.change(box(), { target: { value: "Mine " } });
    act(() => useApp.setState({ deck: deckWith({ intro: "Agent again." }) }));
    expect(box().value).toBe("Mine ");
    // The saved, trimmed text coming back does not undo the trailing space being typed.
    act(() => vi.advanceTimersByTime(NARRATION_SAVE_DELAY));
    act(() => useApp.setState({ deck: deckWith({ intro: "Mine" }) }));
    expect(box().value).toBe("Mine ");
  });

  it("is read-only on a locked slide", () => {
    useApp.setState({ deck: deckWith({ intro: "Fixed." }, ["intro"]) });
    render(<NarrationPanel />);
    expect(box().readOnly).toBe(true);
    expect(screen.getByText("Locked")).toBeTruthy();
  });

  it("explains itself without a deck or slides", () => {
    useApp.setState({ deck: null, selected: null });
    const { rerender } = render(<NarrationPanel />);
    expect(screen.getByText(/Open a deck/)).toBeTruthy();
    useApp.setState({ deck: { ...deckFor(DECK_HTML), slides: [] } });
    rerender(<NarrationPanel />);
    expect(screen.getByText(/Add a slide/)).toBeTruthy();
  });
});
