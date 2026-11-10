// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  areaBounds,
  areaCapture,
  areaFromDrag,
  areaOutline,
  areaPath,
  commentLine,
  commentSelector,
  parseArea,
  parseSpots,
  parseTarget,
  placeComments,
  type SlideComment,
} from "./comments";

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

describe("area comments", () => {
  const box: [number, number][] = [
    [0.5, 0.6],
    [0.25, 0.2],
  ];

  it("describes the area to the agent in slide pixels", () => {
    const onArea: SlideComment = { id: "c", text: "Crowded", x: 0.25, y: 0.2, area: { shape: "ellipse", points: box } };
    const [placed] = placeComments({ intro: [onArea] }, [{ id: "intro" }]);
    expect(commentLine(placed!, size, 1)).toBe(
      '- slide `intro` (1 of 1), on the area inside an ellipse at x 480–960, y 216–648: "Crowded"',
    );
  });

  it("finds the box around an area", () => {
    expect(areaBounds({ shape: "rect", points: box })).toEqual({ left: 0.25, top: 0.2, right: 0.5, bottom: 0.6 });
  });

  it("outlines rectangles by their corners and ellipses inside their box", () => {
    expect(areaOutline({ shape: "rect", points: box })).toEqual([
      [0.25, 0.2],
      [0.5, 0.2],
      [0.5, 0.6],
      [0.25, 0.6],
    ]);
    const ellipse = areaOutline({ shape: "ellipse", points: box });
    expect(ellipse.length).toBeGreaterThan(16);
    for (const [x, y] of ellipse) {
      // On the ellipse: ((x - cx) / rx)² + ((y - cy) / ry)² = 1.
      expect(((x - 0.375) / 0.125) ** 2 + ((y - 0.4) / 0.2) ** 2).toBeCloseTo(1);
    }
    const lasso: [number, number][] = [
      [0, 0],
      [1, 0],
      [0, 1],
    ];
    expect(areaOutline({ shape: "lasso", points: lasso })).toBe(lasso);
    expect(areaPath({ shape: "lasso", points: lasso })).toBe("M0 0L1 0L0 1Z");
  });

  it("makes an area of a drag, kept on the slide, and nothing of a click", () => {
    expect(
      areaFromDrag("rect", [
        [0.1, 0.1],
        [0.3, 0.2],
        [1.4, -0.2],
      ]),
    ).toEqual({
      shape: "rect",
      points: [
        [0.1, 0.1],
        [1, 0],
      ],
    });
    expect(
      areaFromDrag("ellipse", [
        [0.1, 0.1],
        [0.1005, 0.5],
      ]),
    ).toBeNull();
    expect(areaFromDrag("rect", [])).toBeNull();
  });

  it("keeps a lasso drawn slowly, in many small steps", () => {
    const steps = Array.from({ length: 400 }, (_, i) => {
      const angle = (i / 400) * 2 * Math.PI;
      return [0.5 + 0.2 * Math.cos(angle), 0.5 + 0.2 * Math.sin(angle)] as [number, number];
    });
    const lasso = areaFromDrag("lasso", steps);
    expect(lasso?.points.length).toBeGreaterThan(100);
    expect(lasso?.points.length).toBeLessThan(400);
  });

  it("thins a lasso and drops one drawn along a line", () => {
    const lasso = areaFromDrag("lasso", [
      [0.1, 0.1],
      [0.1001, 0.1001],
      [0.5, 0.1],
      [0.3, 0.5],
    ]);
    expect(lasso?.points).toEqual([
      [0.1, 0.1],
      [0.5, 0.1],
      [0.3, 0.5],
    ]);
    expect(
      areaFromDrag("lasso", [
        [0.1, 0.1],
        [0.2, 0.1],
        [0.3, 0.1],
      ]),
    ).toBeNull();
  });

  it("screenshots the area where the slide shows it, cut to what is in view", () => {
    const slide = { left: 100, top: 50, width: 1000, height: 500 };
    const rect = { shape: "rect" as const, points: box };
    const visible = { left: 0, top: 0, width: 2000, height: 2000 };
    expect(areaCapture(rect, slide, visible)).toEqual({
      rect: { x: 350, y: 150, width: 250, height: 200 },
      outline: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    });
    // Zoomed so the area's right half is out of view: the outline runs past the capture.
    const cut = areaCapture(rect, slide, { left: 0, top: 0, width: 475, height: 2000 });
    expect(cut?.rect).toEqual({ x: 350, y: 150, width: 125, height: 200 });
    expect(cut?.outline[1]).toEqual([2, 0]);
    expect(areaCapture(rect, slide, { left: 0, top: 0, width: 300, height: 2000 })).toBeNull();
  });

  it("checks areas read back from the deck", () => {
    expect(parseArea({ shape: "rect", points: box })).toEqual({ shape: "rect", points: box });
    expect(parseArea({ shape: "star", points: box })).toBeNull();
    expect(parseArea({ shape: "rect", points: [[0, 0]] })).toBeNull();
    expect(parseArea({ shape: "lasso", points: box })).toBeNull();
    expect(
      parseArea({
        shape: "rect",
        points: [
          [0, 0],
          [0, "1"],
        ],
      }),
    ).toBeNull();
    expect(parseArea(null)).toBeNull();
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
