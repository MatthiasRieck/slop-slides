import { describe, expect, it } from "vitest";

import {
  addHandle,
  backdropFor,
  displayCopy,
  editMarkup,
  elementsOf,
  fmt,
  handlesOf,
  hexOf,
  labelOf,
  luminanceOf,
  moveHandle,
  parsePath,
  parseSvg,
  presentationOf,
  removeHandle,
  replaceSvgInSlide,
  restack,
  serializePath,
  setPresentation,
  translateBy,
  viewBoxOf,
} from "./svgEdit";

const shape = (markup: string) => parseSvg(`<svg>${markup}</svg>`)!.firstElementChild!;
const ids = (el: Element) => handlesOf(el).map((h) => `${h.role}:${h.id}@${fmt(h.x)},${fmt(h.y)}`);

describe("parseSvg", () => {
  it("takes one drawing, as the deck's HTML parser reads it", () => {
    const svg = parseSvg('  <svg viewBox="0 0 10 10"><circle r="1"/></svg>\n');
    expect(svg?.localName).toBe("svg");
    expect(svg?.outerHTML).toBe('<svg viewBox="0 0 10 10"><circle r="1"></circle></svg>');
  });

  it.each([
    ["nothing", ""],
    ["another element", "<div></div>"],
    ["two drawings", "<svg></svg><svg></svg>"],
    ["text beside it", "<svg></svg> hi"],
  ])("refuses %s", (_, markup) => {
    expect(parseSvg(markup)).toBeNull();
  });
});

describe("parsePath and serializePath", () => {
  it("makes every command absolute", () => {
    const d = "m10 10 l5 0 h5 v5 H0 V0 z";
    expect(serializePath(parsePath(d))).toBe("M10 10 L15 10 L20 10 L20 15 L0 15 L0 0 Z");
  });

  it("spells out the control points of S and T", () => {
    expect(serializePath(parsePath("M0 0 C0 10 10 10 10 0 S20 -10 20 0"))).toBe(
      "M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0",
    );
    expect(serializePath(parsePath("M0 0 Q5 10 10 0 T20 0"))).toBe("M0 0 Q5 10 10 0 Q15 -10 20 0");
    expect(serializePath(parsePath("M0 0 s5 5 10 0"))).toBe("M0 0 C0 0 5 5 10 0");
  });

  it("reads relative curves, implicit repeats and compact numbers", () => {
    expect(serializePath(parsePath("M1,1c1,1,2,2,3,3 1,1 2,2 3,3"))).toBe("M1 1 C2 2 3 3 4 4 C5 5 6 6 7 7");
    expect(serializePath(parsePath("M0 0L.5.5-1-1e1"))).toBe("M0 0 L0.5 0.5 L-1 -10");
    expect(serializePath(parsePath("M0 0 10 10 20 0"))).toBe("M0 0 L10 10 L20 0");
  });

  it("reads arcs with flags written together", () => {
    const [, arc] = parsePath("M0 0 a5 5 0 0110 10");
    expect(arc).toEqual({ type: "A", rx: 5, ry: 5, rotation: 0, large: false, sweep: true, to: [10, 10] });
    expect(serializePath(parsePath("M0 0 A5 5 30 1 0 10 10"))).toBe("M0 0 A5 5 30 1 0 10 10");
  });

  it("goes back to the subpath's start after Z", () => {
    expect(serializePath(parsePath("M5 5 l5 0 z l0 5"))).toBe("M5 5 L10 5 Z L5 10");
  });

  it("keeps what it read of broken data", () => {
    expect(serializePath(parsePath("M0 0 L10"))).toBe("M0 0");
    expect(parsePath("")).toEqual([]);
  });
});

