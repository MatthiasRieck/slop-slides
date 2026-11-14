import { describe, expect, it } from "vitest";

import { tabLabels } from "./sidebarTabs";

describe("tabLabels", () => {
  const full = [60, 58, 90, 62];

  it("shows every name while they fit", () => {
    expect(tabLabels(full, 28, 4, 0, 282)).toBe("all");
    expect(tabLabels(full, 28, 4, 0, 400)).toBe("all");
  });

  it("keeps the name of the tab showing when not all fit", () => {
    // 90 + 3 × 28 + 3 × 4 = 186.
    expect(tabLabels(full, 28, 4, 2, 281)).toBe("active");
    expect(tabLabels(full, 28, 4, 2, 186)).toBe("active");
  });

  it("shows icons only when even that does not fit", () => {
    expect(tabLabels(full, 28, 4, 2, 185)).toBe("none");
    // The chat's shorter name still fits there.
    expect(tabLabels(full, 28, 4, 0, 185)).toBe("active");
  });

  it("shows every name before the row is laid out", () => {
    expect(tabLabels(full, 28, 4, 0, 0)).toBe("all");
    expect(tabLabels([], 28, 4, 0, 100)).toBe("all");
  });
});
