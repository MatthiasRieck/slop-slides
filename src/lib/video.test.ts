import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_VIDEO_OPTIONS,
  loadVideoOptions,
  MAX_PAUSE,
  MAX_SECONDS,
  MIN_SECONDS,
  pauseProblem,
  saveVideoOptions,
  secondsProblem,
  slideFrames,
  type VideoOptions,
  videoLength,
} from "./video";

const options = (overrides: Partial<VideoOptions> = {}): VideoOptions => ({ ...DEFAULT_VIDEO_OPTIONS, ...overrides });

beforeEach(() => localStorage.clear());

describe("secondsProblem", () => {
  it("accepts times the backend records", () => {
    expect(secondsProblem("5")).toBeNull();
    expect(secondsProblem("2.5")).toBeNull();
    expect(secondsProblem(String(MIN_SECONDS))).toBeNull();
    expect(secondsProblem(String(MAX_SECONDS))).toBeNull();
  });

  it("explains times it does not", () => {
    expect(secondsProblem("")).toMatch(/Enter/);
    expect(secondsProblem("abc")).toMatch(/Enter/);
    expect(secondsProblem("0.1")).toMatch(/0.5 to 600/);
    expect(secondsProblem("601")).toMatch(/0.5 to 600/);
  });
});

describe("pauseProblem", () => {
  it("accepts pauses the backend takes", () => {
    expect(pauseProblem("0")).toBeNull();
    expect(pauseProblem("0.5")).toBeNull();
    expect(pauseProblem(String(MAX_PAUSE))).toBeNull();
  });

  it("explains pauses it does not", () => {
    expect(pauseProblem("")).toMatch(/Enter/);
    expect(pauseProblem("-1")).toMatch(/0 to 10/);
    expect(pauseProblem("11")).toMatch(/0 to 10/);
  });
});

describe("slideFrames", () => {
  it("shows a slide for the set time, or until its narration and pauses end", () => {
    const o = options({ secondsPerSlide: 5, fps: 30, pauseBefore: 0.5, pauseAfter: 1 });
    expect(slideFrames(o, null)).toBe(150);
    expect(slideFrames(o, 2)).toBe(150);
    expect(slideFrames(o, 10)).toBe(345);
    expect(slideFrames(o, 10.01)).toBe(346);
    // Without narration, its length does not count.
    expect(slideFrames({ ...o, narration: false }, 10)).toBe(150);
  });
});

describe("videoLength", () => {
  it("is the slides' time as minutes and seconds", () => {
    const silent = (n: number) => Array<null>(n).fill(null);
    expect(videoLength(silent(8), options({ secondsPerSlide: 5, fps: 30 }))).toBe("0:40");
    expect(videoLength(silent(13), options({ secondsPerSlide: 5, fps: 30 }))).toBe("1:05");
    expect(videoLength(silent(1), options({ secondsPerSlide: 600, fps: 60 }))).toBe("10:00");
    expect(videoLength(silent(3), options({ secondsPerSlide: 0.5, fps: 24 }))).toBe("0:02");
  });

  it("counts the time narrated slides stay longer", () => {
    const o = options({ secondsPerSlide: 5, fps: 30, pauseBefore: 0.5, pauseAfter: 1 });
    expect(videoLength([null, 58.5, 1], o)).toBe("1:10");
    expect(videoLength([null, 58.5, 1], { ...o, narration: false })).toBe("0:15");
  });
});

describe("video options", () => {
  it("defaults to five seconds a slide at 30 fps, with animations and narration", () => {
    expect(loadVideoOptions()).toEqual({
      secondsPerSlide: 5,
      fps: 30,
      animate: true,
      narration: true,
      pauseBefore: 0.5,
      pauseAfter: 1,
    });
  });

  it("remembers the last choice", () => {
    const chosen = { secondsPerSlide: 3, fps: 60, animate: false, narration: false, pauseBefore: 0, pauseAfter: 2 };
    saveVideoOptions(chosen);
    expect(loadVideoOptions()).toEqual(chosen);
  });

  it("fills in what older saved choices lack", () => {
    localStorage.setItem("slopslide.video", JSON.stringify({ secondsPerSlide: 3, fps: 60, animate: false }));
    expect(loadVideoOptions()).toEqual({ ...DEFAULT_VIDEO_OPTIONS, secondsPerSlide: 3, fps: 60, animate: false });
  });

  it("replaces saved values the backend would refuse", () => {
    localStorage.setItem(
      "slopslide.video",
      JSON.stringify({ secondsPerSlide: 0, fps: 29, animate: "yes", narration: 1, pauseBefore: -1, pauseAfter: 99 }),
    );
    expect(loadVideoOptions()).toEqual(DEFAULT_VIDEO_OPTIONS);
    localStorage.setItem("slopslide.video", "not json");
    expect(loadVideoOptions()).toEqual(DEFAULT_VIDEO_OPTIONS);
  });
});
