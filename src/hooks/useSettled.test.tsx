import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSettled } from "./useSettled";

describe("useSettled", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("follows at once without a delay", () => {
    const { result, rerender } = renderHook(({ value }) => useSettled(value, 0), { initialProps: { value: "a" } });
    rerender({ value: "b" });
    expect(result.current).toBe("b");
  });

  it("follows a burst of changes once, where it ends up", () => {
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ value }) => {
        const settled = useSettled(value, 400);
        if (seen.at(-1) !== settled) seen.push(settled);
        return settled;
      },
      { initialProps: { value: "a" } },
    );
    for (const value of ["b", "c", "d"]) {
      rerender({ value });
      act(() => void vi.advanceTimersByTime(300));
    }
    expect(result.current).toBe("a");
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current).toBe("d");
    expect(seen).toEqual(["a", "d"]);
  });

  it("is where the value is the moment the delay is lifted", () => {
    const { result, rerender } = renderHook(({ value, delay }) => useSettled(value, delay), {
      initialProps: { value: "a", delay: 400 },
    });
    rerender({ value: "b", delay: 400 });
    expect(result.current).toBe("a");
    rerender({ value: "b", delay: 0 });
    expect(result.current).toBe("b");
  });
});
