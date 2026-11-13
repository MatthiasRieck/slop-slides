import { beforeEach, describe, expect, it } from "vitest";

import type { Screen } from "./api";
import { loadChoice, saveChoice } from "./screens";

const screen = (index: number, x: number, name = `Screen ${index}`): Screen => ({
  index,
  name,
  x,
  y: 0,
  width: 1920,
  height: 1080,
  pixelWidth: 1920,
  pixelHeight: 1080,
  primary: index === 0,
});

const desk = [screen(0, 0), screen(1, 1920)];
const hall = [screen(0, 0), screen(1, 1920, "Projector"), screen(2, 3840, "Confidence monitor")];

beforeEach(() => localStorage.clear());

describe("the screens picked last", () => {
  it("is the default until something is picked", () => {
    expect(loadChoice(desk)).toEqual({ audience: 1, presenter: 0 });
  });

  it("is remembered for each set of screens on its own", () => {
    saveChoice(desk, { audience: 0, presenter: 1 });
    saveChoice(hall, { audience: 1, presenter: 2 });
    expect(loadChoice(desk)).toEqual({ audience: 0, presenter: 1 });
    expect(loadChoice(hall)).toEqual({ audience: 1, presenter: 2 });
    saveChoice(desk, { audience: 1, presenter: null });
    expect(loadChoice(desk)).toEqual({ audience: 1, presenter: null });
    // Another arrangement of the same screens is another set.
    expect(loadChoice([screen(0, 1920), screen(1, 0)])).toEqual({ audience: 1, presenter: 0 });
  });

  it("falls back when what is stored does not fit the screens", () => {
    const key = "slopslide.screenChoices";
    saveChoice(desk, { audience: 5, presenter: 0 });
    expect(loadChoice(desk)).toEqual({ audience: 1, presenter: 0 });
    saveChoice(desk, { audience: 1, presenter: 1 });
    expect(loadChoice(desk)).toEqual({ audience: 1, presenter: null });
    saveChoice(desk, { audience: 0, presenter: 7 });
    expect(loadChoice(desk)).toEqual({ audience: 0, presenter: null });
    localStorage.setItem(key, "not json");
    expect(loadChoice(desk)).toEqual({ audience: 1, presenter: 0 });
    localStorage.setItem(key, JSON.stringify({ nonsense: true }));
    expect(loadChoice(desk)).toEqual({ audience: 1, presenter: 0 });
    localStorage.setItem(key, JSON.stringify([["x"], null, 4]));
    expect(loadChoice(desk)).toEqual({ audience: 1, presenter: 0 });
  });

  it("keeps only the sets used last", () => {
    for (let i = 0; i < 20; i++) saveChoice([screen(0, 0), screen(1, 1000 + i)], { audience: 0, presenter: 1 });
    expect(JSON.parse(localStorage.getItem("slopslide.screenChoices") ?? "[]")).toHaveLength(12);
    expect(loadChoice([screen(0, 0), screen(1, 1019)])).toEqual({ audience: 0, presenter: 1 });
    expect(loadChoice([screen(0, 0), screen(1, 1000)])).toEqual({ audience: 1, presenter: 0 });
  });
});
