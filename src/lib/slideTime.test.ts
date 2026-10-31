import { describe, expect, it } from "vitest";

import { parseTime } from "./slideTime";

describe("parseTime", () => {
  it("reads minutes and seconds, or minutes", () => {
    expect(parseTime("1:30")).toBe(90);
    expect(parseTime(" 0:45 ")).toBe(45);
    expect(parseTime("2")).toBe(120);
    expect(parseTime("1.5")).toBe(90);
    expect(parseTime(".5")).toBe(30);
  });

  it("takes nothing, or nothing's worth, as no time", () => {
    expect(parseTime("")).toBe(0);
    expect(parseTime("  ")).toBe(0);
    expect(parseTime("0")).toBe(0);
  });

  it("refuses what is no time", () => {
    for (const text of ["soon", "1:5", "1:75", "-1", "1:30:00", "1."]) expect(parseTime(text)).toBeNull();
  });
});
