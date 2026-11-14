import { describe, expect, it } from "vitest";

import { slideHeading, slideTitle } from "./slideTitle";

describe("slideTitle", () => {
  it("reads a slide's id as words", () => {
    expect(slideTitle("market-size")).toBe("Market size");
    expect(slideTitle("pricing_tiers-2")).toBe("Pricing tiers 2");
    expect(slideTitle("#intro")).toBe("Intro");
  });

  it("has nothing to say of an id without a word in it", () => {
    expect(slideTitle("")).toBe("");
    expect(slideTitle("--")).toBe("");
  });

  it("heads a slide with its number and its title", () => {
    expect(slideHeading(2, "market-size")).toBe("Slide 3 · Market size");
    expect(slideHeading(0, "")).toBe("Slide 1");
  });
});
