import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { playNarration } from "./narrationAudio";
import type { Timeline } from "./timeline";
import { playTimeline } from "./timelinePlayback";

vi.mock("./narrationAudio", () => ({ playNarration: vi.fn() }));

const say = playNarration as unknown as Mock;

/** The slide each narration was said for and how far in it started, asked when it loaded. */
const said = () =>
  say.mock.calls.map(([deck, slide, from]) => [deck, slide, typeof from === "function" ? from() : from]);

const timeline: Timeline = {
  slides: [
    { id: "a", start: 0, end: 2, locked: false, duration: 2, narrationStart: null },
    { id: "b", start: 2, end: 6, locked: false, duration: null, narrationStart: null },
  ],
  clips: [
    { slide: "a", start: 1, end: 3 },
    { slide: "b", start: 4, end: 5 },
  ],
  end: 6,
};

const events = () => ({ slide: vi.fn(), ended: vi.fn() });
const voice = () => ({ ended: new Promise<void>(() => {}), stop: vi.fn() });

beforeEach(() => {
  vi.useFakeTimers();
  say.mockReset();
  say.mockImplementation(async () => voice());
});

afterEach(() => vi.useRealTimers());

describe("playTimeline", () => {
  it("says each clip at its time, whichever slide is showing, and tells of slides and the end", async () => {
    const on = events();
    playTimeline("deck", timeline, 0, on);
    await vi.advanceTimersByTimeAsync(999);
    expect(say).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(said()).toEqual([["deck", "a", 0]]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(on.slide.mock.calls).toEqual([[1]]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(say.mock.calls[1]?.slice(0, 2)).toEqual(["deck", "b"]);
    expect(on.ended).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(on.ended).toHaveBeenCalledOnce();
  });

  it("picks up a clip already under way, from where it has got to", async () => {
    const on = events();
    playTimeline("deck", timeline, 2.5, on);
    await vi.advanceTimersByTimeAsync(0);
    expect(said()).toEqual([["deck", "a", 1.5]]);
    expect(on.slide).not.toHaveBeenCalled();
  });

  it("starts audio that loads late where the clock is by then", async () => {
    let load!: () => void;
    let from = -1;
    say.mockImplementation(
      (_deck: string, _slide: string, at: () => number) =>
        new Promise((resolve) => {
          load = () => {
            from = at();
            resolve(voice());
          };
        }),
    );
    playTimeline("deck", timeline, 0, events());
    await vi.advanceTimersByTimeAsync(1000);
    // The audio takes 400 ms to load: it starts 0.4 s in, with the slides.
    await vi.advanceTimersByTimeAsync(400);
    load();
    expect(from).toBeCloseTo(0.4, 5);
  });

  it("tells where it is as it plays, up to the end", async () => {
    const on = { ...events(), tick: vi.fn() };
    const stop = playTimeline("deck", timeline, 5, on);
    expect(on.tick).toHaveBeenLastCalledWith(5);
    await vi.advanceTimersByTimeAsync(500);
    expect(on.tick.mock.lastCall?.[0]).toBeCloseTo(5.5, 5);
    await vi.advanceTimersByTimeAsync(2000);
    expect(on.tick.mock.lastCall?.[0]).toBe(6);
    stop();
    const calls = on.tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(on.tick.mock.calls.length).toBe(calls);
  });

  it("skips clips that are over", async () => {
    playTimeline("deck", timeline, 3.5, events());
    await vi.advanceTimersByTimeAsync(0);
    expect(say).not.toHaveBeenCalled();
  });

  it("stops the voice and everything still to come", async () => {
    const on = events();
    const playing = voice();
    say.mockImplementation(async () => playing);
    const stop = playTimeline("deck", timeline, 0, on);
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(playing.stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(on.slide).not.toHaveBeenCalled();
    expect(on.ended).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledOnce();
  });

  it("stops a voice that starts only after stopping", async () => {
    let start!: (value: ReturnType<typeof voice>) => void;
    say.mockImplementation(() => new Promise((resolve) => (start = resolve)));
    const stop = playTimeline("deck", timeline, 0, events());
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    const late = voice();
    start(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.stop).toHaveBeenCalled();
  });

  it("gives slides their time when audio cannot play", async () => {
    say.mockRejectedValue(new Error("no audio"));
    const on = events();
    playTimeline("deck", timeline, 0, on);
    await vi.advanceTimersByTimeAsync(6000);
    expect(on.ended).toHaveBeenCalledOnce();
  });
});
