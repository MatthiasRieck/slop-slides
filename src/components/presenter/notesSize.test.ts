import { beforeEach, describe, expect, it } from "vitest";

import { loadNotesSize, NOTE_SIZES, saveNotesSize, stepNotesSize } from "./notesSize";

beforeEach(() => localStorage.clear());

describe("the size of the presenter's notes", () => {
  it("starts larger in the window than in the panel beside the slide", () => {
    expect(NOTE_SIZES[loadNotesSize("panel")]).toBe("text-base");
    expect(NOTE_SIZES[loadNotesSize("window")]).toBe("text-2xl");
  });

  it("is remembered for each place on its own", () => {
    saveNotesSize("panel", 3);
    expect(loadNotesSize("panel")).toBe(3);
    expect(loadNotesSize("window")).toBe(4);
    saveNotesSize("window", 6);
    expect(loadNotesSize("panel")).toBe(3);
    expect(loadNotesSize("window")).toBe(6);
  });

  it("falls back on what is no size", () => {
    for (const stored of ['{"panel":99,"window":-1}', '{"panel":"big"}', '{"panel":1.5}', "null", "nonsense"]) {
      localStorage.setItem("slopslide.presenterNotesSize", stored);
      expect(loadNotesSize("panel")).toBe(1);
      expect(loadNotesSize("window")).toBe(4);
    }
  });

  it("steps within the sizes there are", () => {
    expect(stepNotesSize(1, 1)).toBe(2);
    expect(stepNotesSize(1, -1)).toBe(0);
    expect(stepNotesSize(0, -1)).toBe(0);
    expect(stepNotesSize(NOTE_SIZES.length - 1, 1)).toBe(NOTE_SIZES.length - 1);
  });
});
