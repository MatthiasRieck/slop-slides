import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import type { FindMatch, ReplacedText } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { FindButton } from "./FindReplace";

const DECK = deckFor(DECK_HTML);
const MATCHES: FindMatch[] = [
  { slide: "intro", index: 0, locked: false, before: "Say ", text: "Hello", after: " world" },
  { slide: "outro", index: 2, locked: false, before: "", text: "hello", after: " again" },
  { slide: "outro", index: 2, locked: true, before: "and ", text: "hello", after: "" },
];

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const open = () => {
  render(<FindButton />);
  fireEvent.click(button("Find and replace"));
};
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  invoke.mockReset();
  useApp.setState({ deck: DECK, selected: "intro", view: "slides", error: null });
});

describe("find and replace", () => {
  it("finds as you type, with case and whole-word options, and lists where", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "find_in_deck" ? MATCHES : null));
    open();
    expect(screen.getByRole("status").textContent).toMatch(/Searches the text/);
    type("Find", "hello");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("3 matches on 2 slides"));
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
    const list = screen.getByRole("list", { name: "Matches" });
    expect(list.querySelectorAll("mark")).toHaveLength(3);
    expect(list.textContent).toContain("Say Hello world");
    expect(screen.getByLabelText("Locked: it will not change")).toBeTruthy();
    // A match goes to its slide.
    fireEvent.click(within(list).getAllByRole("button")[1]!);
    expect(useApp.getState().selected).toBe("outro");
  });

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
    open();
    type("Find", "hello");
    type("Replace with", "Hi");
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
    invoke.mockImplementation(async (cmd: string) => (cmd === "find_in_deck" ? [MATCHES[2]] : null));
    open();
    type("Find", "hello");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("1 match on 1 slide"));
    expect(button("Replace all").disabled).toBe(true);
    expect(button("Replace on this slide").disabled).toBe(true);
  });

  it("shows a failed replace and keeps the panel open", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "find_in_deck") return MATCHES;
      throw "disk full";
    });
    open();
    type("Find", "hello");
    await waitFor(() => expect(button("Replace all").disabled).toBe(false));
    fireEvent.click(button("Replace all"));
    await waitFor(() => expect(useApp.getState().error).toBe("disk full"));
    expect(screen.getByRole("dialog", { name: "Find and replace" })).toBeTruthy();
  });

  it("opens with ⌘F, in the app or in the slide, but leaves the HTML view its own search", () => {
    render(<FindButton />);
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Find and replace" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    act(
      () => void window.dispatchEvent(new MessageEvent("message", { data: { type: "slop:key", key: "f", mod: true } })),
    );
    expect(screen.getByRole("dialog", { name: "Find and replace" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => useApp.setState({ view: "code" }));
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
