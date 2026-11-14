// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Slide } from "./api";
import {
  describeGeneration,
  formatDuration,
  generationSize,
  narrationMark,
  normalizeNarration,
  slidesToScriptFromNotes,
  speakingTime,
  wordCount,
} from "./narration";

const slide = (id: string, more: Partial<Slide> = {}): Slide => ({
  id,
  hash: id,
  hidden: false,
  locked: false,
  moved: false,
  ...more,
});

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

describe("formatDuration", () => {
  it.each([
    [0, "0:00"],
    [12.4, "0:12"],
    [59.6, "1:00"],
    [754, "12:34"],
  ])("shows %s seconds as %s", (seconds, shown) => {
    expect(formatDuration(seconds)).toBe(shown);
  });
});

describe("narrationMark", () => {
  it("says what a slide has of narration", () => {
    expect(narrationMark(slide("a"), undefined)).toBe("none");
    expect(narrationMark(slide("a", { narration: "Hi." }), undefined)).toBe("script");
    expect(narrationMark(slide("a", { narration: "Hi." }), { slide: "a", state: "missing", seconds: null })).toBe(
      "script",
    );
    expect(narrationMark(slide("a", { narration: "Hi." }), { slide: "a", state: "ready", seconds: 1 })).toBe("ready");
    expect(narrationMark(slide("a", { narration: "Hi." }), { slide: "a", state: "stale", seconds: 1 })).toBe("stale");
    // A recording is the slide's audio whatever its script says.
    expect(narrationMark(slide("a"), { slide: "a", state: "ready", seconds: 1, recorded: true })).toBe("recorded");
  });
});

describe("generationSize", () => {
  it("counts what would go to the service: the said text of missing and stale audio only", () => {
    const slides = [
      slide("a", { narration: "**One** two." }),
      slide("b", { narration: "Three four five six." }),
      slide("c", { narration: "Kept." }),
      slide("d"),
    ];
    const size = generationSize(slides, {
      a: { slide: "a", state: "missing", seconds: null },
      b: { slide: "b", state: "stale", seconds: 2 },
      c: { slide: "c", state: "ready", seconds: 1 },
    });
    expect([size.slides, size.characters]).toEqual([2, 28]);
    expect(size.seconds).toBeCloseTo(2.4);
    expect(describeGeneration(size)).toBe("2 slides, 28 characters, about 0:02 of audio");
    expect(describeGeneration({ slides: 1, characters: 2140, seconds: 140 })).toBe(
      "1 slide, 2,140 characters, about 2:20 of audio",
    );
  });
});

describe("slidesToScriptFromNotes", () => {
  it("takes the slides with notes, no script, and no lock", () => {
    const slides = [
      slide("a", { notes: "N" }),
      slide("b", { notes: "N", narration: "Mine." }),
      slide("c", { notes: "N", locked: true }),
      slide("d", { notes: "  " }),
    ];
    expect(slidesToScriptFromNotes(slides).map((s) => s.id)).toEqual(["a"]);
  });
});
