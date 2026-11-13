import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { FindMatch, ReplacedText } from "../lib/api";
import { searchHighlight, useApp } from "../store";
import { lastError } from "../store/errors";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { FindBar, SlideSearch, useDeckSearch, useFindShortcut } from "./FindReplace";

/** The search as the stage has it: its shortcut and its searching, with View's ribbon rows or Edit's bar. */
function Find({ bar = false }: { bar?: boolean }) {
  useFindShortcut();
  useDeckSearch();
  return bar ? <FindBar /> : <SlideSearch />;
}

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
  useApp.setState({ deck: DECK, selected: "intro", toasts: [], editing: false, sidebarTab: "chat" });
});

describe("search", () => {
  it("searches as you type, with case and whole-word options, and ends with the toolbar", async () => {
    found(MATCHES);
    const { unmount } = render(<Find />);
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
    render(<Find />);
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
    render(<Find />);
    search("hello");
    await waitFor(() => expect(status().textContent).toBe("1 / 3"));
    expect(useApp.getState().selected).toBe("intro");
    act(() => useApp.getState().select("outro"));
    expect(status().textContent).toBe("2 / 3");
  });

  it("goes to the nearest match from a slide without any", async () => {
    found([match("intro", 0), match("outro", 2)]);
    render(<Find />);
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
    render(<Find />);
    search("hello");
    await waitFor(() => expect(status().textContent).toBe("1 / 1 in notes"));
    found([]);
    search("nothing");
    await waitFor(() => expect(status().textContent).toBe("No matches"));
  });

  it("clears with the button or Escape", async () => {
    found(MATCHES);
    render(<Find />);
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
    render(<Find />);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(field());
    expect(useApp.getState().search.focusAsked).toBe(false);
    field().blur();
    act(
      () => void window.dispatchEvent(new MessageEvent("message", { data: { type: "slop:key", key: "f", mod: true } })),
    );
    expect(document.activeElement).toBe(field());
  });

  it("leaves ⌘F to the HTML tab's editor, which has a search of its own", () => {
    render(
      <>
        <Find />
        <div className="cm-editor">
          <button type="button">Code</button>
        </div>
      </>,
    );
    const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    screen.getByText("Code").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(useApp.getState().search.open).toBe(false);
    expect(document.activeElement).not.toBe(field());
  });

  it("says that a search failed, which is not the same as finding nothing", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "find_in_deck") throw "the deck file is gone";
      return null;
    });
    render(<Find />);
    search("hello");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Search failed");
    expect(alert.title).toBe("the deck file is gone");
    expect(screen.queryByRole("status")).toBeNull();
    expect(useApp.getState().search).toMatchObject({ matches: null, failed: "the deck file is gone" });
    // The next search that works says what it found again.
    found(MATCHES);
    search("hell");
    await waitFor(() => expect(status().textContent).toBe("1 / 3"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens the Notes tab when it steps to a match in a slide's notes", async () => {
    found([match("intro", 0), match("outro", 2, { notes: true })]);
    render(<Find />);
    search("hello");
    await waitFor(() => expect(status().textContent).toBe("1 / 2"));
    expect(useApp.getState().sidebarTab).toBe("chat");
    fireEvent.click(button("Next match"));
    expect(status().textContent).toBe("2 / 2 in notes");
    expect(useApp.getState().sidebarTab).toBe("notes");
  });

  describe("in Edit, as a bar over the stage", () => {
    beforeEach(() => useApp.setState({ editing: true }));

    it("shows once it is asked for, takes the focus, and goes away with Escape or its button", () => {
      render(<Find bar />);
      expect(screen.queryByLabelText("Search slides")).toBeNull();
      fireEvent.keyDown(window, { key: "f", ctrlKey: true });
      expect(document.activeElement).toBe(field());
      fireEvent.keyDown(field(), { key: "Escape" });
      expect(screen.queryByLabelText("Search slides")).toBeNull();
      act(() => useApp.getState().openFind());
      fireEvent.click(button("Close the search"));
      expect(screen.queryByLabelText("Search slides")).toBeNull();
    });

    it("keeps what was searched for in View, without taking the focus for it", async () => {
      found(MATCHES);
      act(() => useApp.getState().setSearch({ query: "hello" }));
      render(<Find bar />);
      expect(field().value).toBe("hello");
      expect(document.activeElement).not.toBe(field());
      await waitFor(() => expect(status().textContent).toBe("1 / 3"));
      expect(button("Replace…").disabled).toBe(false);
    });
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
  // Replacing changes the slides, which is Edit mode's.
  beforeEach(() => useApp.setState({ editing: true }));

  it("is off in View, saying where it is on, and closes when the deck goes back to View", async () => {
    found(MATCHES);
    useApp.setState({ editing: false });
    render(<Find />);
    search("hello");
    await waitFor(() => expect(status()).toBeTruthy());
    expect(button("Replace…").disabled).toBe(true);
    expect(button("Replace…").title).toBe("Switch to Edit to change the slides");
    act(() => useApp.setState({ editing: true }));
    fireEvent.click(button("Replace…"));
    expect(screen.getByRole("dialog", { name: "Replace" })).toBeTruthy();
    act(() => useApp.setState({ editing: false }));
    expect(screen.queryByRole("dialog", { name: "Replace" })).toBeNull();
  });

  it("counts what each button would replace, and says what stays for being locked", async () => {
    found(MATCHES);
    await open();
    expect(button(/^Replace on this slide/).textContent).toBe("Replace on this slide (1)");
    expect(button(/^Replace all/).textContent).toBe("Replace all (2)");
    expect(screen.getByTestId("locked-matches").textContent).toBe(
      "1 match is on locked slides, which stay as they are.",
    );
  });

  it("replaces the match in focus and goes on to the next, with Enter too; ⌘Enter replaces all", async () => {
    let left = [match("intro", 0), match("intro", 0), match("outro", 2)];
    const replaced = (count: number): ReplacedText => ({
      deck: DECK,
      count,
      slides: ["intro"],
      skipped: [],
      previous: "<old>",
      source: "<new>",
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "find_in_deck") return left;
      if (cmd === "replace_match_in_deck") {
        left = left.slice(1);
        return replaced(1);
      }
      if (cmd === "replace_in_deck") return replaced(left.length);
      return null;
    });
    await open();
    await waitFor(() => expect(status().textContent).toBe("1 / 3"));
    fireEvent.click(button("Next match"));
    expect(status().textContent).toBe("2 / 3");
    type("Hi");
    fireEvent.click(button("Replace"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("replace_match_in_deck", {
        id: DECK.id,
        query: "hello",
        replacement: "Hi",
        options: { matchCase: false, wholeWord: false },
        slide: "intro",
        nth: 1,
      }),
    );
    // The match after it has its place: the second of the two left, on the last slide.
    await waitFor(() => expect(status().textContent).toBe("2 / 2"));
    expect(useApp.getState().selected).toBe("outro");
    fireEvent.keyDown(screen.getByLabelText("Replace with"), { key: "Enter" });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("replace_match_in_deck", expect.objectContaining({ slide: "outro", nth: 0 })),
    );
    await waitFor(() => expect(status().textContent).toBe("1 / 1"));
    fireEvent.keyDown(screen.getByLabelText("Replace with"), { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("replace_in_deck", expect.objectContaining({ slides: null })),
    );
  });

  it("has no single match to replace on a slide without one, or when it is on a locked slide", async () => {
    found([match("outro", 2, { locked: true }), match("intro", 0)]);
    useApp.setState({ selected: SLIDES[1]! });
    await open();
    expect(button("Replace").disabled).toBe(true);
    expect(button("Replace").title).toBe("Go to a match first");
    fireEvent.click(button("Previous match"));
    expect(useApp.getState().selected).toBe("intro");
    expect(button("Replace").disabled).toBe(false);
    fireEvent.click(button("Previous match"));
    expect(button("Replace").title).toBe("This match is on a locked slide");
  });

  const open = async (query = "hello") => {
    render(<Find />);
    search(query);
    await waitFor(() => expect(status()).toBeTruthy());
    fireEvent.click(button("Replace…"));
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
      if (cmd === "deck_history")
        return { undo: { id: "r", source: "edit", label: "Replace text", time: 0 }, redo: null, current: "r" };
      if (cmd === "undo_deck") return { deck: DECK, entry: null, status: { undo: null, redo: null, current: "o" } };
      return null;
    });
    await open();
    type("Hi");
    await waitFor(() => expect(button(/^Replace all/).disabled).toBe(false));
    fireEvent.click(button(/^Replace on this slide/));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("replace_in_deck", {
        id: DECK.id,
        query: "hello",
        replacement: "Hi",
        options: { matchCase: false, wholeWord: false },
        slides: ["intro"],
      }),
    );
    fireEvent.click(button(/^Replace all/));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("replace_in_deck", expect.objectContaining({ slides: null })),
    );
    await waitFor(() => expect(screen.getByText(/Replaced 2 matches on 2 slides/)).toBeTruthy());
    expect(screen.getByText(/1 locked slide was left as it was/)).toBeTruthy();
    fireEvent.click(button("Undo"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("undo_deck", { id: DECK.id }));
    await waitFor(() => expect(screen.queryByText(/Replaced/)).toBeNull());
  });

  it("cannot replace where only locked slides match, or on a slide without matches", async () => {
    found([MATCHES[2]!]);
    await open();
    expect(button(/^Replace all/).disabled).toBe(true);
    expect(button(/^Replace on this slide/).disabled).toBe(true);
  });

  it("shows a failed replace and keeps the panel open", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "find_in_deck") return MATCHES;
      throw "disk full";
    });
    await open();
    await waitFor(() => expect(button(/^Replace all/).disabled).toBe(false));
    fireEvent.click(button(/^Replace all/));
    await waitFor(() => expect(lastError(useApp.getState())).toBe("disk full"));
    expect(screen.getByRole("dialog", { name: "Replace" })).toBeTruthy();
  });
});
