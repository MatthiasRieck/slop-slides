import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { EDIT_TOOL_KEYS } from "../lib/editTools";
import { TOOL_KEYS } from "../lib/ink";
import { formatKeys } from "../lib/keys";
import { openShortcutHelp, useApp } from "../store";
import { keysLabel, SECTIONS, ShortcutHelp, TOOL_ROWS } from "./ShortcutHelp";

const dialog = () => screen.queryByRole("dialog", { name: "Keyboard shortcuts" });
const section = (title: string) => SECTIONS.find((s) => s.title === title)!;
/** The single keys a section lists, such as `v` or the four in `{l} / {p} / {h} / {e}`. */
const singleKeys = (rows: [string, string][]) =>
  rows.flatMap(([keys]) => [...keys.matchAll(/\{([a-z])\}/g)].map((m) => m[1]!));

beforeEach(() => useApp.setState({ shortcutHelpOpen: false, presenting: false }));

describe("the shortcuts listed", () => {
  it("writes each row's keys as the platform does, leaving the words between them", () => {
    expect(keysLabel("{mod+c} / {mod+x} / {mod+v}")).toBe("Ctrl+C / Ctrl+X / Ctrl+V");
    expect(keysLabel("{shift} moving")).toBe("Shift moving");
    expect(keysLabel("Double-click a group")).toBe("Double-click a group");
    expect(keysLabel("{mod+shift+z}")).toBe(formatKeys("mod+shift+z"));
  });

  it("groups them by where they work", () => {
    expect(SECTIONS.map((s) => s.title)).toEqual([
      "General",
      "Slides",
      "View",
      "Edit",
      "Text",
      "Lines",
      "Chat",
      "Presenting",
      "HTML and SVG editors",
      "Changes (Git)",
    ]);
  });

  it("lists every edit tool's key, and nothing else as one", () => {
    expect(singleKeys(TOOL_ROWS).sort()).toEqual(Object.keys(EDIT_TOOL_KEYS).sort());
    expect(TOOL_ROWS.every(([keys]) => /^\{[a-z]\}$/.test(keys))).toBe(true);
    expect(section("Edit").rows).toEqual(expect.arrayContaining(TOOL_ROWS));
    expect(singleKeys(section("Edit").rows).sort()).toEqual(Object.keys(EDIT_TOOL_KEYS).sort());
  });

  it("lists every presenting tool's key", () => {
    const listed = singleKeys(section("Presenting").rows);
    for (const key of Object.keys(TOOL_KEYS)) expect(listed).toContain(key);
  });

  it("names each row once in its section, with keys the platform can write", () => {
    for (const { title, rows } of SECTIONS) {
      const keys = rows.map(([row]) => row);
      expect(new Set(keys).size, title).toBe(keys.length);
      for (const [row, what] of rows) {
        expect(what.length, row).toBeGreaterThan(0);
        // A spec left unformatted would show its braces.
        expect(keysLabel(row)).not.toMatch(/[{}]/);
        expect(keysLabel(what)).not.toMatch(/[{}]/);
      }
    }
  });
});

