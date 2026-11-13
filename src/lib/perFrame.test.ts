import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { perFrame } from "./perFrame";

describe("perFrame", () => {
  let frames = new Map<number, FrameRequestCallback>();
  let asked = 0;
  const nextFrame = () => {
    const due = [...frames.values()];
    frames.clear();
    for (const run of due) run(0);
  };

  beforeEach(() => {
    frames = new Map();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((run) => {
      frames.set(++asked, run);
      return asked;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => void frames.delete(id));
  });
  afterEach(() => vi.restoreAllMocks());

  it("passes the first value on at once, and of the rest of a frame only the last, in the next", () => {
    const seen: number[] = [];
    const gate = perFrame<number>((value) => seen.push(value));
    for (let value = 1; value <= 20; value++) gate.push(value);
    expect(seen).toEqual([1]);
    nextFrame();
    expect(seen).toEqual([1, 20]);
    // The frame the 20 went out in is spent too.
    gate.push(21);
    gate.push(22);
    expect(seen).toEqual([1, 20]);
    nextFrame();
    expect(seen).toEqual([1, 20, 22]);
  });

  it("is ready for the next value once a frame passed with nothing waiting", () => {
    const seen: number[] = [];
    const gate = perFrame<number>((value) => seen.push(value));
    gate.push(1);
    nextFrame();
    gate.push(2);
    expect(seen).toEqual([1, 2]);
  });

  it("hands the waiting value on when flushed, once", () => {
    const seen: number[] = [];
    const gate = perFrame<number>((value) => seen.push(value));
    gate.push(1);
    gate.push(2);
    gate.flush();
    expect(seen).toEqual([1, 2]);
    gate.flush();
    nextFrame();
    expect(seen).toEqual([1, 2]);
  });

  it("drops the waiting value when cancelled", () => {
    const seen: number[] = [];
    const gate = perFrame<number>((value) => seen.push(value));
    gate.push(1);
    gate.push(2);
    gate.cancel();
    nextFrame();
    expect(seen).toEqual([1]);
    gate.push(3);
    expect(seen).toEqual([1, 3]);
  });

  it("works where frames run at once", () => {
    vi.mocked(window.requestAnimationFrame).mockImplementation((run) => {
      run(0);
      return 0;
    });
    const seen: number[] = [];
    const gate = perFrame<number>((value) => seen.push(value));
    gate.push(1);
    gate.push(2);
    expect(seen).toEqual([1, 2]);
  });
});
