import { fireEvent, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useApp } from "../../store";
import { useChatShortcut } from "./useChatShortcut";

beforeEach(() => {
  useApp.getState().setSidebarTab("files");
  useApp.getState().setSidebarOpen(false);
  useApp.setState({ presenting: false });
});

const asked = () => useApp.getState().composerFocus;
/** A key a slide preview forwards, as its runtime posts it. */
const forwarded = (data: Record<string, unknown>) =>
  fireEvent(window, new MessageEvent("message", { data: { type: "slop:key", ...data } }));

describe("useChatShortcut", () => {
  it("goes to the chat and its message input with Ctrl+L, from anywhere", () => {
    renderHook(() => useChatShortcut());
    const before = asked();
    const field = document.createElement("input");
    document.body.append(field);
    try {
      // Typing elsewhere does not keep the key: it is how to get to the chat from there.
      expect(fireEvent.keyDown(field, { key: "l", ctrlKey: true })).toBe(false);
    } finally {
      field.remove();
    }
    expect(useApp.getState()).toMatchObject({ sidebarOpen: true, sidebarTab: "chat" });
    expect(asked()).toBe(before + 1);
    fireEvent.keyDown(window, { key: "L", ctrlKey: true });
    expect(asked()).toBe(before + 2);
  });

  it("works from a slide preview, which forwards its keys", () => {
    renderHook(() => useChatShortcut());
    const before = asked();
    forwarded({ key: "l", mod: true, shift: false });
    expect(useApp.getState()).toMatchObject({ sidebarOpen: true, sidebarTab: "chat" });
    expect(asked()).toBe(before + 1);
    forwarded({ key: "l", mod: false, shift: false });
    forwarded({ key: "l", mod: true, shift: true });
    forwarded({ key: "k", mod: true, shift: false });
    expect(asked()).toBe(before + 1);
  });

  it("leaves other keys alone: a plain L, and the editor's Shift and Alt combinations", () => {
    renderHook(() => useChatShortcut());
    const before = asked();
    expect(fireEvent.keyDown(window, { key: "l" })).toBe(true);
    fireEvent.keyDown(window, { key: "l", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(asked()).toBe(before);
    expect(useApp.getState().sidebarOpen).toBe(false);
  });

  it("does nothing during a slide show, or once it is gone", () => {
    const { unmount } = renderHook(() => useChatShortcut());
    const before = asked();
    useApp.setState({ presenting: true });
    fireEvent.keyDown(window, { key: "l", ctrlKey: true });
    forwarded({ key: "l", mod: true, shift: false });
    useApp.setState({ presenting: false });
    unmount();
    fireEvent.keyDown(window, { key: "l", ctrlKey: true });
    expect(asked()).toBe(before);
  });
});
