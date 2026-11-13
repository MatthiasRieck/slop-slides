import { describe, expect, it } from "vitest";

import type { Slide } from "../../lib/api";
import {
  budgetSources,
  formatClock,
  formatElapsed,
  loadBudget,
  pauseWatch,
  plannedBudget,
  remaining,
  resumeWatch,
  startWatch,
  watchTime,
} from "./time";

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

describe("budgetSources", () => {
  const slide = (time?: number) => ({ time }) as Slide;

  it("says where a time counted down comes from when the presenter set none", () => {
    const shown = [slide(90), slide(60), slide()];
    expect(budgetSources({ total: 0, perSlide: 0 }, shown, shown[0])).toEqual({
      total: "2:30 from slide times",
      perSlide: "1:30 from this slide's time",
    });
  });

  it("says nothing where the presenter's own time counts, or none does", () => {
    const shown = [slide(90), slide()];
    expect(budgetSources({ total: 20, perSlide: 2 }, shown, shown[1])).toEqual({ total: null, perSlide: null });
    expect(budgetSources({ total: 0, perSlide: 0 }, [slide()], undefined)).toEqual({ total: null, perSlide: null });
  });
});

describe("a stopwatch", () => {
  it("counts from when it started", () => {
    const watch = startWatch(1000);
    expect(watchTime(watch, 1000)).toBe(0);
    expect(watchTime(watch, 4500)).toBe(3500);
    // A time before it started (a clock read earlier) is no time at all.
    expect(watchTime(watch, 500)).toBe(0);
  });

  it("keeps its time while paused and runs on from it", () => {
    const paused = pauseWatch(startWatch(1000), 4000);
    expect(watchTime(paused, 60_000)).toBe(3000);
    expect(pauseWatch(paused, 70_000)).toBe(paused);
    const running = resumeWatch(paused, 100_000);
    expect(watchTime(running, 102_000)).toBe(5000);
    expect(resumeWatch(running, 200_000)).toBe(running);
  });

  it("can start paused", () => {
    const watch = startWatch(1000, true);
    expect(watchTime(watch, 9000)).toBe(0);
    expect(watchTime(resumeWatch(watch, 9000), 9500)).toBe(500);
  });
});

describe("formatClock", () => {
  it("is the time of day in hours and minutes", () => {
    const at = new Date(2026, 0, 5, 14, 7, 30).getTime();
    expect(formatClock(at)).toMatch(/^(14|2)[:.]07(\s?PM)?$/i);
    expect(formatClock(at)).not.toContain("30");
  });
});
