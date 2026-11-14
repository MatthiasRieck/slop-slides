// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  angleTowards,
  DEFAULT_DIVIDER,
  type Divider,
  dividerEnds,
  knobAt,
  knobSide,
  movedTo,
  normalAngle,
  revealMask,
  shifted,
  sideLabelAt,
} from "./compare";

const box = { width: 960, height: 540 };
const divider = (changes: Partial<Divider>): Divider => ({ ...DEFAULT_DIVIDER, ...changes });
const near = (a: { x: number; y: number }, x: number, y: number) => {
  expect(a.x).toBeCloseTo(x);
  expect(a.y).toBeCloseTo(y);
};

/** The stops of a mask, and the angle of its gradient. */
function parse(mask: string) {
  const m = /^linear-gradient\((-?[\d.]+)deg, transparent (-?[\d.]+)px, #000 (-?[\d.]+)px\)$/.exec(mask);
  if (!m) throw new Error(`not a mask: ${mask}`);
  return { angle: Number(m[1]), from: Number(m[2]), to: Number(m[3]) };
}

describe("revealMask", () => {
  it("cuts straight down the middle by default", () => {
    expect(parse(revealMask(DEFAULT_DIVIDER, box))).toEqual({ angle: 90, from: 480, to: 480 });
  });

  it("follows the divider across the slide", () => {
    expect(parse(revealMask(divider({ x: 0.25 }), box)).from).toBe(240);
    expect(parse(revealMask(divider({ x: 1 }), box)).from).toBe(960);
  });

  it("turns with the divider", () => {
    // Upside down, the old version is on the right: the gradient runs the other way.
    const flipped = parse(revealMask(divider({ x: 0.25, angle: 180 }), box));
    expect(flipped.angle).toBe(-90);
    expect(flipped.from).toBe(720);
    // Lying flat, the old version is on top.
    const flat = parse(revealMask(divider({ y: 0.25, angle: 90 }), box));
    expect(flat.angle).toBe(180);
    expect(flat.from).toBe(135);
  });

  it("measures a slanted cut from the corner the gradient starts at", () => {
    const { from } = parse(revealMask(divider({ angle: 45 }), box));
    // A gradient at any angle starts past one corner, and its middle is the box's center.
    expect(from).toBeCloseTo(((960 + 540) * Math.SQRT1_2) / 2, 1);
  });
});

describe("dividerEnds", () => {
  it("runs from the top to the bottom of the slide when upright", () => {
    const [start, end] = dividerEnds(DEFAULT_DIVIDER, box);
    near(start, 480, 540);
    near(end, 480, 0);
  });

  it("runs from side to side when lying flat", () => {
    const [start, end] = dividerEnds(divider({ angle: 90 }), box);
    near(start, 0, 270);
    near(end, 960, 270);
  });

  it("stops at the sides of the slide when slanted", () => {
    const [start, end] = dividerEnds(divider({ angle: 45 }), box);
    near(start, 480 - 270, 540);
    near(end, 480 + 270, 0);
  });
});

describe("moving the divider", () => {
  it("moves to the pointer", () => {
    expect(movedTo(DEFAULT_DIVIDER, { x: 240, y: 135 }, box)).toMatchObject({ x: 0.25, y: 0.25 });
  });

  it("stays on the slide", () => {
    expect(movedTo(DEFAULT_DIVIDER, { x: -5, y: 900 }, box)).toMatchObject({ x: 0, y: 1 });
  });

  it("keeps its angle", () => {
    expect(movedTo(divider({ angle: 30 }), { x: 0, y: 0 }, box).angle).toBe(30);
  });

  it("steps across itself, whichever way it faces", () => {
    expect(shifted(DEFAULT_DIVIDER, 0.1, { width: 100, height: 0 }).x).toBeCloseTo(0.6);
    const flat = shifted(divider({ angle: 90 }), -0.1, { width: 0, height: 100 });
    expect(flat.y).toBeCloseTo(0.4);
  });
});

describe("rotating the divider", () => {
  it("points the handle at the pointer", () => {
    const center = { x: 480, y: 270 };
    const towards = (dx: number, dy: number) =>
      angleTowards(DEFAULT_DIVIDER, { x: center.x + dx, y: center.y + dy }, box, 1);
    expect(towards(0, -100)).toBe(0);
    expect(towards(100, 0)).toBe(90);
    expect(towards(0, 100)).toBe(180);
    expect(towards(-100, 0)).toBe(-90);
    expect(towards(100, -100)).toBe(45);
  });

  it("works from the other end of the line too", () => {
    expect(angleTowards(DEFAULT_DIVIDER, { x: 480, y: 370 }, box, -1)).toBe(0);
    expect(angleTowards(DEFAULT_DIVIDER, { x: 380, y: 270 }, box, -1)).toBe(90);
  });

  it("snaps to steps", () => {
    expect(angleTowards(DEFAULT_DIVIDER, { x: 480 + 100, y: 270 - 90 }, box, 1, 15)).toBe(45);
  });

  it("agrees with where the handle is drawn", () => {
    const turned = divider({ angle: 37, x: 0.4, y: 0.6 });
    expect(angleTowards(turned, knobAt(turned, box, 1), box, 1)).toBe(37);
    expect(angleTowards(turned, knobAt(turned, box, -1), box, -1)).toBe(37);
  });

  it("keeps the handle on the slide", () => {
    expect(knobSide(DEFAULT_DIVIDER, box)).toBe(1);
    expect(knobSide(divider({ y: 0 }), box)).toBe(-1);
    expect(knobSide(divider({ x: 1, angle: 90 }), box)).toBe(-1);
  });

  it("normalizes angles", () => {
    expect(normalAngle(190)).toBe(-170);
    expect(normalAngle(-190)).toBe(170);
    expect(normalAngle(180)).toBe(180);
    expect(normalAngle(-180)).toBe(180);
    expect(normalAngle(720)).toBe(0);
  });
});

describe("sideLabelAt", () => {
  it("puts before on the left and after on the right of an upright divider", () => {
    near(sideLabelAt(DEFAULT_DIVIDER, box, -1, 50), 430, 270);
    near(sideLabelAt(DEFAULT_DIVIDER, box, 1, 50), 530, 270);
  });

  it("puts before above and after below a flat divider", () => {
    near(sideLabelAt(divider({ angle: 90 }), box, -1, 50), 480, 220);
    near(sideLabelAt(divider({ angle: 90 }), box, 1, 50), 480, 320);
  });
});
