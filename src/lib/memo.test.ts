// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { memoizeLast } from "./memo";

describe("memoizeLast", () => {
  it("computes once for the same values, and again when one changes", () => {
    const sum = vi.fn((list: number[], extra: number) => list.reduce((a, b) => a + b, extra));
    const cached = memoizeLast(sum);
    const list = [1, 2, 3];
    expect(cached(list, 1)).toBe(7);
    expect(cached(list, 1)).toBe(7);
    expect(sum).toHaveBeenCalledTimes(1);
    expect(cached(list, 2)).toBe(8);
    // Another list is another value, whatever it holds.
    expect(cached([1, 2, 3], 2)).toBe(8);
    expect(sum).toHaveBeenCalledTimes(3);
    // Only the last answer is kept.
    expect(cached(list, 1)).toBe(7);
    expect(sum).toHaveBeenCalledTimes(4);
  });
});
