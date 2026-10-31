import { describe, expect, it } from "vitest";

import { parseGeometry, parseGeometryValue } from "./arrange";

describe("parseGeometry", () => {
  it("takes the editor's report, a null rotation meaning several elements", () => {
    expect(parseGeometry({ count: 2, x: 1, y: -2, w: 3, h: 4, rotation: null })).toEqual({
      count: 2,
      x: 1,
      y: -2,
      w: 3,
      h: 4,
      rotation: null,
    });
    expect(parseGeometry({ count: 1, x: 0, y: 0, w: 3, h: 4, rotation: 45 })?.rotation).toBe(45);
  });

  it("is null for nothing selected or a malformed report", () => {
    expect(parseGeometry(null)).toBeNull();
    expect(parseGeometry("x")).toBeNull();
    expect(parseGeometry({ count: 1, x: "1", y: 0, w: 3, h: 4 })).toBeNull();
    expect(parseGeometry({ count: 1, x: Number.NaN, y: 0, w: 3, h: 4 })).toBeNull();
  });
});

describe("parseGeometryValue", () => {
  it("takes negative positions and turns, but only sizes of at least a pixel", () => {
    expect(parseGeometryValue("x", " -12 ")).toBe(-12);
    expect(parseGeometryValue("rotation", "-45.5")).toBe(-45.5);
    expect(parseGeometryValue("w", "120")).toBe(120);
    expect(parseGeometryValue("h", "0")).toBeNull();
    expect(parseGeometryValue("w", "-1")).toBeNull();
  });

  it("is null for anything that is not a number", () => {
    expect(parseGeometryValue("x", "")).toBeNull();
    expect(parseGeometryValue("y", "-")).toBeNull();
    expect(parseGeometryValue("y", "1.2.3")).toBeNull();
  });
});
