// @vitest-environment node
import { describe, expect, it } from "vitest";

import { COLLAPSED_SECTION_WIDTH, collapsedSections, collapsedWidth, editRibbonOrder, popupShift } from "./ribbon";

const count = (flags: boolean[]) => flags.filter(Boolean).length;

describe("collapsedSections", () => {
  const widths = [170, 230, 170, 180, 140];
  const total = 890;

  it("keeps every section open while they fit", () => {
    expect(collapsedSections(widths, total)).toEqual([false, false, false, false, false]);
  });

  it("collapses from the right, one section at a time, without an order", () => {
    expect(collapsedSections(widths, total - 1)).toEqual([false, false, false, false, true]);
    expect(count(collapsedSections(widths, total - 140 + COLLAPSED_SECTION_WIDTH))).toBe(1);
    expect(collapsedSections(widths, total - 140 + COLLAPSED_SECTION_WIDTH - 1)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it("collapses in the order it is given, each to the width it has collapsed", () => {
    const shut = [50, 50, 60, 40, 40];
    expect(collapsedSections(widths, total - 1, { order: [1, 0], collapsed: shut })).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
    // Collapsing the second gained 180; one more pixel short takes the first too.
    expect(collapsedSections(widths, total - 181, { order: [1, 0], collapsed: shut })).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it("never collapses a section that would be no narrower collapsed", () => {
    // The second is barely wider than its collapsed self: the next one in the order goes instead.
    const flags = collapsedSections([200, 45, 200], 400, { order: [1, 2, 0], collapsed: [40, 40, 40] });
    expect(flags).toEqual([false, false, true]);
  });

  it("collapses all it can when even that does not fit", () => {
    expect(count(collapsedSections(widths, 10))).toBe(widths.length);
  });

  it("collapses nothing with no layout to go by", () => {
    expect(count(collapsedSections(widths, 0))).toBe(0);
  });
});

describe("collapsedWidth", () => {
  it("leaves room for the caption under the icon, and never less than an icon needs", () => {
    expect(collapsedWidth("Text")).toBe(COLLAPSED_SECTION_WIDTH);
    expect(collapsedWidth("Paragraph")).toBeGreaterThan(collapsedWidth("Style"));
    expect(collapsedWidth("Paragraph")).toBeLessThanOrEqual(64);
  });
});

describe("editRibbonOrder", () => {
  const sections = ["Insert", "Text", "Paragraph", "Style", "Slide", "Arrange", "Timeline", "Canvas"];
  const names = (order: number[]) => order.map((i) => sections[i]);

  it("collapses the insert tools first with something selected, keeping the formatting and arranging open", () => {
    expect(names(editRibbonOrder(sections, true))).toEqual([
      "Timeline",
      "Insert",
      "Paragraph",
      "Style",
      "Text",
      "Arrange",
      "Canvas",
      "Slide",
    ]);
  });

  it("keeps the insert tools open longest with nothing selected", () => {
    const order = names(editRibbonOrder(sections, false));
    expect(order[0]).toBe("Timeline");
    expect(order.indexOf("Insert")).toBeGreaterThan(order.indexOf("Text"));
    expect(order.indexOf("Insert")).toBe(5);
  });

  it("lists every section once", () => {
    for (const selected of [true, false]) {
      expect([...editRibbonOrder(sections, selected)].sort()).toEqual(sections.map((_, i) => i));
    }
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
