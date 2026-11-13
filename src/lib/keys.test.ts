import { describe, expect, it } from "vitest";

import { formatKeys, isMod, isTextField, isTypingTarget, keepsKey } from "./keys";
import { isMac } from "./utils";

describe("isMod", () => {
  it("is ⌘ on macOS and Ctrl elsewhere", () => {
    expect(isMod({ metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(isMod({ metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(isMod({ metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(isMod({ metaKey: true, ctrlKey: false }, false)).toBe(false);
  });

  it("follows the platform the tests run as, which is not macOS", () => {
    // jsdom's user agent names no Mac, whatever machine runs the tests.
    expect(isMac).toBe(false);
    expect(isMod(new KeyboardEvent("keydown", { ctrlKey: true }))).toBe(true);
    expect(isMod(new KeyboardEvent("keydown", { metaKey: true }))).toBe(false);
  });
});

describe("formatKeys", () => {
  it.each([
    ["mod+shift+z", "⇧⌘Z", "Ctrl+Shift+Z"],
    ["shift+mod+z", "⇧⌘Z", "Ctrl+Shift+Z"],
    ["mod+g", "⌘G", "Ctrl+G"],
    ["mod+alt+c", "⌥⌘C", "Ctrl+Alt+C"],
    ["ctrl+mod+f", "⌃⌘F", "Ctrl+F"],
    ["mod+enter", "⌘↵", "Ctrl+Enter"],
    ["shift+enter", "⇧↵", "Shift+Enter"],
    ["backspace", "⌫", "Backspace"],
    ["delete", "⌦", "Delete"],
    ["escape", "Esc", "Esc"],
    ["mod+up", "⌘↑", "Ctrl+↑"],
    ["down", "↓", "↓"],
    ["left", "←", "←"],
    ["right", "→", "→"],
    ["shift+arrows", "⇧Arrows", "Shift+Arrows"],
    ["space", "Space", "Space"],
    ["shift+tab", "⇧Tab", "Shift+Tab"],
    ["mod+/", "⌘/", "Ctrl+/"],
    ["?", "?", "?"],
    ["0", "0", "0"],
    ["v", "V", "V"],
    ["f5", "F5", "F5"],
    ["mod+plus", "⌘+", "Ctrl++"],
    ["shift", "⇧", "Shift"],
    ["mod", "⌘", "Ctrl"],
    ["Mod + Shift + Z", "⇧⌘Z", "Ctrl+Shift+Z"],
  ])("writes %s as %s on macOS and %s elsewhere", (spec, mac, other) => {
    expect(formatKeys(spec, true)).toBe(mac);
    expect(formatKeys(spec, false)).toBe(other);
  });

  it("writes for the platform it runs on by default", () => {
    expect(formatKeys("mod+z")).toBe("Ctrl+Z");
  });
});

/** `html` in the page, and the element in it marked `data-target`. */
function target(html: string): Element {
  document.body.innerHTML = html;
  return document.querySelector("[data-target]")!;
}

describe("isTypingTarget", () => {
  it.each([
    "<input data-target>",
    "<textarea data-target></textarea>",
    "<select data-target></select>",
    '<div contenteditable="true"><b data-target>text</b></div>',
    '<div role="slider" data-target></div>',
    '<div role="menu"><button data-target>Item</button></div>',
    '<div role="dialog"><button data-target>Close</button></div>',
    '<div role="tree"><div role="treeitem" data-target></div></div>',
    '<div role="tablist"><button role="tab" data-target>Tab</button></div>',
    '<ul role="listbox"><li role="option" data-target></li></ul>',
  ])("is true in %s", (html) => {
    expect(isTypingTarget(target(html))).toBe(true);
  });

  it.each([
    "<button data-target>Go</button>",
    "<div data-target></div>",
    '<div role="toolbar"><button data-target>Go</button></div>',
  ])("is false in %s", (html) => {
    expect(isTypingTarget(target(html))).toBe(false);
  });

  it("is false for what is no element", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
    expect(isTypingTarget(document)).toBe(false);
  });
});

describe("isTextField", () => {
  it("is true where text is typed, and false in the widgets that only move with the keys", () => {
    expect(isTextField(target("<input data-target>"))).toBe(true);
    expect(isTextField(target("<div contenteditable><i data-target>x</i></div>"))).toBe(true);
    expect(isTextField(target('<div role="tablist"><button data-target>Tab</button></div>'))).toBe(false);
    expect(isTextField(target('<div role="dialog"><button data-target>Close</button></div>'))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});

describe("keepsKey", () => {
  /** A key pressed on `element`, as a listener on the window sees it. */
  function pressed(element: Element, init: KeyboardEventInit): KeyboardEvent {
    let seen: KeyboardEvent | undefined;
    const listen = (event: KeyboardEvent) => {
      seen = event;
    };
    window.addEventListener("keydown", listen);
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
    window.removeEventListener("keydown", listen);
    return seen!;
  }

  it("leaves every key to a text field", () => {
    const field = target("<input data-target>");
    expect(keepsKey(pressed(field, { key: "ArrowLeft" }))).toBe(true);
    expect(keepsKey(pressed(field, { key: "z", metaKey: true }))).toBe(true);
    expect(keepsKey(pressed(field, { key: "z", ctrlKey: true }))).toBe(true);
  });

  it("leaves plain keys to a widget, not the shortcuts with a modifier", () => {
    const tab = target('<div role="tablist"><button role="tab" data-target>Tab</button></div>');
    expect(keepsKey(pressed(tab, { key: "ArrowLeft" }))).toBe(true);
    expect(keepsKey(pressed(tab, { key: "z", metaKey: true }))).toBe(false);
    expect(keepsKey(pressed(tab, { key: "z", ctrlKey: true }))).toBe(false);
  });

  it("keeps nothing pressed elsewhere", () => {
    const button = target("<button data-target>Go</button>");
    expect(keepsKey(pressed(button, { key: "ArrowLeft" }))).toBe(false);
    expect(keepsKey(pressed(button, { key: "z", metaKey: true }))).toBe(false);
  });
});