describe("handles", () => {
  it("gives a path's points, control points (with what they join) and spots to add points", () => {
    const path = shape('<path d="M0 0 L10 0 C10 10 20 10 20 0"/>');
    expect(ids(path)).toEqual([
      "anchor:to:0@0,0",
      "anchor:to:1@10,0",
      "add:add:1@5,0",
      "control:c1:2@10,10",
      "control:c2:2@20,10",
      "anchor:to:2@20,0",
      "add:add:2@15,7.5",
    ]);
    const c1 = handlesOf(path).find((h) => h.id === "c1:2")!;
    expect(c1.links).toEqual([[10, 0]]);
  });

  it("moves a path's point with the control points beside it", () => {
    const path = shape('<path d="M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0"/>');
    moveHandle(path, "to:1", [12, 2]);
    expect(path.getAttribute("d")).toBe("M0 0 C0 10 12 12 12 2 C12 -8 20 -10 20 0");
    moveHandle(path, "c1:2", [0, 0]);
    expect(path.getAttribute("d")).toBe("M0 0 C0 10 12 12 12 2 C0 0 20 -10 20 0");
  });

  it("adds a point halfway along a stretch without changing its shape, and takes points out", () => {
    const path = shape('<path d="M0 0 L10 0 C10 10 20 10 20 0"/>');
    expect(addHandle(path, "add:1")).toBe("to:1");
    expect(path.getAttribute("d")).toBe("M0 0 L5 0 L10 0 C10 10 20 10 20 0");
    expect(addHandle(path, "add:3")).toBe("to:3");
    expect(path.getAttribute("d")).toBe("M0 0 L5 0 L10 0 C10 5 12.5 7.5 15 7.5 C17.5 7.5 20 5 20 0");
    expect(removeHandle(path, "to:1")).toBe(true);
    expect(path.getAttribute("d")).toBe("M0 0 L10 0 C10 5 12.5 7.5 15 7.5 C17.5 7.5 20 5 20 0");
    // Taking out the start: the path starts at the next point.
    expect(removeHandle(path, "to:0")).toBe(true);
    expect(path.getAttribute("d")).toBe("M10 0 C10 5 12.5 7.5 15 7.5 C17.5 7.5 20 5 20 0");
  });

  it("keeps a path that is one stretch whole", () => {
    const path = shape('<path d="M0 0 L10 0"/>');
    expect(removeHandle(path, "to:1")).toBe(false);
    expect(path.getAttribute("d")).toBe("M0 0 L10 0");
  });

  it("adds a point on the closing stretch of a closed path", () => {
    const path = shape('<path d="M0 0 L10 0 L10 10 Z"/>');
    expect(handlesOf(path).some((h) => h.id === "add:3" && h.x === 5 && h.y === 5)).toBe(true);
    expect(addHandle(path, "add:3")).toBe("to:3");
    expect(path.getAttribute("d")).toBe("M0 0 L10 0 L10 10 L5 5 Z");
  });

  it("edits a polyline's and polygon's points", () => {
    const line = shape('<polyline points="0,0 10,0 10,10"/>');
    expect(ids(line)).toEqual([
      "anchor:pt:0@0,0",
      "anchor:pt:1@10,0",
      "anchor:pt:2@10,10",
      "add:add:0@5,0",
      "add:add:1@10,5",
    ]);
    moveHandle(line, "pt:1", [12, -2]);
    expect(line.getAttribute("points")).toBe("0,0 12,-2 10,10");
    expect(addHandle(line, "add:0")).toBe("pt:1");
    expect(line.getAttribute("points")).toBe("0,0 6,-1 12,-2 10,10");
    expect(removeHandle(line, "pt:1")).toBe(true);
    const gon = shape('<polygon points="0 0 10 0 10 10"/>');
    // A polygon closes: there is a stretch from its last point back to its first, and it keeps three.
    expect(handlesOf(gon).filter((h) => h.role === "add")).toHaveLength(3);
    expect(removeHandle(gon, "pt:0")).toBe(false);
  });

  it("moves a line's ends", () => {
    const line = shape('<line x1="0" y1="0" x2="10" y2="10"/>');
    moveHandle(line, "end:2", [20, 5]);
    expect([line.getAttribute("x2"), line.getAttribute("y2")]).toEqual(["20", "5"]);
    moveHandle(line, "end:1", [1, 1]);
    expect([line.getAttribute("x1"), line.getAttribute("y1")]).toEqual(["1", "1"]);
  });

  it("resizes a rectangle from a corner, the opposite one staying put, past it too", () => {
    const rect = shape('<rect x="10" y="10" width="20" height="10"/>');
    moveHandle(rect, "corner:2", [40, 30]);
    expect(["x", "y", "width", "height"].map((n) => rect.getAttribute(n))).toEqual(["10", "10", "30", "20"]);
    moveHandle(rect, "corner:2", [0, 5]);
    expect(["x", "y", "width", "height"].map((n) => rect.getAttribute(n))).toEqual(["0", "5", "10", "5"]);
  });

  it("moves a circle's or ellipse's center and sets its radius", () => {
    const circle = shape('<circle cx="5" cy="5" r="2"/>');
    expect(ids(circle)).toEqual(["anchor:center@5,5", "control:r@7,5"]);
    moveHandle(circle, "r", [5, 9]);
    expect(circle.getAttribute("r")).toBe("4");
    moveHandle(circle, "center", [0, 1]);
    expect([circle.getAttribute("cx"), circle.getAttribute("cy")]).toEqual(["0", "1"]);
    const ellipse = shape('<ellipse cx="0" cy="0" rx="3" ry="2"/>');
    moveHandle(ellipse, "rx", [-6, 9]);
    moveHandle(ellipse, "ry", [9, 1]);
    expect([ellipse.getAttribute("rx"), ellipse.getAttribute("ry")]).toEqual(["6", "1"]);
  });

  it("has none for elements without points", () => {
    expect(handlesOf(shape("<g></g>"))).toEqual([]);
    expect(handlesOf(shape("<text>Hi</text>"))).toEqual([]);
  });
});

