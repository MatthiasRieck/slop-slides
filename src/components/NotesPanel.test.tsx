import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Deck } from "../lib/api";
import { NOTES_HEIGHT, useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { firstNotesLine, NOTES_SAVE_DELAY, NotesPane } from "./NotesPanel";

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
  useApp.setState({
    deck: deckWith({ intro: "Say hello." }),
    selected: "intro",
    setNotes,
    notesOpen: true,
    notesHeight: NOTES_HEIGHT.initial,
  });
});
afterEach(() => vi.useRealTimers());

describe("the speaker notes under the slide", () => {
  it("shows the selected slide's notes, naming the slide by its number and title", () => {
    render(<NotesPane />);
    expect(box().value).toBe("Say hello.");
    expect(screen.getByText("Slide 1 · Intro")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Speaker notes" })).toBeTruthy();
  });

  it("folds to one line that shows how the notes begin, and opens again, remembering which", () => {
    useApp.setState({ deck: deckWith({ intro: "\n  First point\nSecond" }) });
    render(<NotesPane />);
    const toggle = screen.getByRole("button", { name: "Notes" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(useApp.getState().notesOpen).toBe(false);
    expect(localStorage.getItem("slopslide.notesOpen")).toBe("false");
    expect(screen.queryByRole("textbox", { name: "Speaker notes" })).toBeNull();
    expect(screen.getByTestId("notes-first-line").textContent).toBe("First point");
    fireEvent.click(screen.getByTestId("notes-first-line"));
    expect(useApp.getState().notesOpen).toBe(true);
    // Opened by the user, the field takes the keyboard.
    expect(document.activeElement).toBe(box());
  });

  it("invites notes on a slide without any, while folded", () => {
    useApp.setState({ deck: deckWith({}), notesOpen: false });
    render(<NotesPane />);
    expect(screen.getByTestId("notes-first-line").textContent).toBe("Add what to say while this slide is shown…");
    expect(firstNotesLine("  \n\n")).toBe("");
  });

  it("shows the time planned for the slide beside the notes", () => {
    useApp.setState({ deck: { ...deckWith({}), slides: deckWith({}).slides.map((s) => ({ ...s, time: 90 })) } });
    render(<NotesPane />);
    expect((screen.getByLabelText("Planned time") as HTMLInputElement).value).toBe("1:30");
  });

  it("is resized by its top edge, by drag and by the arrow keys, within bounds, and remembers the height", () => {
    render(<NotesPane />);
    const edge = screen.getByRole("separator", { name: "Resize the speaker notes" });
    fireEvent.pointerDown(edge, { button: 0, clientY: 500 });
    fireEvent.pointerMove(edge, { clientY: 460 });
    fireEvent.pointerUp(edge);
    expect(useApp.getState().notesHeight).toBe(NOTES_HEIGHT.initial + 40);
    expect(localStorage.getItem("slopslide.notesHeight")).toBe(String(NOTES_HEIGHT.initial + 40));
    fireEvent.keyDown(edge, { key: "ArrowDown" });
    expect(useApp.getState().notesHeight).toBe(NOTES_HEIGHT.initial + 24);
    fireEvent.pointerDown(edge, { button: 0, clientY: 500 });
    fireEvent.pointerMove(edge, { clientY: -5000 });
    expect(useApp.getState().notesHeight).toBe(NOTES_HEIGHT.max);
    fireEvent.pointerUp(edge);
    fireEvent.doubleClick(edge);
    expect(useApp.getState().notesHeight).toBe(NOTES_HEIGHT.initial);
  });

  it("previews the notes formatted, and goes back to editing them", () => {
    useApp.setState({ deck: deckWith({ intro: "Say **hello**." }) });
    render(<NotesPane />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const preview = screen.getByRole("document", { name: "Speaker notes preview" });
    expect(preview.querySelector("strong")?.textContent).toBe("hello");
    expect(screen.queryByRole("textbox", { name: "Speaker notes" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(box().value).toBe("Say **hello**.");
  });

  it("saves once typing pauses", () => {
    render(<NotesPane />);
    fireEvent.change(box(), { target: { value: "Say" } });
    fireEvent.change(box(), { target: { value: "Say bye." } });
    act(() => void vi.advanceTimersByTime(NOTES_SAVE_DELAY - 1));
    expect(setNotes).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(setNotes).toHaveBeenCalledExactlyOnceWith("intro", "Say bye.");
  });

  it("saves pending text on blur and when switching slides, to the slide it was typed on", () => {
    render(<NotesPane />);
    fireEvent.change(box(), { target: { value: "One" } });
    fireEvent.blur(box());
    expect(setNotes).toHaveBeenLastCalledWith("intro", "One");
    fireEvent.change(box(), { target: { value: "Two" } });
    act(() => useApp.getState().select("outro"));
    expect(setNotes).toHaveBeenLastCalledWith("intro", "Two");
    expect(box().value).toBe("");
  });

  it("says in its header that the notes are being saved, and when they are", async () => {
    render(<NotesPane />);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.change(box(), { target: { value: "Say bye." } });
    expect(screen.getByRole("status").textContent).toBe("Saving…");
    await act(async () => void (await vi.advanceTimersByTimeAsync(NOTES_SAVE_DELAY)));
    expect(setNotes).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toBe("Saved");
    // Typing on is saving again.
    fireEvent.change(box(), { target: { value: "Say bye, twice." } });
    expect(screen.getByRole("status").textContent).toBe("Saving…");
  });

  it("does not say Saved for a save that typing has overtaken", async () => {
    let saved: () => void = () => {};
    setNotes.mockImplementationOnce(() => new Promise<void>((resolve) => (saved = resolve)));
    render(<NotesPane />);
    fireEvent.change(box(), { target: { value: "One" } });
    await act(async () => void (await vi.advanceTimersByTimeAsync(NOTES_SAVE_DELAY)));
    fireEvent.change(box(), { target: { value: "One, two" } });
    await act(async () => saved());
    expect(screen.getByRole("status").textContent).toBe("Saving…");
  });

  it("takes on notes changed elsewhere, unless the user is typing", () => {
    render(<NotesPane />);
    act(() => useApp.setState({ deck: deckWith({ intro: "From the agent." }) }));
    expect(box().value).toBe("From the agent.");
    fireEvent.change(box(), { target: { value: "Mine" } });
    act(() => useApp.setState({ deck: deckWith({ intro: "Again." }) }));
    expect(box().value).toBe("Mine");
  });

  it("is read-only on a locked slide", () => {
    useApp.setState({ deck: deckWith({}, ["intro"]) });
    render(<NotesPane />);
    expect(box().readOnly).toBe(true);
    expect(screen.getByRole("img", { name: "Locked" })).toBeTruthy();
  });

  it("is not there without a slide", () => {
    useApp.setState({ deck: { ...deckWith({}), slides: [] }, selected: null });
    const { container } = render(<NotesPane />);
    expect(container.textContent).toBe("");
  });
});
