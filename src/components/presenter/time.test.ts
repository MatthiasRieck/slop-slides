import { describe, expect, it } from "vitest";

import type { Slide } from "../../lib/api";
import { formatElapsed, loadBudget, plannedBudget, remaining } from "./time";

describe("formatElapsed", () => {
  it.each([
    [-5, "0:00"],
    [59_999, "0:59"],
    [247_000, "4:07"],
    [3_847_000, "1:04:07"],
    [36_000_000, "10:00:00"],
  ])("formats %d ms as %s", (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });
});

describe("remaining", () => {
  it("counts down the rest and then up past the end", () => {
    expect(remaining(0, 1)).toEqual({ text: "1:00", over: false });
    expect(remaining(59_500, 1)).toEqual({ text: "0:01", over: false });
    expect(remaining(60_000, 1)).toEqual({ text: "0:00", over: false });
    expect(remaining(65_000, 1)).toEqual({ text: "+0:05", over: true });
  });
});

describe("loadBudget", () => {
  it("keeps only sensible times and survives what is not JSON", () => {
    localStorage.setItem("slopslide.presenterBudget", JSON.stringify({ total: 20, perSlide: 1000 }));
    expect(loadBudget()).toEqual({ total: 20, perSlide: 0 });
    localStorage.setItem("slopslide.presenterBudget", "{");
    expect(loadBudget()).toEqual({ total: 0, perSlide: 0 });
  });
});

describe("plannedBudget", () => {
  const slide = (id: string, time?: number) => ({ id, time }) as Slide;
  const shown = [slide("a", 90), slide("b"), slide("c", 30)];

  it("takes the slides' own times first", () => {
    expect(plannedBudget({ total: 0, perSlide: 5 }, shown, shown[0])).toEqual({ total: 2, perSlide: 1.5 });
  });

  it("falls back to the presenter's times", () => {
    expect(plannedBudget({ total: 10, perSlide: 5 }, shown, shown[1])).toEqual({ total: 10, perSlide: 5 });
    expect(plannedBudget({ total: 0, perSlide: 0 }, [], undefined)).toEqual({ total: 0, perSlide: 0 });
  });
});
