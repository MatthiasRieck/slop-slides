import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_VIDEO_OPTIONS,
  loadVideoOptions,
  MAX_SECONDS,
  MIN_SECONDS,
  saveVideoOptions,
  secondsProblem,
  videoLength,
} from "./video";

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

describe("videoLength", () => {
  it("is the slides' time as minutes and seconds", () => {
    expect(videoLength(8, 5, 30)).toBe("0:40");
    expect(videoLength(13, 5, 30)).toBe("1:05");
    expect(videoLength(1, 600, 60)).toBe("10:00");
    expect(videoLength(3, 0.5, 24)).toBe("0:02");
  });
});

describe("video options", () => {
  it("defaults to five seconds a slide at 30 fps, with animations", () => {
    expect(loadVideoOptions()).toEqual({ secondsPerSlide: 5, fps: 30, animate: true });
  });

  it("remembers the last choice", () => {
    saveVideoOptions({ secondsPerSlide: 3, fps: 60, animate: false });
    expect(loadVideoOptions()).toEqual({ secondsPerSlide: 3, fps: 60, animate: false });
  });

  it("replaces saved values the backend would refuse", () => {
    localStorage.setItem("slopslide.video", JSON.stringify({ secondsPerSlide: 0, fps: 29, animate: "yes" }));
    expect(loadVideoOptions()).toEqual(DEFAULT_VIDEO_OPTIONS);
    localStorage.setItem("slopslide.video", "not json");
    expect(loadVideoOptions()).toEqual(DEFAULT_VIDEO_OPTIONS);
  });
});
