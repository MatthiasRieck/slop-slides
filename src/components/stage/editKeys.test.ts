import { describe, expect, it } from "vitest";

import { useApp } from "../../store";
import { editShortcut, runEditKey, type ShortcutKey } from "./editKeys";

const key = (key: string, more: Partial<ShortcutKey> = {}): ShortcutKey => ({
  key,
  code: "",
  shiftKey: false,
  altKey: false,
  ...more,
});
const shift = (k: string, code = "") => key(k, { shiftKey: true, code });
const alt = (k: string, code: string) => key(k, { altKey: true, code });

describe("editShortcut", () => {
  it("restacks with ] and [, to the ends with Shift, whatever Shift makes of the key", () => {
    expect(editShortcut(key("]"))).toEqual({ post: { type: "slop:edit-order", to: "forward" } });
    expect(editShortcut(key("["))).toEqual({ post: { type: "slop:edit-order", to: "backward" } });
    expect(editShortcut(shift("}"))).toEqual({ post: { type: "slop:edit-order", to: "front" } });
    expect(editShortcut(shift("{"))).toEqual({ post: { type: "slop:edit-order", to: "back" } });
    expect(editShortcut(shift("x", "BracketRight"))).toEqual({ post: { type: "slop:edit-order", to: "front" } });
  });

  it("aligns text with Shift+L / E / R / J and steps its size with Shift+. and Shift+,", () => {
    const aligned = (k: string) => editShortcut(shift(k));
    expect(aligned("L")).toEqual({ post: { type: "slop:edit-style", style: { align: "left" } } });
    expect(aligned("E")).toEqual({ post: { type: "slop:edit-style", style: { align: "center" } } });
    expect(aligned("R")).toEqual({ post: { type: "slop:edit-style", style: { align: "right" } } });
    expect(aligned("J")).toEqual({ post: { type: "slop:edit-style", style: { align: "justify" } } });
    expect(editShortcut(shift(">"))).toEqual({ post: { type: "slop:edit-font-step", step: 1 } });
    expect(editShortcut(shift("<"))).toEqual({ post: { type: "slop:edit-font-step", step: -1 } });
    expect(editShortcut(shift(";", "Period"))).toEqual({ post: { type: "slop:edit-font-step", step: 1 } });
  });

  it("turns a quarter with Alt+R and strikes text through with Shift+X", () => {
    expect(editShortcut(alt("®", "KeyR"))).toEqual({ post: { type: "slop:edit-rotate", step: 1 } });
    expect(editShortcut(shift("X"))).toEqual({ post: { type: "slop:edit-toggle-style", key: "strike" } });
  });

  it("flips with Alt+Shift+H / V, locks with Alt+L, copies and pastes a look with Alt+C / V, links with K", () => {
    const altShift = (k: string, code: string) => key(k, { altKey: true, shiftKey: true, code });
    expect(editShortcut(altShift("Ó", "KeyH"))).toEqual({ post: { type: "slop:edit-flip", axis: "x" } });
    expect(editShortcut(altShift("◊", "KeyV"))).toEqual({ post: { type: "slop:edit-flip", axis: "y" } });
    // Shift+V alone is pasting as plain text, which the app's paste does; Shift+H is nothing.
    expect(editShortcut(shift("V"))).toBeNull();
    expect(editShortcut(shift("H"))).toBeNull();
    // With Alt, macOS types another character: the key goes by where it is.
    expect(editShortcut(alt("¬", "KeyL"))).toEqual({ lock: true });
    expect(editShortcut(alt("ç", "KeyC"))).toEqual({ post: { type: "slop:edit-copy-style" } });
    expect(editShortcut(alt("√", "KeyV"))).toEqual({ pasteStyle: true });
    expect(editShortcut(key("k"))).toEqual({ panel: "link" });
  });

  it("leaves every other key alone, the app's own shortcuts among them", () => {
    const shell = ["1", "2", "3", "\\", ",", "o", "l", "f", "e", "Enter", "=", "-", "0"];
    for (const k of [...shell, "c", "v", "x", "z", "a", "d", "g", "b", "i", "u"])
      expect(editShortcut(key(k))).toBeNull();
    // ⇧⌘\ and ⇧⌘G / ⇧⌘Z are others' too.
    for (const k of ["|", "G", "Z", "K"]) expect(editShortcut(shift(k))).toBeNull();
    expect(editShortcut(alt("x", "KeyX"))).toBeNull();
    expect(editShortcut(key("L", { altKey: true, shiftKey: true, code: "KeyL" }))).toBeNull();
  });
});

describe("runEditKey", () => {
  it("picks a tool with its letter and puts it away with Escape, which never leaves edit mode", () => {
    useApp.setState({ editing: true, editTool: "select" });
    expect(runEditKey("r")).toBe(true);
    expect(useApp.getState().editTool).toBe("rect");
    expect(runEditKey("Escape")).toBe(true);
    expect(useApp.getState()).toMatchObject({ editTool: "select", editing: true });
    // Nothing left to put away: the key is not taken, and edit mode stays.
    expect(runEditKey("Escape")).toBe(false);
    expect(useApp.getState().editing).toBe(true);
    expect(runEditKey("Enter")).toBe(false);
  });
});
