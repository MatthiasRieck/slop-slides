import { describe, expect, it } from "vitest";

import { type TextPart, wordDiff } from "./textDiff";

/** The parts as text, the changed ones in brackets. */
const shown = (parts: TextPart[]) => parts.map((part) => (part.changed ? `[${part.text}]` : part.text)).join("");

describe("wordDiff", () => {
  it("marks the one word that changed", () => {
    const diff = wordDiff("Basic plan: $10 a month", "Basic plan: $12 a month");
    expect(shown(diff.before)).toBe("Basic plan: [$10] a month");
    expect(shown(diff.after)).toBe("Basic plan: [$12] a month");
  });

  it("marks words that were added or taken out on their side only", () => {
    const diff = wordDiff("Ship it today", "Ship it");
    expect(shown(diff.before)).toBe("Ship it[ today]");
    expect(shown(diff.after)).toBe("Ship it");
    expect(shown(wordDiff("Ship it", "Do not ship it").after)).toBe("[Do not ship] it");
  });

  it("marks reworded words next to each other as one stretch", () => {
    const diff = wordDiff("We grew fast last year", "We shrank a lot last year");
    expect(shown(diff.before)).toBe("We [grew fast] last year");
    expect(shown(diff.after)).toBe("We [shrank a lot] last year");
  });

  it("marks everything of a text that is new or gone", () => {
    expect(wordDiff("", "A new line")).toEqual({ before: [], after: [{ text: "A new line", changed: true }] });
    expect(wordDiff("An old line", "")).toEqual({ before: [{ text: "An old line", changed: true }], after: [] });
  });

  it("marks nothing in texts that are the same", () => {
    expect(wordDiff("Same text", "Same text")).toEqual({
      before: [{ text: "Same text", changed: false }],
      after: [{ text: "Same text", changed: false }],
    });
  });

  it("keeps the lines of a text", () => {
    const diff = wordDiff("One\nTwo", "One\nThree");
    expect(diff.after.map((part) => part.text).join("")).toBe("One\nThree");
    expect(shown(diff.after)).toBe("One\n[Three]");
  });

  it("compares only the ends of very long texts, and still gives all of both back", () => {
    const long = (word: string) => `Start ${Array.from({ length: 600 }, (_, n) => `${word}${n}`).join(" ")} end`;
    const diff = wordDiff(long("a"), long("b"));
    expect(diff.before[0]).toEqual({ text: "Start ", changed: false });
    expect(diff.before.at(-1)).toEqual({ text: " end", changed: false });
    expect(diff.before.map((part) => part.text).join("")).toBe(long("a"));
    expect(diff.after.map((part) => part.text).join("")).toBe(long("b"));
    expect(diff.before).toHaveLength(3);
  });
});
