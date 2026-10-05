import { describe, expect, it } from "vitest";

import { changedRange, normalizeNewlines, onDiskRead } from "./codeSync";

const apply = (text: string, change: { from: number; to: number; insert: string } | null) =>
  change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : text;

describe("changedRange", () => {
  it("returns null for identical text", () => {
    expect(changedRange("abc", "abc")).toBeNull();
    expect(changedRange("", "")).toBeNull();
  });

  it.each([
    ["insertion in the middle", "hello world", "hello brave world", { from: 6, to: 6, insert: "brave " }],
    ["deletion in the middle", "hello brave world", "hello world", { from: 6, to: 12, insert: "" }],
    ["replacement", "<p>old</p>", "<p>new</p>", { from: 3, to: 6, insert: "new" }],
    ["append", "abc", "abcdef", { from: 3, to: 3, insert: "def" }],
    ["prepend", "def", "abcdef", { from: 0, to: 0, insert: "abc" }],
    ["from empty", "", "abc", { from: 0, to: 0, insert: "abc" }],
    ["to empty", "abc", "", { from: 0, to: 3, insert: "" }],
  ])("%s", (_, current, next, expected) => {
    expect(changedRange(current, next)).toEqual(expected);
  });

  it("does not let prefix and suffix overlap on repeated characters", () => {
    // "aaa" -> "aaaa": a naive prefix+suffix scan would claim more than the text holds.
    const change = changedRange("aaa", "aaaa");
    expect(change).toEqual({ from: 3, to: 3, insert: "a" });
    expect(apply("aaa", change)).toBe("aaaa");
    expect(apply("aaaa", changedRange("aaaa", "aa"))).toBe("aa");
  });

  it("always produces a change that turns current into next", () => {
    // Deterministic pseudo-random edits over an HTML-ish alphabet.
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const alphabet = "<>/ abc\n\"=é👋";
    const word = (len: number) => Array.from({ length: len }, () => alphabet[rand(alphabet.length)]).join("");
    for (let i = 0; i < 500; i++) {
      const current = word(rand(30));
      const at = rand(current.length + 1);
      const cut = rand(current.length - at + 1);
      const next = current.slice(0, at) + word(rand(6)) + current.slice(at + cut);
      expect(apply(current, changedRange(current, next))).toBe(next);
    }
  });

  it("keeps the change local so the editor's scroll position survives", () => {
    const doc = Array.from({ length: 1000 }, (_, i) => `<p>line ${i}</p>`).join("\n");
    const next = doc.replace("<p>line 500</p>", "<p>line 500 edited</p>");
    const change = changedRange(doc, next)!;
    expect(change.insert).toBe(" edited");
    expect(change.to - change.from).toBe(0);
  });
});

describe("onDiskRead", () => {
  it("loads disk text when there are no unsaved edits", () => {
    expect(onDiskRead({ doc: "v1", baseline: "v1", disk: "v2" })).toBe("load");
  });

  it("loads on first read (empty editor, empty baseline)", () => {
    expect(onDiskRead({ doc: "", baseline: "", disk: "<html>" })).toBe("load");
  });

  it("loads when disk already matches the edits (our own save came back)", () => {
    expect(onDiskRead({ doc: "mine", baseline: "v1", disk: "mine" })).toBe("load");
  });

  it("keeps unsaved edits when disk has not moved", () => {
    expect(onDiskRead({ doc: "mine", baseline: "v1", disk: "v1" })).toBe("keep");
  });

  it("reports a conflict when disk changed under unsaved edits", () => {
    expect(onDiskRead({ doc: "mine", baseline: "v1", disk: "agent" })).toBe("conflict");
  });
});

describe("normalizeNewlines", () => {
  it.each([
    ["a\r\nb", "a\nb"],
    ["a\rb", "a\nb"],
    ["a\r\n\r\nb\r", "a\n\nb\n"],
    ["a\nb", "a\nb"],
    ["", ""],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeNewlines(input)).toBe(expected);
  });
});
