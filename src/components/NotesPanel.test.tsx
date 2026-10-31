import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import type { Deck } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { NOTES_SAVE_DELAY, NotesPanel } from "./NotesPanel";

const setNotes = vi.fn(async (_slide: string, _text: string) => {});

function deckWith(notes: Record<string, string>, locked: string[] = []): Deck {
  const deck = deckFor(DECK_HTML);
  return {
    ...deck,
    slides: deck.slides.map((s) => ({ ...s, notes: notes[s.id] ?? "", locked: locked.includes(s.id) })),
  };
}

const box = () => screen.getByRole("textbox", { name: "Speaker notes" }) as HTMLTextAreaElement;

beforeEach(() => {
  vi.useFakeTimers();
  setNotes.mockClear();
  useApp.setState({ deck: deckWith({ intro: "Say hello." }), selected: "intro", setNotes });
});
afterEach(() => vi.useRealTimers());

describe("NotesPanel", () => {
  it("shows the selected slide's notes", () => {
    render(<NotesPanel />);
    expect(box().value).toBe("Say hello.");
    expect(screen.getByText(/Slide 1 of 3/)).toBeTruthy();
  });

  it("saves once typing pauses", () => {
    render(<NotesPanel />);
    fireEvent.change(box(), { target: { value: "Say" } });
    fireEvent.change(box(), { target: { value: "Say bye." } });
    act(() => void vi.advanceTimersByTime(NOTES_SAVE_DELAY - 1));
    expect(setNotes).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(setNotes).toHaveBeenCalledExactlyOnceWith("intro", "Say bye.");
  });

  it("saves pending text on blur and when switching slides, to the slide it was typed on", () => {
    render(<NotesPanel />);
    fireEvent.change(box(), { target: { value: "One" } });
    fireEvent.blur(box());
    expect(setNotes).toHaveBeenLastCalledWith("intro", "One");
    fireEvent.change(box(), { target: { value: "Two" } });
    act(() => useApp.getState().select("outro"));
    expect(setNotes).toHaveBeenLastCalledWith("intro", "Two");
    expect(box().value).toBe("");
  });

  it("takes on notes changed elsewhere, unless the user is typing", () => {
    render(<NotesPanel />);
    act(() => useApp.setState({ deck: deckWith({ intro: "From the agent." }) }));
    expect(box().value).toBe("From the agent.");
    fireEvent.change(box(), { target: { value: "Mine" } });
    act(() => useApp.setState({ deck: deckWith({ intro: "Again." }) }));
    expect(box().value).toBe("Mine");
  });

  it("is read-only on a locked slide", () => {
    useApp.setState({ deck: deckWith({}, ["intro"]) });
    render(<NotesPanel />);
    expect(box().readOnly).toBe(true);
    expect(screen.getByText("Locked")).toBeTruthy();
  });

  it("asks for a slide when there is none", () => {
    useApp.setState({ deck: { ...deckWith({}), slides: [] }, selected: null });
    render(<NotesPanel />);
    expect(screen.getByText("Add a slide to write its notes.")).toBeTruthy();
  });
});
