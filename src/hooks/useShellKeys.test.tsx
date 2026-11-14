import { act, fireEvent, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useChanges } from "../changesStore";
import { deckMode, useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke, open as openDialog } from "../test/tauri";
import { runShellCommand, useShellKeys } from "./useShellKeys";

const DECK = deckFor(DECK_HTML);

beforeEach(() => {
  invoke.mockReset();
  openDialog.mockReset().mockResolvedValue(null);
  localStorage.clear();
  useApp.setState({
    workspace: { path: "/decks/talk", name: "talk" },
    deck: DECK,
    editing: false,
    slideMode: "view",
    presenting: false,
    sidebarOpen: true,
    sidebarTab: "chat",
    sidebarTabs: ["chat", "files"],
    railOpen: true,
  });
  useChanges.setState({ repository: null });
});

/** Presses a key with Ctrl (the command modifier off macOS) on `target`; true when the app took it. */
const press = (key: string, more: KeyboardEventInit = {}, target: Element = document.body) =>
  !fireEvent.keyDown(target, { key, ctrlKey: true, ...more });

describe("useShellKeys", () => {
  beforeEach(() => void renderHook(() => useShellKeys()));

  it("goes to View and Edit on Ctrl+1 and Ctrl+2", () => {
    expect(press("2")).toBe(true);
    expect(deckMode(useApp.getState())).toBe("edit");
    expect(press("1")).toBe(true);
    expect(deckMode(useApp.getState())).toBe("view");
  });

  it("goes to Git on Ctrl+3 only for a deck in a repository", () => {
    expect(press("3")).toBe(false);
    expect(deckMode(useApp.getState())).toBe("view");
    useChanges.setState({ repository: DECK.id });
    expect(press("3")).toBe(true);
    expect(deckMode(useApp.getState())).toBe("git");
    // Another deck's repository is not this one's.
    useApp.getState().setMode("view");
    useChanges.setState({ repository: "/other/deck.html" });
    expect(press("3")).toBe(false);
  });

  it("leaves the deck's settings for a mode", () => {
    useApp.getState().openDeckSettings();
    expect(press("2")).toBe(true);
    expect(deckMode(useApp.getState())).toBe("edit");
  });

  it("shows and hides the sidebar on Ctrl+\\, and the slide list on Ctrl+Shift+\\", () => {
    expect(press("\\", { code: "Backslash" })).toBe(true);
    expect(useApp.getState().sidebarOpen).toBe(false);
    press("\\", { code: "Backslash" });
    expect(useApp.getState().sidebarOpen).toBe(true);
    expect(useApp.getState().railOpen).toBe(true);
    expect(press("|", { code: "Backslash", shiftKey: true })).toBe(true);
    expect(useApp.getState().railOpen).toBe(false);
    press("|", { code: "Backslash", shiftKey: true });
    expect(useApp.getState().railOpen).toBe(true);
  });

  it("opens the app's settings on Ctrl+,", () => {
    useApp.setState({ sidebarOpen: false });
    expect(press(",")).toBe(true);
    expect(useApp.getState()).toMatchObject({ sidebarOpen: true, sidebarTab: "settings" });
  });

  it("asks for a folder to open on Ctrl+O", async () => {
    await act(async () => void press("o"));
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
  });

  it("has no modes or slide list without a deck, but still the sidebar", () => {
    useApp.setState({ deck: null });
    expect(press("1")).toBe(false);
    expect(press("2")).toBe(false);
    expect(press("|", { shiftKey: true })).toBe(false);
    expect(useApp.getState().railOpen).toBe(true);
    expect(press("\\")).toBe(true);
    expect(useApp.getState().sidebarOpen).toBe(false);
  });

  it("leaves the keys to the show while presenting", () => {
    useApp.setState({ presenting: true });
    expect(press("2")).toBe(false);
    expect(press("\\")).toBe(false);
    expect(press(",")).toBe(false);
    expect(useApp.getState()).toMatchObject({ editing: false, sidebarOpen: true, sidebarTab: "chat" });
  });

  it("works while typing, as in the chat's composer", () => {
    const composer = document.createElement("textarea");
    document.body.append(composer);
    expect(press("\\", {}, composer)).toBe(true);
    expect(useApp.getState().sidebarOpen).toBe(false);
    expect(press("2", {}, composer)).toBe(true);
    expect(deckMode(useApp.getState())).toBe("edit");
    composer.remove();
  });

  it("leaves a key to the field that took it, as the model menu does Ctrl+1 to Ctrl+9", () => {
    const field = document.createElement("input");
    field.addEventListener("keydown", (event) => event.preventDefault());
    document.body.append(field);
    fireEvent.keyDown(field, { key: "2", ctrlKey: true });
    expect(deckMode(useApp.getState())).toBe("view");
    field.remove();
  });

  it("takes no key without the modifier, or with Alt as well", () => {
    expect(fireEvent.keyDown(document.body, { key: "1" })).toBe(true);
    expect(press("1", { altKey: true })).toBe(false);
    expect(press("o", { shiftKey: true })).toBe(false);
    expect(deckMode(useApp.getState())).toBe("view");
  });

  describe("pressed in a slide preview, which forwards its keys", () => {
    const fromFrame = (data: object, source: Window | null) =>
      act(() => void window.dispatchEvent(new MessageEvent("message", { data, source })));

    it("does the same", () => {
      const frame = document.createElement("iframe");
      document.body.append(frame);
      fromFrame({ type: "slop:key", key: "2", mod: true, shift: false }, frame.contentWindow);
      expect(deckMode(useApp.getState())).toBe("edit");
      fromFrame({ type: "slop:key", key: "|", mod: true, shift: true }, frame.contentWindow);
      expect(useApp.getState().railOpen).toBe(false);
      // Without the modifier it is the slide's own key.
      fromFrame({ type: "slop:key", key: "1", mod: false, shift: false }, frame.contentWindow);
      expect(deckMode(useApp.getState())).toBe("edit");
      frame.remove();
    });

    it("takes no key from anything that is not one of its previews", () => {
      fromFrame({ type: "slop:key", key: "2", mod: true, shift: false }, window);
      fromFrame({ type: "slop:other", key: "2", mod: true }, window);
      expect(deckMode(useApp.getState())).toBe("view");
    });
  });
});

describe("the shell's keys, gone with what mounted them", () => {
  it("do nothing any more", () => {
    const { unmount } = renderHook(() => useShellKeys());
    unmount();
    expect(press("2")).toBe(false);
    expect(deckMode(useApp.getState())).toBe("view");
  });
});

describe("runShellCommand", () => {
  it("opens nothing in the sidebar on the start screen, but still asks for a folder", () => {
    useApp.setState({ workspace: null, deck: null });
    expect(runShellCommand("sidebar")).toBe(false);
    expect(runShellCommand("appSettings")).toBe(false);
    expect(runShellCommand("openFolder")).toBe(true);
    expect(openDialog).toHaveBeenCalledOnce();
  });
});
