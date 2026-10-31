import { describe, expect, it } from "vitest";

import { commentLine, commentSelector, parseSpots, parseTarget, placeComments, type SlideComment } from "./comments";

const target = { path: [0, 2], tag: "h2", label: "Our vision", at: [0.5, 0.5] as [number, number] };
const onElement: SlideComment = { id: "a", text: 'Say "more"\nhere', x: 0.25, y: 0.5, target };
const onSlide: SlideComment = { id: "b", text: "Too busy", x: 0.25, y: 0.5 };
const size = { width: 1920, height: 1080 };

describe("placeComments", () => {
  it("lists comments in deck order and leaves out slides that are gone", () => {
    const placed = placeComments({ outro: [onSlide], gone: [onSlide], intro: [onElement] }, [
      { id: "intro" },
      { id: "plan" },
      { id: "outro" },
    ]);
    expect(placed.map((c) => [c.slide, c.slideNumber])).toEqual([
      ["intro", 1],
      ["outro", 3],
    ]);
  });
});

describe("commentLine", () => {
  it("names the element and quotes the text on one line", () => {
    const [placed] = placeComments({ intro: [onElement] }, [{ id: "intro" }, { id: "b" }]);
    const line = commentLine(placed!, size, 2);
    expect(line).toBe(
      '- slide `intro` (1 of 2), on <h2> at `#intro > :nth-child(1) > :nth-child(3)` showing "Our vision": "Say \\"more\\"\\nhere"',
    );
    expect(line).not.toContain("\n");
  });

  it("gives the place for a comment on the slide itself", () => {
    const [placed] = placeComments({ intro: [onSlide] }, [{ id: "intro" }]);
    expect(commentLine(placed!, size, 1)).toContain("on the slide as a whole, at x 480, y 540");
  });
});

describe("commentSelector", () => {
  it("counts children from one", () => {
    expect(commentSelector("a", { ...target, path: [0] })).toBe("#a > :nth-child(1)");
  });
});

describe("parseTarget", () => {
  it("takes what the preview reports", () => {
    expect(parseTarget(target)).toEqual(target);
    expect(parseTarget({ ...target, label: undefined })).toEqual({ ...target, label: "" });
  });

  it.each([
    [null],
    ["h2"],
    [{ ...target, path: [1.5] }],
    [{ ...target, path: [-1] }],
    [{ ...target, tag: 1 }],
    [{ ...target, at: [0.5] }],
    [{ ...target, at: [0.5, null] }],
  ])("refuses %j", (value) => {
    expect(parseTarget(value)).toBeNull();
  });
});

describe("parseSpots", () => {
  it("keys the spots by comment and drops the ones that make no sense", () => {
    expect(
      parseSpots([
        { id: "a", x: 0.1, y: 0.2, found: false },
        { id: "b", x: 0.3, y: 0.4 },
        { id: "c", x: null, y: 0.4 },
        null,
      ]),
    ).toEqual({ a: { x: 0.1, y: 0.2, found: false }, b: { x: 0.3, y: 0.4, found: true } });
    expect(parseSpots("nope")).toEqual({});
  });
});
