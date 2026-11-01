import { describe, expect, it } from "vitest";

import type { Slide } from "./api";
import {
  edgeMovable,
  layoutTimeline,
  moveEdge,
  moveSlide,
  retime,
  slideAt,
  slideMovable,
  spokenSeconds,
} from "./timeline";
import { DEFAULT_VIDEO_OPTIONS, type VideoOptions } from "./video";

const slide = (id: string, more: Partial<Slide> = {}): Slide => ({
  id,
  hash: id,
  hidden: false,
  locked: false,
  moved: false,
  ...more,
});
const options = (more: Partial<VideoOptions> = {}): VideoOptions => ({
  ...DEFAULT_VIDEO_OPTIONS,
  secondsPerSlide: 3,
  pauseBefore: 0.5,
  pauseAfter: 1,
  ...more,
});

describe("layoutTimeline", () => {
  it("fits slides to their narration, as the video export does", () => {
    const t = layoutTimeline([slide("a"), slide("b"), slide("c")], { a: 10, b: null, c: 1 }, options());
    expect(t.slides.map((s) => [s.start, s.end])).toEqual([
      [0, 11.5],
      [11.5, 14.5],
      [14.5, 17.5],
    ]);
    expect(t.clips).toEqual([
      { slide: "a", start: 0.5, end: 10.5 },
      { slide: "c", start: 15, end: 16 },
    ]);
    expect(t.end).toBe(17.5);
  });

  it("shows a timed slide for its time, its narration running over the next", () => {
    const slides = [slide("a", { duration: 2 }), slide("b", { duration: 6, narrationStart: 3.5 })];
    const t = layoutTimeline(slides, { a: 5, b: 1 }, options());
    expect(t.slides.map((s) => [s.start, s.end, s.timed])).toEqual([
      [0, 2, true],
      [2, 8, true],
    ]);
    expect(t.clips).toEqual([
      { slide: "a", start: 0.5, end: 5.5 },
      { slide: "b", start: 5.5, end: 6.5 },
    ]);
  });

  it("never has narration talking over the narration before it", () => {
    const t = layoutTimeline([slide("a", { duration: 1 }), slide("b")], { a: 5, b: 1 }, options({ pauseBefore: 0 }));
    expect(t.clips.map((c) => c.start)).toEqual([0, 5]);
  });

  it("keeps the last slide until the last word", () => {
    const t = layoutTimeline([slide("a", { duration: 1 })], { a: 4 }, options({ pauseBefore: 0 }));
    expect(t.slides[0]?.end).toBe(4);
    expect(t.end).toBe(4);
  });

  it("ignores narration and set timing without narration", () => {
    const t = layoutTimeline([slide("a", { duration: 9 })], { a: 5 }, options({ narration: false }));
    expect(t.slides[0]).toMatchObject({ end: 3, timed: false });
    expect(t.clips).toEqual([]);
  });

  it("has nothing to lay out without slides", () => {
    expect(layoutTimeline([], {}, options())).toEqual({ slides: [], clips: [], end: 0 });
  });
});

describe("spokenSeconds", () => {
  it("takes the audio there is, estimates the rest, and has none without narration", () => {
    const slides = [
      slide("said", { narration: "Hello" }),
      slide("stale", { narration: "Hello" }),
      slide("new", { narration: Array(150).fill("word").join(" ") }),
      slide("silent"),
    ];
    const audio = {
      said: { slide: "said", state: "ready", seconds: 2 },
      stale: { slide: "stale", state: "stale", seconds: 3 },
      new: { slide: "new", state: "missing", seconds: null },
      silent: { slide: "silent", state: "none", seconds: null },
    } as const;
    expect(spokenSeconds(slides, audio)).toEqual({ said: 2, stale: 3, new: 60, silent: null });
  });

  it("counts a recording on a slide without any written narration", () => {
    const audio = { voice: { slide: "voice", state: "ready", seconds: 4, recorded: true } } as const;
    expect(spokenSeconds([slide("voice")], audio)).toEqual({ voice: 4 });
  });
});

