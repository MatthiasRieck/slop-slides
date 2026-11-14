import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preloadWhenIdle, whenIdle } from "./idle";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Lets the promises settled so far run what waits on them. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("whenIdle", () => {
  it("waits for the browser to say it is idle, where it can", () => {
    const callbacks: (() => void)[] = [];
    vi.stubGlobal("requestIdleCallback", (run: () => void) => callbacks.push(run));
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const run = vi.fn();
    whenIdle(run);
    vi.advanceTimersByTime(10_000);
    expect(run).not.toHaveBeenCalled();
    callbacks[0]!();
    expect(run).toHaveBeenCalledOnce();
  });

  it("waits a moment where the browser cannot say, and can be called off", () => {
    const run = vi.fn();
    whenIdle(run);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(run).toHaveBeenCalledOnce();
    const cancel = whenIdle(run);
    cancel();
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("preloadWhenIdle", () => {
  it("starts nothing right away, then one task per idle moment, each after the one before is done", async () => {
    let finishFirst = () => {};
    const first = vi.fn(() => new Promise<void>((resolve) => (finishFirst = resolve)));
    const second = vi.fn(async () => {});
    preloadWhenIdle([first, second]);
    expect(first).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(first).toHaveBeenCalledOnce();
    // The second waits for the first, however long that takes.
    await vi.advanceTimersByTimeAsync(5000);
    expect(second).not.toHaveBeenCalled();
    finishFirst();
    await settle();
    expect(second).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(second).toHaveBeenCalledOnce();
  });

  it("goes on after a task that failed, and stops when called off", async () => {
    const failing = vi.fn(async () => Promise.reject(new Error("no chunk")));
    const second = vi.fn(async () => {});
    const third = vi.fn(async () => {});
    const cancel = preloadWhenIdle([failing, second, third]);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(200);
    expect(second).toHaveBeenCalledOnce();
    cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(third).not.toHaveBeenCalled();
  });
});
