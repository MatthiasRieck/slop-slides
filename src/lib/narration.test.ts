import { describe, expect, it } from "vitest";

import { normalizeNarration, speakingTime, wordCount } from "./narration";

describe("normalizeNarration", () => {
  it("trims line ends and keeps one blank line between paragraphs", () => {
    expect(normalizeNarration("  Hello there \n\n\n\nNext part\r\nsame part  \n")).toBe(
      "Hello there\n\nNext part\nsame part",
    );
    expect(normalizeNarration("- One\n  - Inner")).toBe("- One\n  - Inner");
    expect(normalizeNarration(" \n ")).toBe("");
  });
});

describe("wordCount and speakingTime", () => {
  it("counts words and estimates the time at a speaking pace", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("  one two\nthree ")).toBe(3);
    expect(speakingTime("")).toBe("0:00");
    expect(speakingTime(Array(150).fill("word").join(" "))).toBe("1:00");
    expect(speakingTime(Array(25).fill("word").join(" "))).toBe("0:10");
  });
});
