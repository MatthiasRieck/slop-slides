// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FRAME_LOAD_LIMIT,
  holdFrameLoads,
  MAX_FRAME_LOADS,
  MAX_PICTURE_LOADS,
  PICTURE_LOAD_LIMIT,
  queueFrameLoad,
  queuePictureLoad,
} from "./frameLoads";

describe("the order slide previews load in", () => {
  let started: string[];
  /** Says that a load has finished. */
  let finish: Map<string, () => void>;
  /** Takes a request back. */
  let cancel: Map<string, () => void>;
  const load = (name: string, urgent = false) =>
    cancel.set(
      name,
      queueFrameLoad((done) => {
        started.push(name);
        finish.set(name, done);
      }, urgent),
    );

  beforeEach(() => {
    vi.useFakeTimers();
    started = [];
    finish = new Map();
    cancel = new Map();
  });
  afterEach(() => {
    for (const stop of cancel.values()) stop();
    for (const done of finish.values()) done();
    vi.useRealTimers();
  });

  it("starts a few at once and the next when one has loaded", () => {
    for (const name of ["a", "b", "c", "d", "e"]) load(name);
    expect(started).toEqual(["a", "b", "c"]);
    expect(started).toHaveLength(MAX_FRAME_LOADS);
    finish.get("b")!();
    expect(started).toEqual(["a", "b", "c", "d"]);
    // Saying so twice frees no second place.
    finish.get("b")!();
    expect(started).toEqual(["a", "b", "c", "d"]);
  });

  it("takes the ones in view before the ones near it", () => {
    for (const name of ["a", "b", "c", "near", "near too"]) load(name);
    load("in view", true);
    finish.get("a")!();
    finish.get("b")!();
    expect(started).toEqual(["a", "b", "c", "in view", "near"]);
  });

  it("forgets one that is not wanted any more before its turn", () => {
    for (const name of ["a", "b", "c", "gone", "d"]) load(name);
    cancel.get("gone")!();
    finish.get("a")!();
    expect(started).toEqual(["a", "b", "c", "d"]);
  });

  it("waits while the slide on the stage loads", () => {
    const loaded = holdFrameLoads();
    load("a");
    expect(started).toEqual([]);
    loaded();
    expect(started).toEqual(["a"]);
  });

  it("does not wait for good for a slide that never says it loaded", () => {
    holdFrameLoads();
    for (const name of ["a", "b", "c", "d"]) load(name);
    expect(started).toEqual([]);
    vi.advanceTimersByTime(FRAME_LOAD_LIMIT);
    expect(started).toEqual(["a", "b", "c"]);
    vi.advanceTimersByTime(FRAME_LOAD_LIMIT);
    expect(started).toEqual(["a", "b", "c", "d"]);
  });
});

describe("the order pictures of slides load in", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("loads more at once than live previews, without waiting for the stage's slide", () => {
    const loaded = holdFrameLoads();
    const started: string[] = [];
    const finish: (() => void)[] = [];
    const names = Array.from({ length: MAX_PICTURE_LOADS + 1 }, (_, i) => `p${i}`);
    for (const name of names)
      queuePictureLoad((done) => {
        started.push(name);
        finish.push(done);
      }, false);
    expect(MAX_PICTURE_LOADS).toBeGreaterThan(MAX_FRAME_LOADS);
    expect(started).toEqual(names.slice(0, MAX_PICTURE_LOADS));
    // One the backend takes long to make gives its place up in the end.
    vi.advanceTimersByTime(PICTURE_LOAD_LIMIT);
    expect(started).toEqual(names);
    for (const done of finish) done();
    loaded();
  });
});
