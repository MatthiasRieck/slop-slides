import { describe, expect, it } from "vitest";

import type { Slide } from "../../lib/api";
import {
  budgetSources,
  formatClock,
  formatElapsed,
  loadBudget,
  NO_TIMINGS,
  pauseWatch,
  plannedBudget,
  rehearsedTimes,
  remaining,
  resumeWatch,
  spentBy,
  startWatch,
  timeSlide,
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
    expect(remaining(0, 1)).toEqual({ text: "1:00", over: false, low: false });
    expect(remaining(59_500, 1)).toEqual({ text: "0:01", over: false, low: true });
    expect(remaining(60_000, 1)).toEqual({ text: "0:00", over: false, low: true });
    expect(remaining(65_000, 1)).toEqual({ text: "+0:05", over: true, low: false });
  });

  it("says the time runs short in its last tenth, and never later than a minute before the end", () => {
    // 30 minutes: the last 3 of them.
    expect(remaining(26 * 60_000, 30).low).toBe(false);
    expect(remaining(27 * 60_000 + 1, 30).low).toBe(true);
    // 5 minutes: the last minute, which is more than a tenth.
    expect(remaining(3 * 60_000, 5).low).toBe(false);
    expect(remaining(4 * 60_000 + 1, 5).low).toBe(true);
  });
});

describe("slide timings", () => {
  const slide = (id: string, more: Partial<Slide> = {}) => ({ id, hidden: false, locked: false, ...more }) as Slide;

  it("counts each slide's time from the first move on, adding up visits, and stops at the end", () => {
    let t = timeSlide(NO_TIMINGS, null, 0);
    // The slide the show opens on, said twice, waits uncounted.
    t = timeSlide(t, "a", 1_000);
    t = timeSlide(t, "a", 5_000);
    expect(spentBy(t, 9_000)).toEqual({});
    t = timeSlide(t, "b", 10_000);
    t = timeSlide(t, "a", 13_000);
    t = timeSlide(t, "b", 20_000);
    // Past the last slide: nothing is on screen.
    t = timeSlide(t, null, 24_000);
    expect(spentBy(t, 60_000)).toEqual({ b: 7_000, a: 7_000 });
  });

  it("counts the opening slide once the show moved, also back to it", () => {
    let t = timeSlide(NO_TIMINGS, "a", 0);
    t = timeSlide(t, "b", 2_000);
    t = timeSlide(t, "a", 5_000);
    expect(spentBy(t, 6_500)).toEqual({ b: 3_000, a: 1_500 });
  });

  it("offers times only for a run through every slide shown, in whole seconds, leaving locked ones", () => {
    const shown = [slide("a"), slide("b"), slide("c", { locked: true })];
    expect(rehearsedTimes({ a: 61_400, b: 2_000, c: 9_000 }, shown)).toEqual({ a: 61, b: 2 });
    // A slide skipped, or only passed through, is no run.
    expect(rehearsedTimes({ a: 61_400, c: 9_000 }, shown)).toBeNull();
    expect(rehearsedTimes({ a: 61_400, b: 900, c: 9_000 }, shown)).toBeNull();
    // One slide is no rehearsal, and nothing to set is nothing offered.
    expect(rehearsedTimes({ a: 61_400 }, [slide("a")])).toBeNull();
    expect(
      rehearsedTimes({ a: 5_000, b: 5_000 }, [slide("a", { locked: true }), slide("b", { locked: true })]),
    ).toBeNull();
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
