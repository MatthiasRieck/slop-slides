import { describe, expect, it } from "vitest";

import {
  convert,
  DEFAULT_SIZE,
  describeSize,
  formatSize,
  orientationOf,
  pixelsOf,
  resizePrompt,
  sameSize,
  SIZE_PRESETS,
  sizeProblem,
  toPixels,
  withOrientation,
} from "./slideSize";

describe("slide sizes", () => {
  it("converts to CSS pixels like the backend", () => {
    expect(toPixels({ width: 1920, height: 1080, unit: "px" })).toEqual({ width: 1920, height: 1080 });
    expect(toPixels({ width: 8.5, height: 11, unit: "in" })).toEqual({ width: 816, height: 1056 });
    expect(toPixels({ width: 21, height: 29.7, unit: "cm" })).toEqual({ width: 794, height: 1123 });
  });

  it("reads a deck's canvas, defaulting to 1920×1080", () => {
    expect(pixelsOf(null)).toEqual({ width: 1920, height: 1080 });
    expect(pixelsOf({})).toEqual({ width: 1920, height: 1080 });
    expect(pixelsOf({ size: { width: 8.5, height: 11, unit: "in", pixelWidth: 816, pixelHeight: 1056 } })).toEqual({
      width: 816,
      height: 1056,
    });
  });

  it("converts between units, rounded to what the fields show", () => {
    expect(convert({ width: 8.5, height: 11, unit: "in" }, "cm")).toEqual({ width: 21.59, height: 27.94, unit: "cm" });
    expect(convert({ width: 8.5, height: 11, unit: "in" }, "px")).toEqual({ width: 816, height: 1056, unit: "px" });
    expect(convert({ width: 1920, height: 1080, unit: "px" }, "in")).toEqual({ width: 20, height: 11.25, unit: "in" });
    const same = { width: 3, height: 4, unit: "cm" as const };
    expect(convert(same, "cm")).toBe(same);
  });

  it("tells and changes the orientation", () => {
    expect(orientationOf({ width: 1920, height: 1080 })).toBe("landscape");
    expect(orientationOf({ width: 1080, height: 1350 })).toBe("portrait");
    expect(orientationOf({ width: 1080, height: 1080 })).toBe("square");

    const wide = { width: 1920, height: 1080, unit: "px" as const };
    expect(withOrientation(wide, "portrait")).toEqual({ width: 1080, height: 1920, unit: "px" });
    expect(withOrientation(wide, "landscape")).toEqual(wide);
    expect(withOrientation(wide, "square")).toEqual({ width: 1080, height: 1080, unit: "px" });
    const tall = { width: 21, height: 29.7, unit: "cm" as const };
    expect(withOrientation(tall, "landscape")).toEqual({ width: 29.7, height: 21, unit: "cm" });
    // A square has no long side: it takes the default 16:9 shape.
    const square = { width: 1080, height: 1080, unit: "px" as const };
    expect(withOrientation(square, "landscape")).toEqual({ width: 1920, height: 1080, unit: "px" });
    expect(withOrientation(square, "portrait")).toEqual({ width: 1080, height: 1920, unit: "px" });
  });

  it("explains sizes the backend would refuse", () => {
    expect(sizeProblem({ width: 1920, height: 1080, unit: "px" })).toBeNull();
    expect(sizeProblem({ width: 0, height: 1080, unit: "px" })).toBe("Enter a width and a height.");
    expect(sizeProblem({ width: Number.NaN, height: 1080, unit: "px" })).toBe("Enter a width and a height.");
    expect(sizeProblem({ width: 1, height: 1, unit: "in" })).toBe("Each side must be 100–10,000 px (now 96×96 px).");
    expect(sizeProblem({ width: 20000, height: 1080, unit: "px" })).toContain("now 20000×1080 px");
    for (const preset of SIZE_PRESETS) expect(sizeProblem(preset.size)).toBeNull();
  });

  it("describes sizes for people", () => {
    expect(formatSize(DEFAULT_SIZE)).toBe("1920 × 1080 px");
    expect(describeSize(DEFAULT_SIZE)).toBe("1920 × 1080 px");
    expect(describeSize({ width: 21, height: 29.7, unit: "cm" })).toBe("21 × 29.7 cm (794 × 1123 px)");
    expect(sameSize(DEFAULT_SIZE, { width: 1920, height: 1080, unit: "px" })).toBe(true);
    expect(sameSize(DEFAULT_SIZE, { width: 20, height: 11.25, unit: "in" })).toBe(false);
  });

  it("asks the agent to lay the deck out again for the new size", () => {
    const prompt = resizePrompt(DEFAULT_SIZE, { width: 8.5, height: 11, unit: "in" });
    expect(prompt).toContain("from landscape, 1920 × 1080 px to portrait, 8.5 × 11 in (816 × 1056 px)");
    expect(prompt).toContain("Re-lay out every slide for the new canvas");
    expect(prompt).toContain("Keep all content, slide ids");
  });
});
