import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useApp } from "../../store";
import { useSettingsKeys } from "./useSettingsKeys";

const section = () => useApp.getState().settingsSection;

beforeEach(() => useApp.setState({ settingsSection: null, presenting: false }));

/** Something on the page that uses the keys, as the window does. */
function Keys() {
  useSettingsKeys();
  return null;
}

describe("useSettingsKeys", () => {
  it("opens the settings on the keyboard shortcuts on ?", () => {
    renderHook(() => useSettingsKeys());
    expect(section()).toBeNull();
    fireEvent.keyDown(document.body, { key: "?" });
    expect(section()).toBe("keyboard");
  });

  it("opens them on the command key and /, even while typing, unless something else took the keys", () => {
    const { getByLabelText } = render(
      <>
        <textarea aria-label="Message" />
        <Keys />
      </>,
    );
    const field = getByLabelText("Message");
    const taken = new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true });
    taken.preventDefault();
    act(() => void field.dispatchEvent(taken));
    fireEvent.keyDown(field, { key: "/" });
    fireEvent.keyDown(field, { key: "/", ctrlKey: true, altKey: true });
    expect(section()).toBeNull();
    const pressed = new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => void field.dispatchEvent(pressed));
    expect(section()).toBe("keyboard");
    expect(pressed.defaultPrevented).toBe(true);
  });

  it.each(["input", "textarea", "select"])("stays away while typing in a %s", (tag) => {
    renderHook(() => useSettingsKeys());
    const field = document.createElement(tag);
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: "?" });
    expect(section()).toBeNull();
    field.remove();
  });

  it("stays away while typing in contenteditable text, in a menu, and from shortcuts with a modifier", () => {
    renderHook(() => useSettingsKeys());
    const text = document.createElement("div");
    text.setAttribute("contenteditable", "true");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(text, menu);
    fireEvent.keyDown(text, { key: "?" });
    fireEvent.keyDown(menu, { key: "?" });
    text.remove();
    menu.remove();
    fireEvent.keyDown(document.body, { key: "?", metaKey: true });
    fireEvent.keyDown(document.body, { key: "?", ctrlKey: true });
    expect(section()).toBeNull();
  });

  it("stays away during a show, whose keys are the show's", () => {
    useApp.setState({ presenting: true });
    renderHook(() => useSettingsKeys());
    fireEvent.keyDown(document.body, { key: "?" });
    fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
    expect(section()).toBeNull();
  });

  it("opens on ? or the command key and / forwarded by the slide preview, not from elsewhere", () => {
    const { container } = render(
      <>
        <iframe title="slide" />
        <Keys />
      </>,
    );
    const frame = container.querySelector("iframe")!;
    const forward = (data: unknown, source: MessageEventSource | null) =>
      act(() => void window.dispatchEvent(new MessageEvent("message", { data, source })));
    forward({ type: "slop:key", key: "?" }, null);
    forward({ type: "slop:key", key: "?", mod: true }, frame.contentWindow);
    forward({ type: "slop:key", key: "/" }, frame.contentWindow);
    forward({ type: "slop:key", key: "a" }, frame.contentWindow);
    expect(section()).toBeNull();
    forward({ type: "slop:key", key: "?" }, frame.contentWindow);
    expect(section()).toBe("keyboard");
    act(() => useApp.getState().closeSettings());
    forward({ type: "slop:key", key: "/", mod: true }, frame.contentWindow);
    expect(section()).toBe("keyboard");
  });

  it("goes to the shortcuts from another section of the open settings", () => {
    renderHook(() => useSettingsKeys());
    act(() => useApp.getState().openSettings("general"));
    fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
    expect(section()).toBe("keyboard");
  });

  it("does nothing once what used it is gone", () => {
    const { unmount } = renderHook(() => useSettingsKeys());
    unmount();
    fireEvent.keyDown(document.body, { key: "?" });
    expect(section()).toBeNull();
  });
});