describe("translateBy", () => {
  it("adds to a leading translate, or puts one before the transform", () => {
    const el = shape('<g transform="rotate(45)"></g>');
    translateBy(el, 5, -2);
    expect(el.getAttribute("transform")).toBe("translate(5 -2) rotate(45)");
    translateBy(el, 1, 2);
    expect(el.getAttribute("transform")).toBe("translate(6 0) rotate(45)");
    translateBy(el, -6, 0);
    expect(el.getAttribute("transform")).toBe("rotate(45)");
  });

  it("takes the transform away when it comes back to nothing", () => {
    const el = shape('<rect transform="translate(3,4)"/>');
    translateBy(el, -3, -4);
    expect(el.hasAttribute("transform")).toBe(false);
  });

  it("leaves the drawing itself alone, which the slide places", () => {
    const svg = parseSvg("<svg></svg>")!;
    translateBy(svg, 5, 5);
    expect(svg.hasAttribute("transform")).toBe(false);
  });
});

describe("presentation", () => {
  it("sets the attribute, taking the same property out of the inline style that would win", () => {
    const el = shape('<rect style="fill: red; stroke: blue" fill="green"/>');
    expect(presentationOf(el, "fill")).toBe("red");
    setPresentation(el, "fill", "#00ff00");
    expect(el.getAttribute("fill")).toBe("#00ff00");
    expect(el.getAttribute("style")).toBe("stroke: blue;");
    setPresentation(el, "stroke", "");
    expect(el.hasAttribute("style")).toBe(false);
    setPresentation(el, "fill", " ");
    expect(el.hasAttribute("fill")).toBe(false);
  });

  it("reads plain colors for the color picker", () => {
    expect(hexOf("#ABC")).toBe("#aabbcc");
    expect(hexOf("#123456")).toBe("#123456");
    expect(hexOf("rgb(255, 0, 16)")).toBe("#ff0010");
    expect(hexOf("none")).toBeNull();
    expect(hexOf("var(--brand)")).toBeNull();
  });
});

