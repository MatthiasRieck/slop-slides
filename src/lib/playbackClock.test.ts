import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPlaybackClock, playheadTransform } from "./playbackClock";

describe("a playback clock", () => {
  let now = 0;
  let frames: (FrameRequestCallback | undefined)[] = [];
  const frame = (ms: number) => {
    now += ms;
    const due = frames;
    frames = [];
    for (const run of due) run?.(now);
  };

  beforeEach(() => {
    now = 1000;
    frames = [];
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((run) => frames.push(run));
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames[id - 1] = undefined;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("stands where it is put, and runs on with the time from where it is started", () => {
    const clock = createPlaybackClock();
    expect([clock.time(), clock.running()]).toEqual([0, false]);
    clock.stopAt(2.5);
    now += 500;
    expect(clock.time()).toBe(2.5);
    clock.runFrom(4);
    expect(clock.running()).toBe(true);
    now += 250;
    expect(clock.time()).toBe(4.25);
    clock.stopAt(clock.time());
    now += 250;
    expect(clock.time()).toBe(4.25);
  });

  it("runs faster or slower at a rate, until it is started again", () => {
    const clock = createPlaybackClock();
    clock.runFrom(1, 2);
    now += 500;
    expect(clock.time()).toBe(2);
    clock.sync(3);
    now += 250;
    expect(clock.time()).toBe(3.5);
    clock.runFrom(0);
    now += 500;
    expect(clock.time()).toBe(0.5);
  });

  it("tells its followers every frame while it runs, and asks for no frame otherwise", () => {
    const clock = createPlaybackClock();
    const follower = vi.fn();
    const stop = clock.onFrame(follower);
    // Standing, there is nothing to follow.
    expect(frames).toHaveLength(0);
    clock.runFrom(0);
    expect(follower).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) frame(16);
    expect(follower).toHaveBeenCalledTimes(6);
    clock.stopAt(1);
    expect(follower).toHaveBeenCalledTimes(7);
    frame(16);
    frame(16);
    expect(follower).toHaveBeenCalledTimes(7);
    // Running with nobody following, no frame is asked for either.
    clock.runFrom(0);
    stop();
    frame(16);
    expect(frames).toHaveLength(0);
    expect(follower).toHaveBeenCalledTimes(8);
  });

  it("is set right by what plays, without that counting as a move", () => {
    const clock = createPlaybackClock();
    const moved = vi.fn();
    const follower = vi.fn();
    clock.onChange(moved);
    clock.onFrame(follower);
    clock.runFrom(2);
    expect(moved).toHaveBeenCalledTimes(1);
    now += 100;
    clock.sync(2.25);
    expect(clock.time()).toBe(2.25);
    expect(follower).toHaveBeenCalledTimes(2);
    // Where it set out from stays, until it is stopped or started again.
    expect(clock.rest()).toBe(2);
    expect(moved).toHaveBeenCalledTimes(1);
    clock.stopAt(3);
    expect(clock.rest()).toBe(3);
    expect(moved).toHaveBeenCalledTimes(2);
    // A standing clock is not moved by a late word of what played.
    clock.sync(9);
    expect(clock.time()).toBe(3);
  });
});

describe("playheadTransform", () => {
  it("slides the playhead's sheet in by its part of the track, never past either end", () => {
    expect(playheadTransform(0.5)).toBe("translateX(50%)");
    expect(playheadTransform(-1)).toBe("translateX(0%)");
    expect(playheadTransform(2)).toBe("translateX(100%)");
  });
});
