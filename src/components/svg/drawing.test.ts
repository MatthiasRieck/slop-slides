import { describe, expect, it } from "vitest";

import { duplicate, scaling, subtreeSize, withAncestors } from "./drawing";

const svgOf = (markup: string) => new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;

describe("resizing", () => {
  const box = { x: 10, y: 20, w: 100, h: 50 };
  const keys = { shiftKey: false, altKey: false };

  it("scales from the opposite corner or side, which stays put", () => {
    expect(scaling([1, 1], box, 50, 25, keys)).toEqual({ sx: 1.5, sy: 1.5, ox: 10, oy: 20 });
    expect(scaling([-1, 0], box, 50, 999, keys)).toEqual({ sx: 0.5, sy: 1, ox: 110, oy: 45 });
    expect(scaling([0, -1], box, 0, -50, keys)).toEqual({ sx: 1, sy: 2, ox: 60, oy: 70 });
  });

  it("keeps the proportions with Shift, and resizes from the middle with Alt", () => {
    expect(scaling([1, 1], box, 100, 0, { ...keys, shiftKey: true })).toEqual({ sx: 2, sy: 2, ox: 10, oy: 20 });
    expect(scaling([1, 0], box, 50, 0, { ...keys, shiftKey: true })).toEqual({ sx: 1.5, sy: 1.5, ox: 10, oy: 45 });
    expect(scaling([1, 0], box, 50, 0, { ...keys, altKey: true })).toEqual({ sx: 2, sy: 1, ox: 60, oy: 45 });
  });

  it("never shrinks an element to nothing or turns it over", () => {
    expect(scaling([1, 1], box, -500, -500, keys)).toMatchObject({ sx: 0.02, sy: 0.02 });
  });
});

describe("the drawing's elements", () => {
  it("counts an element with all inside it", () => {
    const svg = svgOf(`<svg xmlns="http://www.w3.org/2000/svg"><g><rect/><circle/></g><path/></svg>`);
    expect(subtreeSize(svg.querySelector("g")!)).toBe(3);
    expect(subtreeSize(svg.querySelector("path")!)).toBe(1);
  });

  it("duplicates an element right after it, without its ids", () => {
    const svg = svgOf(`<svg xmlns="http://www.w3.org/2000/svg"><g id="a"><rect id="b" width="4"/></g><path/></svg>`);
    duplicate(svg.querySelector("g")!);
    const [first, copy] = [...svg.children];
    expect(first!.id).toBe("a");
    expect(copy!.localName).toBe("g");
    expect(copy!.hasAttribute("id")).toBe(false);
    expect(copy!.querySelector("rect")!.hasAttribute("id")).toBe(false);
    expect(copy!.querySelector("rect")!.getAttribute("width")).toBe("4");
    expect(svg.lastElementChild!.localName).toBe("path");
  });

  it("mirrors the elements a drawing sits in, outermost first, without what would load or run", () => {
    const copy = svgOf(`<svg xmlns="http://www.w3.org/2000/svg"/>`);
    const outer = withAncestors(copy, [
      { tag: "section", attrs: { class: "slide", "bad name": "x" } },
      { tag: "iframe", attrs: { class: "figure" } },
    ]);
    expect(outer.localName).toBe("section");
    expect(outer.getAttribute("class")).toBe("slide");
    const inner = outer.firstElementChild as HTMLElement;
    expect(inner.localName).toBe("div");
    expect(inner.className).toBe("figure");
    expect(inner.style.getPropertyValue("display")).toBe("contents");
    expect(inner.firstElementChild).toBe(copy);
  });
});