describe("editing markup", () => {
  it("changes the element at an index and serializes the drawing again", () => {
    const markup = '<svg><g><rect width="1"></rect></g><circle r="1"></circle></svg>';
    expect(elementsOf(parseSvg(markup)!).map((el) => el.localName)).toEqual(["svg", "g", "rect", "circle"]);
    expect(editMarkup(markup, 2, (el) => el.setAttribute("fill", "red"))).toBe(
      '<svg><g><rect width="1" fill="red"></rect></g><circle r="1"></circle></svg>',
    );
    expect(editMarkup(markup, 9, (el) => el.remove())).toBe(markup);
    expect(editMarkup(markup, 1, () => false)).toBe(markup);
  });

  it("restacks among siblings", () => {
    const svg = parseSvg("<svg><rect></rect><circle></circle></svg>")!;
    expect(restack(svg.firstElementChild!, true)).toBe(true);
    expect(svg.outerHTML).toBe("<svg><circle></circle><rect></rect></svg>");
    expect(restack(svg.lastElementChild!, true)).toBe(false);
  });

  it("names elements by their id or first class", () => {
    expect(labelOf(shape('<rect id="box" class="a b"/>'))).toBe("rect#box");
    expect(labelOf(shape('<path class="  a b"/>'))).toBe("path.a");
    expect(labelOf(shape("<g/>"))).toBe("g");
  });
});

describe("displayCopy", () => {
  it("leaves out scripts, handlers and javascript: links, keeping every element's index", () => {
    const svg = parseSvg(
      '<svg onload="x()"><script>alert(1)</script><a href="javascript:x()"><rect onclick="y()"></rect></a><image href="assets/a.png"></image><use href="#a"></use></svg>',
    )!;
    const copy = displayCopy(svg, (url) => `app://deck/${url}`);
    expect(copy.outerHTML).toBe(
      '<svg><g></g><a><rect></rect></a><image href="app://deck/assets/a.png"></image><use href="#a"></use></svg>',
    );
    expect(elementsOf(copy)).toHaveLength(elementsOf(svg).length);
    // The drawing itself is untouched.
    expect(svg.querySelector("script")).not.toBeNull();
  });

  it("leaves absolute and data URLs as they are", () => {
    const svg = parseSvg(
      '<svg><image href="https://x.test/a.png"></image><image href="data:image/png;base64,AA"></image></svg>',
    )!;
    expect(displayCopy(svg, () => "nope").outerHTML).toBe(svg.outerHTML);
  });
});

describe("viewBoxOf", () => {
  it("keeps the drawing's own", () => {
    expect(viewBoxOf(parseSvg('<svg viewBox="0 0 24 24"></svg>')!, { w: 100, h: 100 })).toBe("0 0 24 24");
  });

  it("uses its width and height in pixels, or else its size on the slide", () => {
    expect(viewBoxOf(parseSvg('<svg width="40" height="20px"></svg>')!, { w: 100, h: 50 })).toBe("0 0 40 20");
    expect(viewBoxOf(parseSvg('<svg width="50%"></svg>')!, { w: 100, h: 50 })).toBe("0 0 100 50");
  });
});

