import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChanges } from "../changesStore";
import { resetEditorState } from "../components/stage/editorState";
import { forgetKeys } from "../lib/commands";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { calls, invoke } from "../test/tauri";
import { MENU_EVENT, MENU_STATE_MS, runMenuCommand, useCommandMenu, windowMenuState } from "./useCommandMenu";
import { useShellKeys } from "./useShellKeys";

/** What the window's frontend was handed to run the menu bar's commands. */
let onMenu: ((event: { payload: string }) => void) | null = null;
const listen = vi.fn(async (_event: string, handler: (event: { payload: string }) => void) => {
  onMenu = handler;
  return () => {
    onMenu = null;
  };
});
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ listen }) }));

const DECK = deckFor(DECK_HTML);
const execCommand = vi.fn(() => true);

beforeEach(() => {
  forgetKeys();
  resetEditorState();
  invoke.mockReset().mockResolvedValue(undefined);
  document.execCommand = execCommand;
  execCommand.mockClear();
  useApp.setState({
    workspace: { path: "/decks/talk", name: "talk" },
    deck: DECK,
    selected: DECK.slides[0]!.id,
    editing: false,
    slideMode: "view",
    presenting: false,
    sidebarOpen: true,
    railOpen: true,
    history: null,
  });
  useChanges.setState({ repository: null });
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** Presses Ctrl and `key` (the command modifier off macOS) on `target`. */
const press = (key: string, more: KeyboardEventInit = {}, target: Element = document.body) =>
  fireEvent.keyDown(target, { key, ctrlKey: true, ...more });

describe("a command chosen in the menu bar", () => {
  beforeEach(() => void renderHook(() => useCommandMenu()));

  it("runs, as a click", () => {
    act(() => runMenuCommand("view.sidebar"));
    expect(useApp.getState().sidebarOpen).toBe(false);
  });

  it("comes in the menu bar's event for this window", async () => {
    await vi.waitFor(() => expect(onMenu).not.toBeNull());
    expect(listen).toHaveBeenCalledWith(MENU_EVENT, expect.any(Function));
    act(() => onMenu!({ payload: "view.rail" }));
    expect(useApp.getState().railOpen).toBe(false);
  });

  it("is not run again when it is the echo of the key the page acted on", () => {
    renderHook(() => useShellKeys());
    press("\\", { code: "Backslash" });
    expect(useApp.getState().sidebarOpen).toBe(false);
    // macOS offers the menu bar the key too: one press, one toggle.
    act(() => runMenuCommand("view.sidebar"));
    expect(useApp.getState().sidebarOpen).toBe(false);
  });

  it("is not run when it is the echo of a key the page left alone", () => {
    // Nothing on the page acts on the key here (as ⌘G is left to a text field): neither does the menu bar.
    press("\\", { code: "Backslash" });
    act(() => runMenuCommand("view.sidebar"));
    expect(useApp.getState().sidebarOpen).toBe(true);
  });

  it("is not run again for a key a slide preview forwarded, which the page acts on", () => {
    renderHook(() => useShellKeys());
    const frame = document.createElement("iframe");
    document.body.append(frame);
    act(
      () =>
        void window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "slop:key", key: "\\", mod: true, shift: false },
            source: frame.contentWindow,
          }),
        ),
    );
    expect(useApp.getState().sidebarOpen).toBe(false);
    act(() => runMenuCommand("view.sidebar"));
    expect(useApp.getState().sidebarOpen).toBe(false);
  });

  it("undoes the typing in the text field that has the focus, not the deck", () => {
    const undo = vi.fn(async () => {});
    useApp.setState({ undo, history: { undo: { label: "Move" } } as never });
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    // ⌘Z in a text field: the page leaves it to the field, the menu bar's Undo is its echo.
    press("z", { code: "KeyZ" }, field);
    act(() => runMenuCommand("edit.undo"));
    expect(execCommand).toHaveBeenCalledWith("undo");
    // Chosen with the pointer, with the field still focused: the same.
    act(() => runMenuCommand("edit.redo"));
    expect(execCommand).toHaveBeenLastCalledWith("redo");
    expect(undo).not.toHaveBeenCalled();
    // Away from the field, the deck's change is undone.
    field.blur();
    act(() => runMenuCommand("edit.undo"));
    expect(undo).toHaveBeenCalledOnce();
  });
});

describe("the menu bar's state", () => {
  const internals = "__TAURI_INTERNALS__";
  beforeEach(() => {
    vi.useFakeTimers();
    (window as unknown as Record<string, unknown>)[internals] = {};
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>)[internals];
    vi.restoreAllMocks();
  });

  const sent = () => calls("set_menu_state").map((args) => args.state as { disabled: string[]; checked: string[] });

  it("is sent once what it shows settles, and again only when it changes", () => {
    renderHook(() => useCommandMenu());
    expect(sent()).toEqual([]);
    act(() => void vi.advanceTimersByTime(MENU_STATE_MS));
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.checked).toContain("view.sidebar");
    expect(sent()[0]!.disabled).toContain("edit.undo");
    // Several changes in a row are told once.
    act(() => {
      useApp.getState().setSidebarOpen(false);
      useApp.getState().setRailOpen(false);
    });
    act(() => void vi.advanceTimersByTime(MENU_STATE_MS));
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.checked).not.toContain("view.sidebar");
    // A change that changes nothing it shows is not told.
    act(() => useApp.setState({ fileRev: 99 }));
    act(() => void vi.advanceTimersByTime(MENU_STATE_MS));
    expect(sent()).toHaveLength(2);
  });

  it("is not sent by a window without the focus, and is sent again as it gets the focus", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    renderHook(() => useCommandMenu());
    act(() => void vi.advanceTimersByTime(MENU_STATE_MS));
    expect(sent()).toEqual([]);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event("focus")));
    act(() => void vi.advanceTimersByTime(MENU_STATE_MS));
    expect(sent()).toHaveLength(1);
  });

  it("keeps Undo and Redo on in a text field, for its own typing", () => {
    expect(windowMenuState().disabled).toContain("edit.undo");
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    expect(windowMenuState().disabled).not.toContain("edit.undo");
    expect(windowMenuState().disabled).not.toContain("edit.redo");
  });
});
