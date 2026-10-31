import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import type { FindMatch, ReplacedText } from "../lib/api";
import { searchHighlight, useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { SlideSearch } from "./FindReplace";

const DECK = deckFor(DECK_HTML);
const SLIDES = DECK.slides.map((s) => s.id);
const match = (slide: string, index: number, more: Partial<FindMatch> = {}): FindMatch => ({
  slide,
  index,
  locked: false,
  notes: false,
  before: "",
  text: "hello",
  after: "",
  ...more,
});
const MATCHES = [match("intro", 0), match("outro", 2), match("outro", 2, { locked: true })];

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const field = () => screen.getByLabelText("Search slides") as HTMLInputElement;
const search = (value: string) => fireEvent.change(field(), { target: { value } });
const status = () => screen.getByRole("status");
const found = (matches: FindMatch[]) =>
  invoke.mockImplementation(async (cmd: string) => (cmd === "find_in_deck" ? matches : null));

beforeEach(() => {
  invoke.mockReset();
  useApp.getState().clearSearch();
  useApp.setState({ deck: DECK, selected: "intro", view: "slides", error: null });
});

describe("search", () => {
  it("searches as you type, with case and whole-word options, and ends with the toolbar", async () => {
    found(MATCHES);
    const { unmount } = render(<SlideSearch />);
    expect(screen.queryByRole("status")).toBeNull();
    search("hello");
    await waitFor(() => expect(status().textContent).toBe("1 / 3"));
    expect(status().title).toBe("3 matches on 2 slides");
    expect(invoke).toHaveBeenLastCalledWith("find_in_deck", {
      id: DECK.id,
      query: "hello",
      options: { matchCase: false, wholeWord: false },
    });
    fireEvent.click(button("Match case"));
    fireEvent.click(button("Whole words"));
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith("find_in_deck", {
        id: DECK.id,
        query: "hello",
        options: { matchCase: true, wholeWord: true },
      }),
    );
    unmount();
    expect(useApp.getState().search).toMatchObject({ query: "", matches: null });
  });

  it("steps through the matches around the deck, going to their slides", async () => {
    found(MATCHES);
    render(<SlideSearch />);
    expect(button("Next match").disabled).toBe(true);
    search("hello");
    await waitFor(() => expect(status().textContent).toBe("1 / 3"));
    fireEvent.click(button("Next match"));
    expect(status().textContent).toBe("2 / 3");
    expect(useApp.getState().selected).toBe("outro");
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(status().textContent).toBe("1 / 3");
    expect(useApp.getState().selected).toBe("intro");
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(status().textContent).toBe("3 / 3");
    fireEvent.click(button("Previous match"));
    expect(status().textContent).toBe("2 / 3");
  });

  it("focuses a slide's first match when the slide is picked, and leaves the slide alone while typing", async () => {
    found(MATCHES);
    render(<SlideSearch />);
    search("hello");
    await waitFor(() => expect(status().textContent).toBe("1 / 3"));
    expect(useApp.getState().selected).toBe("intro");
    act(() => useApp.getState().select("outro"));
    expect(status().textContent).toBe("2 / 3");
  });

  it("goes to the nearest match from a slide without any", async () => {
    found([match("intro", 0), match("outro", 2)]);
    render(<SlideSearch />);
    useApp.setState({ selected: SLIDES[1]! });
    search("hello");
    await waitFor(() => expect(status().textContent).toBe("2"));
    fireEvent.click(button("Previous match"));
    expect(useApp.getState().selected).toBe("intro");
    act(() => useApp.getState().select(SLIDES[1]!));
    fireEvent.click(button("Next match"));
    expect(useApp.getState().selected).toBe("outro");
  });

  it("says when the match in focus is in the notes, and when nothing matches", async () => {
    found([match("intro", 0, { notes: true })]);
    render(<SlideSearch />);
    search("hello");
    await waitFor(() => expect(status().textContent).toBe("1 / 1 in notes"));
    found([]);
    search("nothing");
    await waitFor(() => expect(status().textContent).toBe("No matches"));
  });

  it("clears with the button or Escape", async () => {
    found(MATCHES);
    render(<SlideSearch />);
    search("hello");
    await waitFor(() => expect(status()).toBeTruthy());
    fireEvent.click(button("Clear search"));
    expect(field().value).toBe("");
    expect(useApp.getState().search.matches).toBeNull();
    search("hello");
    await waitFor(() => expect(status()).toBeTruthy());
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().value).toBe("");
  });

  it("gets focus with ⌘F, in the app or in the slide", () => {
    render(<SlideSearch />);
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(document.activeElement).toBe(field());
    field().blur();
    act(
      () => void window.dispatchEvent(new MessageEvent("message", { data: { type: "slop:key", key: "f", mod: true } })),
    );
    expect(document.activeElement).toBe(field());
  });

  it("tells the stage where to mark, counting the matches on the slide", () => {
    useApp.setState({ selected: "outro" });
    act(() => {
      useApp.getState().setSearch({ query: "hello" });
      useApp.getState().setSearchMatches(MATCHES);
      useApp.getState().stepSearch(1);
    });
    expect(searchHighlight(useApp.getState())).toEqual({
      query: "hello",
      matchCase: false,
      wholeWord: false,
      active: 1,
    });
    act(() => useApp.getState().select(SLIDES[1]!));
    expect(searchHighlight(useApp.getState()).active).toBe(-1);
  });
});

