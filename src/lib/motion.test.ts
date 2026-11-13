import { afterEach, describe, expect, it, vi } from "vitest";

import { prefersReducedMotion, scrollBehavior } from "./motion";

const asking = (reduced: boolean) =>
  vi
    .spyOn(window, "matchMedia")
    .mockImplementation(
      (query) => ({ matches: reduced && query === "(prefers-reduced-motion: reduce)" }) as MediaQueryList,
    );

afterEach(() => vi.restoreAllMocks());

describe("scrollBehavior", () => {
  it("scrolls smoothly by default", () => {
    asking(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(scrollBehavior()).toBe("smooth");
  });

  it("jumps for those who asked for less motion", () => {
    asking(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(scrollBehavior()).toBe("auto");
  });
});
