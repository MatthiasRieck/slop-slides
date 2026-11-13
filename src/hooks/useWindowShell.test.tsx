import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useApp } from "../store";
import { useSvgEditor } from "../svgStore";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { appWindow, ask, calls, invoke, requestClose } from "../test/tauri";
import { confirmWindowClose, useCloseGuard, useWindowTitle, windowTitle } from "./useWindowShell";

const DECK = deckFor(DECK_HTML);
const WORKSPACE = { path: "/decks/talk", name: "talk" };

/** A drawing open in the SVG editor, with changes not accepted when `dirty`. */
const drawing = (dirty: boolean) => ({
  deckId: DECK.id,
  slide: "intro",
  path: [0],
  size: { w: 10, h: 10 },
  color: null,
  vars: {},
  css: "",
  fonts: "",
  ancestors: [],
  original: "<svg></svg>",
  draft: dirty ? "<svg><rect/></svg>" : "<svg></svg>",
  past: [],
  future: [],
  saving: false,
});

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  ask.mockReset();
  useSvgEditor.setState({ edit: null });
  useApp.setState({
    workspace: WORKSPACE,
    deck: DECK,
    chatKey: DECK.id,
    messages: [],
    codeDirty: false,
    running: false,
    chatFollowsDeck: false,
  });
});

/** The questions asked, in order. */
const asked = () => ask.mock.calls.map(([message]) => message as string);

describe("closing the window", () => {
  it("closes without a word when nothing would be lost", async () => {
    expect(await confirmWindowClose()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("closes from the start screen, with nothing open", async () => {
    useApp.setState({ workspace: null, deck: null, chatKey: null });
    expect(await confirmWindowClose()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("asks about unsaved HTML edits, and stays when the user keeps them", async () => {
    useApp.setState({ codeDirty: true });
    ask.mockResolvedValue(false);
    expect(await confirmWindowClose()).toBe(false);
    expect(asked()).toEqual(["You have unsaved changes to deck.html. Discard them?"]);
    ask.mockResolvedValue(true);
    expect(await confirmWindowClose()).toBe(true);
  });

  it("asks about a drawing with changes not accepted, not about one without", async () => {
    useSvgEditor.setState({ edit: drawing(false) });
    expect(await confirmWindowClose()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    useSvgEditor.setState({ edit: drawing(true) });
    ask.mockResolvedValue(false);
    expect(await confirmWindowClose()).toBe(false);
    expect(asked()).toEqual(["The drawing has changes you have not accepted. Discard them?"]);
    // Staying keeps the drawing as it was.
    expect(useSvgEditor.getState().edit?.draft).toBe("<svg><rect/></svg>");
  });

  it("asks about the agent's running turn, and stops it and saves the chat when the user closes anyway", async () => {
    const message = { id: "u1", role: "user" as const, text: "Hi", slide: null, attachments: [], createdAt: 1 };
    useApp.setState({ running: true, messages: [message] });
    ask.mockResolvedValue(false);
    expect(await confirmWindowClose()).toBe(false);
    expect(asked()).toEqual(["The agent is still working in the chat of deck.html. Stop it to close the window?"]);
    expect(calls("interrupt_agent")).toEqual([]);
    ask.mockResolvedValue(true);
    expect(await confirmWindowClose()).toBe(true);
    expect(calls("interrupt_agent")).toEqual([{ id: DECK.id }]);
    expect(calls("save_chat")).toHaveLength(1);
  });

  it("asks about each thing in turn, and stops at the first the user stays for", async () => {
    useApp.setState({ codeDirty: true, running: true });
    useSvgEditor.setState({ edit: drawing(true) });
    ask.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await confirmWindowClose()).toBe(false);
    expect(asked()).toHaveLength(2);
    ask.mockReset().mockResolvedValue(true);
    expect(await confirmWindowClose()).toBe(true);
    expect(asked()).toHaveLength(3);
  });
});

describe("useCloseGuard", () => {
  it("keeps the window open when the user stays, and lets it close otherwise", async () => {
    const { unmount } = renderHook(() => useCloseGuard());
    await act(async () => {});
    expect(appWindow.onCloseRequested).toHaveBeenCalledOnce();
    expect(await requestClose()).toBe(true);
    useApp.setState({ codeDirty: true });
    ask.mockResolvedValue(false);
    expect(await requestClose()).toBe(false);
    ask.mockResolvedValue(true);
    expect(await requestClose()).toBe(true);
    // Gone, it asks nothing more.
    unmount();
    await act(async () => {});
    ask.mockReset().mockResolvedValue(false);
    expect(await requestClose()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("stays open, without asking twice, when closed again while the question is open", async () => {
    renderHook(() => useCloseGuard());
    await act(async () => {});
    useApp.setState({ codeDirty: true });
    let answer: (discard: boolean) => void = () => {};
    ask.mockImplementation(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const first = requestClose();
    await Promise.resolve();
    expect(await requestClose()).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
    answer(true);
    expect(await first).toBe(true);
  });

  it("does without a window to listen to", async () => {
    appWindow.onCloseRequested.mockRejectedValueOnce(new Error("no window"));
    const { unmount } = renderHook(() => useCloseGuard());
    await act(async () => {});
    unmount();
    await act(async () => {});
  });
});

describe("the window's title", () => {
  it("names the deck and its folder, the folder alone, or the app", () => {
    expect(windowTitle("Quarterly review", "talk")).toBe("Quarterly review — talk");
    expect(windowTitle(null, "talk")).toBe("talk");
    expect(windowTitle("", "talk")).toBe("talk");
    expect(windowTitle(null, null)).toBe("SlopSlide");
    expect(windowTitle("Orphan", null)).toBe("SlopSlide");
  });

  it("follows what is open", () => {
    renderHook(() => useWindowTitle());
    expect(appWindow.setTitle).toHaveBeenLastCalledWith("Talk — talk");
    expect(document.title).toBe("Talk — talk");
    act(() => useApp.setState({ deck: { ...DECK, title: "Renamed" } }));
    expect(appWindow.setTitle).toHaveBeenLastCalledWith("Renamed — talk");
    act(() => useApp.setState({ deck: null }));
    expect(appWindow.setTitle).toHaveBeenLastCalledWith("talk");
    act(() => useApp.setState({ workspace: null }));
    expect(appWindow.setTitle).toHaveBeenLastCalledWith("SlopSlide");
    expect(appWindow.setTitle).toHaveBeenCalledTimes(4);
  });

  it("goes on when the window cannot be named", () => {
    appWindow.setTitle.mockRejectedValueOnce(new Error("not allowed"));
    renderHook(() => useWindowTitle());
    expect(document.title).toBe("Talk — talk");
  });
});
