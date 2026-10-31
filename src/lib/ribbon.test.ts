import { describe, expect, it } from "vitest";

import { COLLAPSED_SECTION_WIDTH, popupShift, sectionsToCollapse } from "./ribbon";

describe("sectionsToCollapse", () => {
  const widths = [170, 230, 170, 180, 140];
  const total = 890;

  it("keeps every section open while they fit", () => {
    expect(sectionsToCollapse(widths, total)).toBe(0);
  });

  it("collapses from the right, one section at a time", () => {
    expect(sectionsToCollapse(widths, total - 1)).toBe(1);
    expect(sectionsToCollapse(widths, total - 140 + COLLAPSED_SECTION_WIDTH)).toBe(1);
    expect(sectionsToCollapse(widths, total - 140 + COLLAPSED_SECTION_WIDTH - 1)).toBe(2);
  });

  it("collapses them all when even that does not fit", () => {
    expect(sectionsToCollapse(widths, 10)).toBe(widths.length);
  });

  it("collapses nothing with no layout to go by", () => {
    expect(sectionsToCollapse(widths, 0)).toBe(0);
  });
});

describe("popupShift", () => {
  it("leaves a popup that is inside the bounds", () => {
    expect(popupShift(100, 300, 0, 500)).toBe(0);
  });

  it("moves a popup back from either edge", () => {
    expect(popupShift(400, 600, 0, 500)).toBe(-104);
    expect(popupShift(-50, 150, 0, 500)).toBe(54);
  });

  it("keeps the left edge of a popup wider than the bounds", () => {
    expect(popupShift(100, 700, 0, 500)).toBe(-96);
  });
});
