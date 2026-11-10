// @vitest-environment node
/**
 * The slide editor's source is one script cut into parts (src-tauri/assets/editor/), which
 * src-tauri/build.rs, the tests and the browser preview all join in the order of their names.
 */
import vm from "node:vm";
import { describe, expect, it } from "vitest";

import { editorScript } from "../../dev/browserPreview";
import { EDITOR, EDITOR_PARTS } from "./editorSource";

describe("the slide editor's parts", () => {
  it("are named to sort in the order they run", () => {
    const names = EDITOR_PARTS.map(([name]) => name);
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) expect(name).toMatch(/^\d{2}-[a-z-]+\.js$/);
    expect(new Set(names.map((name) => name.slice(0, 2))).size).toBe(names.length);
    expect([...names].sort()).toEqual(names);
  });

  it("open the editor's closure in the first and close it in the last", () => {
    const first = EDITOR_PARTS[0]![1];
    const last = EDITOR_PARTS.at(-1)![1];
    expect(first.startsWith("/* SlopSlide slide editor.")).toBe(true);
    expect(first.trimEnd().endsWith("(function () {")).toBe(true);
    expect(last.trimEnd().endsWith("})();")).toBe(true);
  });

  it("parse as one script once joined, and only then", () => {
    expect(() => new vm.Script(EDITOR, { filename: "editor.js" })).not.toThrow();
    expect(() => new vm.Script(EDITOR_PARTS[0]![1])).toThrow(SyntaxError);
    expect(() => new vm.Script(EDITOR_PARTS.at(-1)![1])).toThrow(SyntaxError);
  });

  it("each start with a comment saying what they hold", () => {
    for (const [name, source] of EDITOR_PARTS) {
      expect(source.trimStart().slice(0, 2), name).toMatch(/^(\/\*|\/\/)/);
    }
  });

  it("are joined the same way by the browser preview", () => {
    expect(editorScript()).toBe(EDITOR);
  });
});
