import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EDIT_TOOL_KEYS } from "../lib/editTools";
import { SECTIONS, ShortcutHelp } from "./ShortcutHelp";

const dialog = () => screen.queryByRole("dialog", { name: "Keyboard shortcuts" });

describe("ShortcutHelp", () => {
  it("opens on ? and lists the edit keys", () => {
    render(<ShortcutHelp />);
    expect(dialog()).toBeNull();
    fireEvent.keyDown(document.body, { key: "?" });
    expect(dialog()).toBeTruthy();
    for (const keys of ["⌘A", "⌘D", "Tab / ⇧Tab", "⌘C / ⌘X / ⌘V", "⌘B / ⌘I / ⌘U", "⇧ Arrows", "With a selection"]) {
      expect(screen.getByText(keys)).toBeTruthy();
    }
  });

  it("lists every tool's key", () => {
    const listed = SECTIONS.find((s) => s.title === "Tools")?.keys.map(([key]) => key.toLowerCase());
    expect(listed?.sort()).toEqual(Object.keys(EDIT_TOOL_KEYS).sort());
  });

  it.each(["input", "textarea", "select"])("stays away while typing in a %s", (tag) => {
    render(<ShortcutHelp />);
    const field = document.createElement(tag);
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: "?" });
    expect(dialog()).toBeNull();
    field.remove();
  });

  it("stays away while typing in contenteditable text, and from shortcuts with ⌘", () => {
    render(<ShortcutHelp />);
    const text = document.createElement("div");
    text.setAttribute("contenteditable", "true");
    document.body.appendChild(text);
    fireEvent.keyDown(text, { key: "?" });
    text.remove();
    fireEvent.keyDown(document.body, { key: "?", metaKey: true });
    expect(dialog()).toBeNull();
  });

  it("opens on ? forwarded by the slide preview, not from elsewhere", () => {
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
    forward({ type: "slop:key", key: "a" }, frame.contentWindow);
    expect(dialog()).toBeNull();
    forward({ type: "slop:key", key: "?" }, frame.contentWindow);
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
      expect(document.activeElement).toBe(dialog());
    };
    const closed = () => {
      expect(dialog()).toBeNull();
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
});
