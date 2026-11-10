import { describe, expect, it } from "vitest";

import { duplicate, subtreeSize, withAncestors } from "./drawing";

const svgOf = (markup: string) => new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;

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