describe("moving slides", () => {
  const timeline = () =>
    layoutTimeline(
      [slide("a", { duration: 4 }), slide("b", { duration: 4 }), slide("c", { duration: 4 })],
      { a: 3, b: 3, c: 3 },
      options(),
    );

  it("moves an edge, the next slide giving the time and the rest staying", () => {
    expect(moveEdge(timeline(), 0, 5)).toEqual([5, 8, 12]);
    expect(moveEdge(timeline(), 1, 7)).toEqual([4, 7, 12]);
  });

  it("keeps both slides at an edge at least the shortest length", () => {
    expect(moveEdge(timeline(), 0, 0)).toEqual([0.5, 8, 12]);
    expect(moveEdge(timeline(), 0, 100)).toEqual([7.5, 8, 12]);
  });

  it("moves the last edge to change where the timeline ends", () => {
    expect(moveEdge(timeline(), 2, 20)).toEqual([4, 8, 20]);
    expect(moveEdge(timeline(), 2, 1)).toEqual([4, 8, 8.5]);
  });

  it("moves a slide across the audio, keeping its length", () => {
    expect(moveSlide(timeline(), 1, 1)).toEqual([5, 9, 12]);
    expect(moveSlide(timeline(), 1, -1)).toEqual([3, 7, 12]);
  });

  it("stops a moving slide at the shortest length of its neighbours", () => {
    expect(moveSlide(timeline(), 1, 100)).toEqual([7.5, 11.5, 12]);
    expect(moveSlide(timeline(), 1, -100)).toEqual([0.5, 4.5, 12]);
  });

  it("moves the last slide with the end of the timeline, and never the first", () => {
    expect(moveSlide(timeline(), 2, 3)).toEqual([4, 11, 15]);
    expect(moveSlide(timeline(), 0, 3)).toEqual([4, 8, 12]);
  });

  it("does not move locked slides", () => {
    const t = layoutTimeline([slide("a"), slide("b", { locked: true }), slide("c"), slide("d")], {}, options());
    expect([0, 1, 2].map((i) => edgeMovable(t, i))).toEqual([false, false, true]);
    expect([0, 1, 2, 3].map((i) => slideMovable(t, i))).toEqual([false, false, false, true]);
  });

  it("saves only the slides that changed, with their audio left where it was", () => {
    const t = timeline();
    expect(retime(t, moveEdge(t, 0, 5.5))).toEqual([
      { slide: "a", duration: 5.5, narrationStart: 0.5 },
      // Its narration was at 4.5, which is before it now.
      { slide: "b", duration: 2.5, narrationStart: -1 },
    ]);
    expect(retime(t, moveEdge(t, 2, 15))).toEqual([{ slide: "c", duration: 7, narrationStart: 0.5 }]);
    expect(retime(t, moveSlide(t, 1, 0))).toEqual([]);
  });

  it("gives the audio the same place on the timeline after saving", () => {
    const slides = [slide("a"), slide("b")];
    const spoken = { a: 3, b: 3 };
    const before = layoutTimeline(slides, spoken, options());
    const saved = retime(before, moveEdge(before, 0, 2));
    const after = slides.map((s) => {
      const change = saved.find((t) => t.slide === s.id);
      return { ...s, duration: change?.duration, narrationStart: change?.narrationStart };
    });
    const timeline = layoutTimeline(after, spoken, options());
    expect(timeline.clips.map((c) => c.start)).toEqual(before.clips.map((c) => c.start));
    expect(timeline.slides[0]?.end).toBe(2);
  });

  it("leaves a slide without narration no narration start", () => {
    const t = layoutTimeline([slide("a"), slide("b")], {}, options());
    expect(retime(t, moveEdge(t, 0, 4))[0]).toEqual({ slide: "a", duration: 4, narrationStart: null });
  });
});

describe("slideAt", () => {
  it("finds the slide showing at a time, the last past the end", () => {
    const t = layoutTimeline([slide("a"), slide("b")], {}, options());
    expect([0, 2.9, 3, 5.9, 100].map((time) => slideAt(t, time))).toEqual([0, 0, 1, 1, 1]);
  });
});