describe("ShortcutHelp", () => {
  it("opens on ? and lists the keys of every part of the app", () => {
    render(<ShortcutHelp />);
    expect(dialog()).toBeNull();
    fireEvent.keyDown(document.body, { key: "?" });
    expect(dialog()).toBeTruthy();
    for (const title of SECTIONS.map((s) => s.title)) expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    for (const keys of [
      "Ctrl+A",
      "Ctrl+D",
      "Tab / Shift+Tab",
      "Ctrl+C / Ctrl+X / Ctrl+V",
      "Ctrl+B / Ctrl+I / Ctrl+U",
    ]) {
      expect(screen.getByText(keys)).toBeTruthy();
    }
    for (const keys of ["Shift+Arrows", "Shift moving", "Alt resizing", "Ctrl+G / Ctrl+Shift+G", "Snapping"]) {
      expect(screen.getByText(keys)).toBeTruthy();
    }
    expect(screen.getByText("Steer: send into the agent's turn now")).toBeTruthy();
  });

  it("opens on the command key and /, even while typing, unless something else took the keys", () => {
    render(
      <>
        <textarea aria-label="Message" />
        <ShortcutHelp />
      </>,
    );
    const field = screen.getByLabelText("Message");
    const taken = new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true });
    taken.preventDefault();
    act(() => void field.dispatchEvent(taken));
    fireEvent.keyDown(field, { key: "/" });
    fireEvent.keyDown(field, { key: "/", ctrlKey: true, altKey: true });
    expect(dialog()).toBeNull();
    const pressed = new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => void field.dispatchEvent(pressed));
    expect(dialog()).toBeTruthy();
    expect(pressed.defaultPrevented).toBe(true);
  });

  it("opens when asked to, by a button say", () => {
    render(<ShortcutHelp />);
    act(() => openShortcutHelp());
    expect(dialog()).toBeTruthy();
  });

  it.each(["input", "textarea", "select"])("stays away while typing in a %s", (tag) => {
    render(<ShortcutHelp />);
    const field = document.createElement(tag);
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: "?" });
    expect(dialog()).toBeNull();
    field.remove();
  });

  it("stays away while typing in contenteditable text, in a menu, and from shortcuts with a modifier", () => {
    render(<ShortcutHelp />);
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
    expect(dialog()).toBeNull();
  });

  it("stays away during a show, whose keys are the show's", () => {
    useApp.setState({ presenting: true });
    render(<ShortcutHelp />);
    fireEvent.keyDown(document.body, { key: "?" });
    expect(dialog()).toBeNull();
  });

  it("opens on ? or the command key and / forwarded by the slide preview, not from elsewhere", () => {
    const { container } = render(
      <>
        <iframe title="slide" />
        <ShortcutHelp />
      </>,
    );
    const frame = container.querySelector("iframe")!;
    const forward = (data: unknown, source: MessageEventSource | null) =>
      act(() => void window.dispatchEvent(new MessageEvent("message", { data, source })));
    forward({ type: "slop:key", key: "?" }, null);
    forward({ type: "slop:key", key: "?", mod: true }, frame.contentWindow);
    forward({ type: "slop:key", key: "/" }, frame.contentWindow);
    forward({ type: "slop:key", key: "a" }, frame.contentWindow);
    expect(dialog()).toBeNull();
    forward({ type: "slop:key", key: "?" }, frame.contentWindow);
    expect(dialog()).toBeTruthy();
    act(() => useApp.getState().setShortcutHelpOpen(false));
    forward({ type: "slop:key", key: "/", mod: true }, frame.contentWindow);
    expect(dialog()).toBeTruthy();
  });

  it("closes on Escape, ?, the close button or the backdrop, and gives focus back", () => {
    render(
      <>
        <button type="button">Before</button>
        <ShortcutHelp />
      </>,
    );
    const before = screen.getByText("Before");
    const open = () => {
      before.focus();
      fireEvent.keyDown(document.body, { key: "?" });
      expect(dialog()!.contains(document.activeElement)).toBe(true);
    };
    const closed = () => {
      expect(dialog()).toBeNull();
      expect(useApp.getState().shortcutHelpOpen).toBe(false);
      expect(document.activeElement).toBe(before);
    };
    open();
    fireEvent.keyDown(dialog()!, { key: "Escape" });
    closed();
    open();
    fireEvent.keyDown(dialog()!, { key: "?" });
    closed();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    closed();
    open();
    fireEvent.pointerDown(screen.getByTestId("shortcut-help-backdrop"));
    closed();
  });

  it("keeps keys pressed in it from the stage", () => {
    render(<ShortcutHelp />);
    fireEvent.keyDown(document.body, { key: "?" });
    let reached = false;
    const listen = () => {
      reached = true;
    };
    window.addEventListener("keydown", listen);
    fireEvent.keyDown(dialog()!, { key: "ArrowRight" });
    window.removeEventListener("keydown", listen);
    expect(reached).toBe(false);
  });

  it("is not left open when the workbench it belongs to goes away", () => {
    const { unmount } = render(<ShortcutHelp />);
    act(() => openShortcutHelp());
    unmount();
    expect(useApp.getState().shortcutHelpOpen).toBe(false);
  });
});
