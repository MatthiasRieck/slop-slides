import { describe, expect, it } from "vitest";

import type { Screen } from "./api";
import { arrange, choose, defaultChoice, rememberChoice } from "./screens";

const screen = (index: number, x: number, y: number, width = 1920, height = 1080): Screen => ({
  index,
  name: `Screen ${index}`,
  x,
  y,
  width,
  height,
  pixelWidth: width,
  pixelHeight: height,
  primary: index === 0,
});

describe("arrange", () => {
  it("lays screens out as they sit, in percent of the whole", () => {
    const { aspect, boxes } = arrange([screen(0, 0, 0), screen(1, 1920, 0, 1920, 540)]);
    expect(aspect).toBeCloseTo(3840 / 1080);
    expect(boxes[0]).toMatchObject({ left: 0, top: 0, width: 50, height: 100 });
    expect(boxes[1]).toMatchObject({ left: 50, top: 0, width: 50, height: 50 });
  });

  it("copes with screens left of or above the main one (negative positions)", () => {
    const { boxes } = arrange([screen(0, -1920, -1080), screen(1, 0, 0)]);
    expect(boxes[0]).toMatchObject({ left: 0, top: 0, width: 50, height: 50 });
    expect(boxes[1]).toMatchObject({ left: 50, top: 50 });
  });

  it("keeps screens that touch from overlapping", () => {
    // A Retina laptop (1512×982 points) with an ultrawide to its right.
    const { boxes } = arrange([screen(0, 0, 0, 1512, 982), screen(1, 1512, 0, 3440, 1440)]);
    const [laptop, wide] = boxes;
    expect((laptop?.left ?? 0) + (laptop?.width ?? 0)).toBeCloseTo(wide?.left ?? 0);
  });

  it("is empty without screens", () => {
    expect(arrange([]).boxes).toEqual([]);
  });
});

describe("choose", () => {
  it("starts with the show on the last screen and the presenter view on the first", () => {
    expect(defaultChoice([screen(0, 0, 0), screen(1, 1920, 0)])).toEqual({ audience: 1, presenter: 0 });
  });

  it("drops the presenter view when the slides take its screen", () => {
    expect(choose({ audience: 1, presenter: 0 }, "audience", 0)).toEqual({ audience: 0, presenter: null });
  });

  it("keeps the slides when the presenter view is put on their screen", () => {
    expect(choose({ audience: 1, presenter: 0 }, "presenter", 1)).toEqual({ audience: 1, presenter: 0 });
  });

  it("moves one to a free screen", () => {
    expect(choose({ audience: 2, presenter: 0 }, "presenter", 1)).toEqual({ audience: 2, presenter: 1 });
    expect(choose({ audience: 2, presenter: null }, "audience", 1)).toEqual({ audience: 1, presenter: null });
  });
});

describe("rememberChoice", () => {
  const two = [screen(0, 0, 0), screen(1, 1920, 0)];

  it("starts the next picker with the choice last made", () => {
    rememberChoice(two, { audience: 0, presenter: 1 });
    expect(defaultChoice(two)).toEqual({ audience: 0, presenter: 1 });
    rememberChoice(two, { audience: 1, presenter: null });
    expect(defaultChoice(two)).toEqual({ audience: 1, presenter: null });
  });

  it("follows the screens when their order changes", () => {
    rememberChoice(two, { audience: 1, presenter: 0 });
    // Another screen plugged in to the left: the same two screens are now 1 and 2.
    const three = [
      screen(0, -1920, 0),
      { ...screen(1, 0, 0), name: "Screen 0" },
      { ...screen(2, 1920, 0), name: "Screen 1" },
    ];
    expect(defaultChoice(three)).toEqual({ audience: 2, presenter: 1 });
  });

  it("starts as usual when the slides' screen is gone", () => {
    rememberChoice(two, { audience: 1, presenter: 0 });
    const others = [screen(0, 0, 0), { ...screen(1, 3000, 0), name: "Projector" }];
    expect(defaultChoice(others)).toEqual({ audience: 1, presenter: 0 });
  });

  it("puts the presenter view on another screen when its own is gone", () => {
    const three = [screen(0, 0, 0), screen(1, 1920, 0), screen(2, 3840, 0)];
    rememberChoice(three, { audience: 1, presenter: 2 });
    expect(defaultChoice(two)).toEqual({ audience: 1, presenter: 0 });
  });
});
