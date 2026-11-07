import { describe, expect, it } from "vitest";

import type { Slide } from "./api";
import { layoutTimeline, moveClip, moveEdge, slideAt, spokenSeconds, withTiming } from "./timeline";
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
    expect(t.slides.map((s) => [s.start, s.end, s.duration, s.narrationStart])).toEqual([
      [0, 2, 2, null],
      [2, 8, 6, 3.5],
    ]);
    expect(t.clips).toEqual([
      { slide: "a", start: 0.5, end: 5.5 },
      { slide: "b", start: 5.5, end: 6.5 },
    ]);
  });

  it("ends pinned slides on the frame nearest where they should, so rounding never adds up", () => {
    const pinned = Array.from({ length: 20 }, (_, i) => slide(`s${i}`, { duration: 3.33 }));
    for (const fps of [24, 30, 60]) {
      const t = layoutTimeline(pinned, {}, options({ fps }));
      t.slides.forEach((s, i) => {
        expect(Math.abs(s.end - 3.33 * (i + 1))).toBeLessThanOrEqual(0.5 / fps + 1e-9);
      });
    }
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
    expect(t.slides[0]).toMatchObject({ end: 3, duration: null });
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

describe("moving", () => {
  const spoken = { a: 3, b: 3, c: 3 };
  const slides = [slide("a", { duration: 4 }), slide("b", { duration: 4 }), slide("c", { duration: 4 })];
  const timeline = () => layoutTimeline(slides, spoken, options());
  const saved = (timing: ReturnType<typeof moveEdge>) => layoutTimeline(withTiming(slides, timing), spoken, options());

  it("changes only the length of the slide whose edge moves", () => {
    expect(moveEdge(timeline(), 0, 5)).toEqual([{ slide: "a", duration: 5, narrationStart: null }]);
    expect(moveEdge(timeline(), 1, 7)).toEqual([{ slide: "b", duration: 3, narrationStart: null }]);
    expect(moveEdge(timeline(), 2, 20)).toEqual([{ slide: "c", duration: 12, narrationStart: null }]);
  });

  it("moves the slides after it, changing how long it all lasts", () => {
    const moved = saved(moveEdge(timeline(), 0, 5));
    expect(moved.slides.map((s) => [s.start, s.end])).toEqual([
      [0, 5],
      [5, 9],
      [9, 13],
    ]);
    expect(moved.end).toBe(13);
  });

  it("keeps each narration where it is in its slide", () => {
    const moved = saved(moveEdge(timeline(), 0, 5));
    expect(moved.clips).toEqual([
      { slide: "a", start: 0.5, end: 3.5 },
      { slide: "b", start: 5.5, end: 8.5 },
      { slide: "c", start: 9.5, end: 12.5 },
    ]);
  });

  it("keeps a narration start that was set", () => {
    const set = [slide("a", { duration: 4, narrationStart: 1 }), slide("b", { duration: 4 })];
    const t = layoutTimeline(set, spoken, options());
    expect(moveEdge(t, 0, 6)).toEqual([{ slide: "a", duration: 6, narrationStart: 1 }]);
  });

  it("delays a narration a shorter slide would talk over, and restores it when longer again", () => {
    const short = withTiming(slides, moveEdge(timeline(), 0, 2));
    const moved = layoutTimeline(short, spoken, options());
    expect(moved.clips[1]).toEqual({ slide: "b", start: 3.5, end: 6.5 });
    const back = withTiming(short, moveEdge(moved, 0, 4));
    expect(layoutTimeline(back, spoken, options()).clips[1]?.start).toBe(4.5);
  });

  it("keeps a slide at its shortest and longest length", () => {
    expect(moveEdge(timeline(), 0, 0)[0]?.duration).toBe(0.5);
    expect(moveEdge(timeline(), 1, 1)[0]?.duration).toBe(0.5);
    expect(moveEdge(timeline(), 0, 100_000)[0]?.duration).toBe(3600);
  });

  it("saves nothing for an edge that stays", () => {
    expect(moveEdge(timeline(), 0, 4)).toEqual([]);
    expect(moveEdge(timeline(), 9, 4)).toEqual([]);
  });

  it("moves a narration inside the timeline without moving anything else", () => {
    const timing = moveClip(timeline(), "b", -0.5);
    expect(timing).toEqual([{ slide: "b", duration: 4, narrationStart: 0 }]);
    const moved = saved(timing);
    expect(moved.clips.map((c) => c.start)).toEqual([0.5, 4, 8.5]);
    expect(moved.slides.map((s) => s.end)).toEqual([4, 8, 12]);
  });

  it("moves a narration before its slide, and over the next", () => {
    const t = layoutTimeline(slides, { a: 1, b: 1, c: 1 }, options());
    expect(moveClip(t, "b", -1)[0]?.narrationStart).toBe(-0.5);
    const alone = layoutTimeline(slides, { a: 1 }, options());
    expect(moveClip(alone, "a", 5)[0]?.narrationStart).toBe(5.5);
  });

  it("stops a narration at the narration on either side", () => {
    expect(moveClip(timeline(), "b", -100)[0]?.narrationStart).toBe(-0.5);
    expect(moveClip(timeline(), "b", 100)[0]?.narrationStart).toBe(1.5);
    for (const by of [-100, 100]) {
      const [a, b, c] = saved(moveClip(timeline(), "b", by)).clips;
      expect(b?.start).toBeGreaterThanOrEqual(a?.end ?? 0);
      expect(c?.start).toBeGreaterThanOrEqual(b?.end ?? 0);
      expect(c?.start).toBe(8.5);
    }
  });

  it("stops the first narration at the start of the timeline", () => {
    expect(moveClip(timeline(), "a", -100)[0]?.narrationStart).toBe(0);
  });

  it("lets the last narration run on, the last slide staying for it", () => {
    const timing = moveClip(timeline(), "c", 10);
    expect(timing).toEqual([{ slide: "c", duration: 4, narrationStart: 10.5 }]);
    expect(saved(timing).end).toBe(21.5);
  });

  it("does not stretch a slide that follows its narration when the narration moves", () => {
    const free = [slide("a"), slide("b")];
    const t = layoutTimeline(free, { a: 3, b: 3 }, options());
    const moved = layoutTimeline(withTiming(free, moveClip(t, "a", 1)), { a: 3, b: 3 }, options());
    expect(moved.slides.map((s) => s.end)).toEqual(t.slides.map((s) => s.end));
    expect(moved.clips[0]?.start).toBe(1.5);
  });

  it("saves nothing for a narration that stays, or without one", () => {
    expect(moveClip(timeline(), "b", 0)).toEqual([]);
    expect(moveClip(timeline(), "nope", 1)).toEqual([]);
    expect(moveClip(layoutTimeline(slides, {}, options()), "a", 1)).toEqual([]);
  });
});

describe("withTiming", () => {
  it("changes only the slides it names", () => {
    const a = slide("a", { duration: 1 });
    const b = slide("b", { duration: 2 });
    const [first, second] = withTiming([a, b], [{ slide: "b", duration: null, narrationStart: 1 }]);
    expect(first).toBe(a);
    expect(second).toMatchObject({ duration: null, narrationStart: 1 });
  });
});

describe("slideAt", () => {
  it("finds the slide showing at a time, the last past the end", () => {
    const t = layoutTimeline([slide("a"), slide("b")], {}, options());
    expect([0, 2.9, 3, 5.9, 100].map((time) => slideAt(t, time))).toEqual([0, 0, 1, 1, 1]);
  });
});
