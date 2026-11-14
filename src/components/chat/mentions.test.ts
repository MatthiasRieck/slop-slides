import { describe, expect, it } from "vitest";

import { mentionAt, mentionItems, slideLabel, slideName, slideRanges, withoutMention } from "./mentions";

describe("mentionAt", () => {
  it("finds an @ that starts a word, with what was typed after it up to the caret", () => {
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("Look at @mar", 12)).toEqual({ start: 8, query: "mar" });
    expect(mentionAt("Look at @mar and", 12)).toEqual({ start: 8, query: "mar" });
    expect(mentionAt("line\n@3", 7)).toEqual({ start: 5, query: "3" });
  });

  it("finds nothing in an address, after a space, or with the caret elsewhere", () => {
    expect(mentionAt("me@example.com", 14)).toBeNull();
    expect(mentionAt("@mar ", 5)).toBeNull();
    expect(mentionAt("@mar and", 8)).toBeNull();
    expect(mentionAt("no mention", 10)).toBeNull();
  });
});

describe("withoutMention", () => {
  it("takes the mention out, leaving one space between words, the caret where it stood", () => {
    expect(withoutMention("Look at @mar now", { start: 8, query: "mar" }, 12)).toEqual({
      text: "Look at now",
      caret: 8,
    });
    expect(withoutMention("@3", { start: 0, query: "3" }, 2)).toEqual({ text: "", caret: 0 });
  });
});

describe("slide names", () => {
  it("reads an id made of a heading as words, and nothing in an id that says nothing", () => {
    expect(slideName("market-size")).toBe("Market size");
    expect(slideName("teamOverview")).toBe("Team Overview");
    for (const id of ["slide-3", "s4", "7", "a1b2c3d4", "x"]) expect(slideName(id)).toBe("");
    expect(slideLabel(3, "market-size")).toBe("Slide 3 · Market size");
    expect(slideLabel(4, "s4")).toBe("Slide 4");
  });

  it("names numbers as ranges", () => {
    expect(slideRanges([3])).toBe("Slide 3");
    expect(slideRanges([5, 3, 4, 8])).toBe("Slides 3–5, 8");
    expect(slideRanges([1, 2])).toBe("Slides 1, 2");
    expect(slideRanges([])).toBe("");
  });
});

describe("mentionItems", () => {
  const slides = [
    { id: "intro" },
    { id: "market-size" },
    { id: "s3" },
    ...Array.from({ length: 10 }, (_, i) => ({ id: `x${i + 4}` })),
  ];
  const files = ["notes.md", "q3/market.csv", "assets/logo.png"];

  it("lists the slides by number or name, then the files that fit", () => {
    expect(mentionItems("market", slides, files).map((i) => i.label)).toEqual(["Slide 2 · Market size", "market.csv"]);
    const byNumber = mentionItems("1", slides, files)
      .filter((i) => i.kind === "slide")
      .map((i) => i.label);
    expect(byNumber[0]).toBe("Slide 1 · Intro");
    expect(byNumber).toContain("Slide 10");
    expect(mentionItems("slide 3", slides, files).map((i) => i.label)).toEqual(["Slide 3"]);
  });

  it("lists the first slides and files without a query, and says where a file is", () => {
    const items = mentionItems("", slides, files);
    expect(items.filter((i) => i.kind === "slide")).toHaveLength(8);
    expect(items.find((i) => i.kind === "file" && i.label === "market.csv")).toMatchObject({ folder: "q3" });
  });
});