describe("replaceSvgInSlide", () => {
  const ORIGINAL = '<svg viewBox="0 0 10 10"><circle r="1"></circle></svg>';
  const DRAFT = '<svg viewBox="0 0 10 10"><circle r="3" fill="red"></circle></svg>';
  const slide = (svg = ORIGINAL) => `<section class="slide" id="a">\n  <h1>Hi</h1>\n  ${svg}\n</section>`;

  it("puts the edited drawing where it was, leaving the rest of the slide as it is", () => {
    expect(replaceSvgInSlide(slide(), [1], ORIGINAL, DRAFT)).toBe(slide(DRAFT));
  });

  it("finds the drawing when it is not at its path any more", () => {
    const moved = `<section class="slide" id="a"><p>New</p><h1>Hi</h1>${ORIGINAL}<svg><rect></rect></svg></section>`;
    expect(replaceSvgInSlide(moved, [1], ORIGINAL, DRAFT)).toBe(
      `<section class="slide" id="a"><p>New</p><h1>Hi</h1>${DRAFT}<svg><rect></rect></svg></section>`,
    );
  });

  it("keeps where the drawing was moved to on the slide since, with the editor's own changes on top", () => {
    const placed = '<svg viewBox="0 0 10 10" style="translate: 40px 0px" data-moved=""><circle r="1"></circle></svg>';
    const draft = '<svg viewBox="0 0 20 20"><circle r="3" fill="red"></circle></svg>';
    expect(replaceSvgInSlide(slide(placed), [1], ORIGINAL, draft)).toBe(
      slide(
        '<svg viewBox="0 0 20 20" style="translate: 40px 0px" data-moved=""><circle r="3" fill="red"></circle></svg>',
      ),
    );
  });

  it("refuses when the drawing itself has changed, or is there twice", () => {
    expect(() => replaceSvgInSlide(slide("<svg><rect></rect></svg>"), [1], ORIGINAL, DRAFT)).toThrow(/has changed/);
    const twice = `<section class="slide" id="a">${ORIGINAL}${ORIGINAL}</section>`;
    expect(() => replaceSvgInSlide(twice, [5], ORIGINAL, DRAFT)).toThrow(/has changed/);
    // At its path, the right one of the two is clear.
    expect(replaceSvgInSlide(twice, [1], ORIGINAL, DRAFT)).toBe(
      `<section class="slide" id="a">${ORIGINAL}${DRAFT}</section>`,
    );
  });

  it("refuses a draft that is not one drawing", () => {
    expect(() => replaceSvgInSlide(slide(), [1], ORIGINAL, "<div></div>")).toThrow(/not one <svg>/);
  });
});

describe("the backdrop", () => {
  const backdrop = (markup: string, color: string | null = null, vars: Record<string, string> = {}) =>
    backdropFor(parseSvg(markup)!, color, vars);

  it("reads how light plain colors are", () => {
    expect(luminanceOf("#fff")).toBeCloseTo(1);
    expect(luminanceOf("White")).toBe(1);
    expect(luminanceOf("black")).toBe(0);
    expect(luminanceOf("rgb(0, 0, 0)")).toBe(0);
    expect(luminanceOf("none")).toBeNull();
    expect(luminanceOf("url(#g)")).toBeNull();
  });

  it("is light for dark drawings and drawings without colors", () => {
    expect(backdrop('<svg><rect fill="#123"></rect></svg>')).toBe("light");
    expect(backdrop("<svg><rect></rect></svg>")).toBe("light");
    expect(backdrop('<svg><rect fill="url(#g)"></rect></svg>')).toBe("light");
  });

  it("is dark when most colors are light, in attributes, styles and style sheets", () => {
    expect(backdrop('<svg><path stroke="white" fill="none"></path></svg>')).toBe("dark");
    expect(backdrop('<svg><rect style="fill: #f8f8f8"></rect></svg>')).toBe("dark");
    expect(backdrop('<svg><style>.a { fill: #fff; stroke: #eee }</style><rect class="a"></rect></svg>')).toBe("dark");
    expect(backdrop('<svg><rect fill="#fff"></rect><rect fill="#000"></rect><rect fill="#111"></rect></svg>')).toBe(
      "light",
    );
  });

  it("follows currentColor and variables as the slide does", () => {
    expect(backdrop('<svg><path stroke="currentColor"></path></svg>', "rgb(255, 255, 255)")).toBe("dark");
    expect(backdrop('<svg><path stroke="currentColor"></path></svg>', "rgb(0, 0, 0)")).toBe("light");
    expect(
      backdrop('<svg><rect fill="var(--ink)"></rect></svg>', null, { "--ink": "var(--white)", "--white": "#fff" }),
    ).toBe("dark");
    expect(backdrop('<svg><rect fill="var(--missing, white)"></rect></svg>')).toBe("dark");
  });
});
