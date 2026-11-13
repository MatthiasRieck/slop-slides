// @vitest-environment node
import { describe, expect, it } from "vitest";

import { slideNumber, slideNumbers } from "./slideNumbers";

describe("slideNumbers", () => {
  const slides = [{ id: "intro" }, { id: "body" }, { id: "outro" }];

  it("numbers the slides from 1, by their ids", () => {
    expect(Object.fromEntries(slideNumbers(slides))).toEqual({ intro: 1, body: 2, outro: 3 });
  });

  it("numbers a list once, and another list again", () => {
    expect(slideNumbers(slides)).toBe(slideNumbers(slides));
    expect(slideNumbers([...slides])).not.toBe(slideNumbers(slides));
  });

  it("means the first of two slides with one id", () => {
    expect(slideNumbers([{ id: "a" }, { id: "b" }, { id: "a" }]).get("a")).toBe(1);
  });

  it("gives a slide's number, and 0 without a deck, an id or such a slide", () => {
    expect(slideNumber({ slides }, "body")).toBe(2);
    expect(slideNumber({ slides }, "gone")).toBe(0);
    expect(slideNumber({ slides }, null)).toBe(0);
    expect(slideNumber(null, "body")).toBe(0);
  });
});
