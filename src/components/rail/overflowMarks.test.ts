import { describe, expect, it } from "vitest";

import type { Slide } from "../../lib/api";
import { overflowOf, withOverflow } from "./overflowMarks";

const slide = (id: string, hash = id): Slide => ({ id, hash, hidden: false, locked: false, moved: false });

describe("withOverflow", () => {
  it("marks a slide the editor found something overflowing on, with its hash then", () => {
    expect(withOverflow({}, "a", "h1", 2, false)).toEqual({ a: { count: 2, hash: "h1" } });
    const marks = { a: { count: 2, hash: "h1" } };
    expect(withOverflow(marks, "a", "h1", 2, false)).toBe(marks);
  });

  it("drops the mark only when the editor finds none after it found some", () => {
    const marks = { a: { count: 2, hash: "h1" } };
    // An editor that has not measured yet says nothing either way.
    expect(withOverflow(marks, "a", "h1", 0, false)).toBe(marks);
    expect(withOverflow(marks, "a", "h1", 0, true)).toEqual({});
  });
});

describe("overflowOf", () => {
  const marks = { a: { count: 1, hash: "a" }, b: { count: 3, hash: "b" }, c: { count: 1, hash: "c" } };

  it("keeps the marks of slides unchanged, follows the editor's own saves, and forgets the rest", () => {
    const next = overflowOf(marks, [slide("a"), slide("b", "b2"), slide("c", "c2")], { b: "b2" });
    expect(next).toEqual({ a: { count: 1, hash: "a" }, b: { count: 3, hash: "b2" } });
  });

  it("is the same marks when no marked slide changed, and drops deleted ones", () => {
    const slides = [slide("a"), slide("b"), slide("c")];
    expect(overflowOf(marks, slides, {})).toBe(marks);
    expect(overflowOf(marks, [slide("a")], {})).toEqual({ a: { count: 1, hash: "a" } });
  });
});
