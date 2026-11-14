import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_VIDEO_OPTIONS,
  loadVideoOptions,
  MAX_PAUSE,
  MAX_SECONDS,
  MIN_SECONDS,
  onVideoOptions,
  pauseProblem,
  saveVideoOptions,
  secondsProblem,
  slideFrames,
  timeLeftText,
  type VideoOptions,
  videoPercent,
  videoPhase,
  videoPhaseShort,
  videoSize,
  videoTimeLeft,
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

describe("video options, shared", () => {
  beforeEach(() => localStorage.removeItem("slopslide.video"));

  it("are the same object until they change", () => {
    expect(loadVideoOptions()).toBe(loadVideoOptions());
    const before = loadVideoOptions();
    saveVideoOptions({ ...DEFAULT_VIDEO_OPTIONS, secondsPerSlide: 9 });
    expect(loadVideoOptions()).not.toBe(before);
    expect(loadVideoOptions()).toBe(loadVideoOptions());
    expect(loadVideoOptions().secondsPerSlide).toBe(9);
  });

  it("tell whoever listens when they are saved, until it stops listening", () => {
    let told = 0;
    const stop = onVideoOptions(() => told++);
    saveVideoOptions({ ...DEFAULT_VIDEO_OPTIONS, pauseAfter: 2 });
    expect(told).toBe(1);
    stop();
    saveVideoOptions(DEFAULT_VIDEO_OPTIONS);
    expect(told).toBe(1);
  });
});

describe("video export progress", () => {
  it("says what it is doing in full and in short", () => {
    const speaking = { phase: "narration", frame: 1, frames: 4 } as const;
    expect(videoPhase(speaking)).toBe("Generating narration 2 of 4");
    expect(videoPhaseShort(speaking)).toBe("Narration 2/4");
    const rendering = { phase: "video", frame: 45, frames: 100 } as const;
    expect(videoPhase(rendering)).toBe("Rendering video 45%");
    expect(videoPhaseShort(rendering)).toBe("45%");
  });

  it("never counts past the last slide or over 100%", () => {
    expect(videoPhase({ phase: "narration", frame: 4, frames: 4 })).toBe("Generating narration 4 of 4");
    expect(videoPercent({ phase: "video", frame: 300, frames: 100 })).toBe(100);
    expect(videoPercent({ phase: "video", frame: 0, frames: 0 })).toBe(0);
    expect(videoPercent({ phase: "video", frame: 199, frames: 200 })).toBe(99);
  });
});

describe("video size and time left", () => {
  it("makes the video the slides' size or as tall as asked, within 4K, in even pixels", () => {
    expect(videoSize(1920, 1080, null)).toEqual([1920, 1080]);
    expect(videoSize(1920, 1080, 720)).toEqual([1280, 720]);
    expect(videoSize(1920, 1080, 2160)).toEqual([3840, 2160]);
    expect(videoSize(1080, 1350, 720)).toEqual([576, 720]);
    expect(videoSize(1281, 721, null)).toEqual([1282, 722]);
    expect(videoSize(4000, 1000, 2160)).toEqual([3840, 960]);
  });

  it("carries the pace so far to the end, once there is enough to go on", () => {
    expect(videoTimeLeft({ phase: "video", frame: 200, frames: 600 }, 60_000)).toBe(120);
    expect(videoTimeLeft({ phase: "video", frame: 0, frames: 600 }, 60_000)).toBeNull();
    expect(videoTimeLeft({ phase: "video", frame: 10, frames: 600 }, 1000)).toBeNull();
    expect(videoTimeLeft({ phase: "narration", frame: 1, frames: 4 }, 60_000)).toBeNull();
    expect(timeLeftText(30)).toBe("less than a minute left");
    expect(timeLeftText(150)).toBe("about 3 min left");
    expect(timeLeftText(5400)).toBe("about 1.5 h left");
  });
});