describe("replace", () => {
  const open = async (query = "hello") => {
    render(<SlideSearch />);
    search(query);
    await waitFor(() => expect(status()).toBeTruthy());
    fireEvent.click(button("Replace"));
  };
  const type = (value: string) => fireEvent.change(screen.getByLabelText("Replace with"), { target: { value } });

  it("replaces on this slide or everywhere, says what changed, and undoes it", async () => {
    const replaced: ReplacedText = {
      deck: DECK,
      count: 2,
      slides: ["intro", "outro"],
      skipped: ["locked"],
      previous: "<old>",
      source: "<new>",
    };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "find_in_deck") return MATCHES;
      if (cmd === "replace_in_deck") return replaced;
      if (cmd === "save_deck_source") return DECK;
      return null;
    });
    await open();
    type("Hi");
    await waitFor(() => expect(button("Replace all").disabled).toBe(false));
    fireEvent.click(button("Replace on this slide"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("replace_in_deck", {
        id: DECK.id,
        query: "hello",
        replacement: "Hi",
        options: { matchCase: false, wholeWord: false },
        slides: ["intro"],
      }),
    );
    fireEvent.click(button("Replace all"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("replace_in_deck", expect.objectContaining({ slides: null })),
    );
    await waitFor(() => expect(screen.getByText(/Replaced 2 matches on 2 slides/)).toBeTruthy());
    expect(screen.getByText(/1 locked slide was left as it was/)).toBeTruthy();
    fireEvent.click(button("Undo"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("save_deck_source", { id: DECK.id, source: "<old>", base: "<new>" }),
    );
    await waitFor(() => expect(screen.queryByText(/Replaced/)).toBeNull());
  });

  it("cannot replace where only locked slides match, or on a slide without matches", async () => {
    found([MATCHES[2]!]);
    await open();
    expect(button("Replace all").disabled).toBe(true);
    expect(button("Replace on this slide").disabled).toBe(true);
  });

  it("shows a failed replace and keeps the panel open", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "find_in_deck") return MATCHES;
      throw "disk full";
    });
    await open();
    await waitFor(() => expect(button("Replace all").disabled).toBe(false));
    fireEvent.click(button("Replace all"));
    await waitFor(() => expect(useApp.getState().error).toBe("disk full"));
    expect(screen.getByRole("dialog", { name: "Replace" })).toBeTruthy();
  });
});
