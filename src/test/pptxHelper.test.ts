// @vitest-environment node
/**
 * The PowerPoint export helper (src-tauri/assets/pptx.js), run by the app in the hidden window
 * that exports a deck. It answers each step by navigating to /.pptx-signal?<answer>.
 */
import type { DOMWindow } from "jsdom";
import { describe, expect, it } from "vitest";

import PPTX_JS from "../../src-tauri/assets/pptx.js?raw";
import { openHelper } from "./deckDom";

interface Helper {
  scan: (index: number) => void;
  chunk: (index: number) => void;
  isolate: (index: number, paper: string | null) => void;
}

type Item = Record<string, unknown> & { kind: string };
interface Slide {
  id: string;
  background: Record<string, unknown>;
  items: Item[];
}
interface Scene {
  slides: Slide[];
  shots: { opaque: boolean }[];
}

/** `list[index]`, which a test expects to be there. */
function at<T>(list: T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`nothing at ${index}`);
  return value;
}

/** Every element's box: `data-box="x y w h"`, or the whole 1920×1080 slide. */
function box(el: Element) {
  const [x = 0, y = 0, w = 0, h = 0] = (el.getAttribute("data-box") ?? "0 0 1920 1080").split(" ").map(Number);
  return { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y };
}

/** Loads a deck of `slides`, runs the helper, and records its answers instead of navigating. */
function helper(slides: string, css = "") {
  const page = `<!DOCTYPE html><html><head><style>${css}</style></head><body><main class="deck">${slides}</main></body></html>`;
  const { window, api, answers, settle } = openHelper<Helper>(page, "Pptx", {
    // jsdom has no layout.
    setup(window) {
      window.Element.prototype.getBoundingClientRect = function (this: Element) {
        // The empty mark measuring the top of a line: lines start where their block does.
        if ((this as HTMLElement).style?.verticalAlign === "top" && this.parentElement)
          return box(this.parentElement) as DOMRect;
        return box(this) as DOMRect;
      };
      window.Range.prototype.getBoundingClientRect = function (this: Range) {
        const node = this.startContainer as Element;
        const child = node.childNodes[this.startOffset] as Element | undefined;
        return box(child?.nodeType === 1 ? child : node) as DOMRect;
      };
      window.Range.prototype.getClientRects = function (this: Range) {
        const node = this.startContainer as Element;
        return [{ ...box(node), height: 10 }] as unknown as DOMRectList;
      };
    },
    scripts: [PPTX_JS],
  });
  const scan = async (): Promise<Scene> => {
    await settle();
    // As the app does: a step for each shown slide, the last one telling the size of the answer.
    const shown = window.document.querySelectorAll(".deck > .slide:not([data-hidden])").length;
    for (let i = 0; i < shown; i++) {
      api.scan(i);
      await settle();
    }
    const chunks = Number(at(answers, answers.length - 1).split("chunks=")[1]);
    let encoded = "";
    for (let i = 0; i < chunks; i++) {
      api.chunk(i);
      encoded += at(answers, answers.length - 1).split("data=")[1];
    }
    const bytes = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return JSON.parse(bytes.toString("utf8"));
  };
  return { window, doc: window.document, api, answers, settle, scan };
}

/** Gives `selector::before` and `::after` the `content`, which jsdom does not compute. */
function withPseudos(window: DOMWindow, selector: string, before: string, after: string) {
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((el: Element, which?: string) => {
    if (!which || !el.matches(selector)) return computed(el, which);
    const element = computed(el);
    return {
      content: which === "::before" ? before : after,
      backgroundColor: "rgba(0, 0, 0, 0)",
      backgroundImage: "none",
      position: "static",
      display: "inline",
      whiteSpace: "normal",
      color: "rgb(255, 0, 0)",
      fontFamily: element.fontFamily,
      fontSize: element.fontSize,
    };
  }) as typeof window.getComputedStyle;
}

/** jsdom keeps `border-radius` as written; browsers report these. */
const CORNERS = (radius: string) =>
  ["top-left", "top-right", "bottom-right", "bottom-left"].map((c) => `border-${c}-radius: ${radius}`).join("; ");

const SLIDE = (inner: string, attrs = "") => `<section class="slide" id="s" ${attrs}>${inner}</section>`;

describe("PowerPoint helper", () => {
  it("reports when the deck is ready, counting shown slides only", async () => {
    const { answers, settle } = helper(`${SLIDE("")}<section class="slide" data-hidden></section>`);
    await settle();
    expect(answers).toEqual(["ready&slides=1&view=1024,768"]);
  });

  it("keeps the export under way when a canceled navigation reinjects the helper", async () => {
    const { window, api, answers, settle } = helper(SLIDE("<h1>Title</h1>"));
    await settle();
    api.scan(0);
    await settle();
    window.eval(PPTX_JS);
    await settle();
    const current = (window as unknown as { __slopPptx: Helper }).__slopPptx;
    expect(current).toBe(api);
    expect(answers.filter((a) => a.startsWith("ready"))).toHaveLength(1);
    current.chunk(0);
    expect(answers.at(-1)).toMatch(/^chunk=0&data=./);
  });

  it("reads one slide for each step, so that no step outlasts a hidden window's timers", async () => {
    const { api, answers, settle, scan } = helper(
      `<section class="slide" id="a"><h1>One</h1></section><section class="slide" id="b"></section><section class="slide" id="c"></section>`,
    );
    await settle();
    api.scan(0);
    await settle();
    expect(answers.slice(1)).toEqual(["scanned=0&slides=3"]);
    api.scan(1);
    await settle();
    expect(answers.slice(1)).toEqual(["scanned=0&slides=3", "scanned=1&slides=3"]);
    api.scan(2);
    await settle();
    expect(answers.at(-1)).toMatch(/^scanned=2&slides=3&chunks=[1-9]\d*$/);
    // Starting over reads the deck anew.
    expect((await scan()).slides.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("answers at once for a slide that is gone, or one it cannot read", async () => {
    const { window, doc, api, answers, settle } = helper(
      `<section class="slide" id="a"><h1>One</h1></section><section class="slide" id="b"></section>`,
    );
    await settle();
    doc.getElementById("b")?.setAttribute("data-hidden", "");
    api.scan(1);
    expect(answers.at(-1)).toBe("scanned=1&slides=1");
    window.getComputedStyle = () => {
      throw new TypeError("no styles");
    };
    api.scan(0);
    await settle();
    expect(answers.at(-1)).toBe(`scanned=0&slides=1&error=${encodeURIComponent("TypeError: no styles")}`);
  });

  it("skips hidden slides in the scene", async () => {
    const scene = await helper(
      `<section class="slide" id="a"></section><section class="slide" id="b" data-hidden></section>`,
    ).scan();
    expect(scene.slides.map((s) => s.id)).toEqual(["a"]);
  });

  it("reads a box's transparency, border, radius and shadow as native effects", async () => {
    const { slides } = await helper(
      SLIDE(
        `<div data-box="10 20 100 50" style="background-color: rgba(255, 0, 0, 0.5); border: 2px dashed rgb(0, 0, 255); ${CORNERS("8px")}; box-shadow: rgba(0, 0, 0, 0.3) 0px 10px 40px 0px; opacity: 0.5; backdrop-filter: blur(20px)"></div>`,
      ),
    ).scan();
    const item = at(at(slides, 0).items, 0);
    expect(item).toMatchObject({
      kind: "box",
      fill: { color: [255, 0, 0, 0.5] },
      border: { color: [0, 0, 255, 1], width: 2, dash: "dashed" },
      shadow: { color: [0, 0, 0, 0.3], x: 0, y: 10, blur: 40 },
      radius: 8,
      opacity: 0.5,
    });
  });

  it("draws one-sided rules as thin boxes, and circles as ellipses", async () => {
    const { slides } = await helper(
      SLIDE(
        `<div data-box="0 0 100 50" style="border-bottom: 4px solid rgb(1, 2, 3)"></div>
         <div data-box="0 0 10 10" style="background-color: red; ${CORNERS("50%")}"></div>`,
      ),
    ).scan();
    expect(at(at(slides, 0).items, 0)).toMatchObject({
      kind: "box",
      x: 0,
      y: 46,
      w: 100,
      h: 4,
      fill: { color: [1, 2, 3, 1] },
    });
    expect(at(at(slides, 0).items, 1)).toMatchObject({ kind: "box", ellipse: true });
  });

  it("reads linear gradients, filling in stop positions", async () => {
    const { slides } = await helper(
      SLIDE(
        `<div data-box="0 0 10 10" style="background-image: linear-gradient(90deg, rgb(0, 0, 0), rgb(1, 1, 1), rgb(2, 2, 2) 80%)"></div>`,
      ),
    ).scan();
    expect(at(at(slides, 0).items, 0)).toMatchObject({
      fill: {
        gradient: {
          angle: 90,
          stops: [
            { at: 0, color: [0, 0, 0, 1] },
            { at: 0.4, color: [1, 1, 1, 1] },
            { at: 0.8, color: [2, 2, 2, 1] },
          ],
        },
      },
    });
  });

  it("pictures what PowerPoint cannot draw, and keeps its text as text", async () => {
    const { slides, shots } = await helper(
      SLIDE(
        `<svg data-box="0 0 10 10"></svg>
         <div data-box="0 0 10 10" style="filter: blur(8px)"><p>Lost in the picture</p></div>
         <div data-box="0 0 10 10" style="background-image: radial-gradient(red, blue)">Kept</div>`,
      ),
    ).scan();
    expect(at(slides, 0).items.map((i) => i.kind)).toEqual(["shot", "shot", "shot", "text"]);
    expect(shots).toEqual([{ opaque: false }, { opaque: false }, { opaque: false }]);
  });

  it("ignores filters left over from entrance animations", async () => {
    const { slides } = await helper(
      SLIDE(`<p data-box="0 0 100 20" style="filter: blur(0px); transform: matrix(1, 0, 0, 1, 0, 0)">Sharp</p>`),
    ).scan();
    expect(at(slides, 0).items.map((i) => i.kind)).toEqual(["text"]);
  });

  it("reads text as runs, with collapsed spaces, breaks, links and transforms", async () => {
    const { slides } = await helper(
      SLIDE(
        `<p data-box="10 20 500 40" style="font-size: 40px; font-family: 'Inter', sans-serif; color: rgb(1, 2, 3); line-height: 48px; text-align: center; text-transform: uppercase; letter-spacing: 2px">
           Hello   <b style="font-weight: 700">bold</b><br><a href="#next" style="font-style: italic">link</a>
         </p>`,
      ),
    ).scan();
    const item = at(at(slides, 0).items, 0);
    const paragraph = at(
      item.paragraphs as { align: string; lineHeight: number; runs: Record<string, unknown>[] }[],
      0,
    );
    expect(item).toMatchObject({ kind: "text", x: 10, y: 20, wrap: false });
    expect(paragraph).toMatchObject({ align: "center", lineHeight: 48 });
    expect(paragraph.runs.map((r) => r.text)).toEqual(["HELLO ", "BOLD", "", "LINK"]);
    expect(at(paragraph.runs, 0)).toMatchObject({
      font: "Inter",
      size: 40,
      spacing: 2,
      color: [1, 2, 3, 1],
      bold: false,
    });
    expect(at(paragraph.runs, 1)).toMatchObject({ bold: true });
    expect(at(paragraph.runs, 2)).toMatchObject({ lineBreak: true });
    expect(at(paragraph.runs, 3)).toMatchObject({ italic: true, link: "#next" });
  });

  it("gives text its parent's opacity, and gradient text the gradient's first colour", async () => {
    const { slides } = await helper(
      SLIDE(
        `<div style="opacity: 0.5"><p style="color: rgb(9, 9, 9)">Faded</p></div>
         <p style="-webkit-text-fill-color: transparent; background-clip: text; background-image: linear-gradient(90deg, rgb(7, 8, 9), rgb(0, 0, 0))">Shiny</p>`,
      ),
    ).scan();
    const colors = at(slides, 0).items.map(
      (i) => at(at(i.paragraphs as { runs: { color: number[] }[] }[], 0).runs, 0).color,
    );
    expect(colors).toEqual([
      [9, 9, 9, 0.5],
      [7, 8, 9, 1],
    ]);
  });

  it("makes one text box of a plain list, with markers and spacing", async () => {
    const { slides } = await helper(
      SLIDE(
        `<ul data-box="100 100 400 100">
           <li data-box="140 100 300 30" style="list-style-type: disc">One</li>
           <li data-box="140 150 300 30" style="list-style-type: disc">Two</li>
         </ul>
         <ol data-box="0 0 100 20" start="3"><li data-box="30 0 70 20" style="list-style-type: lower-roman">Three</li></ol>`,
      ),
    ).scan();
    const bullets = at(at(slides, 0).items, 0);
    const numbers = at(at(slides, 0).items, 1);
    const paragraphs = bullets.paragraphs as Record<string, unknown>[];
    expect(bullets).toMatchObject({ kind: "text", x: 100, y: 100, wrap: true });
    expect(at(paragraphs, 0)).toMatchObject({ bullet: { char: "•" }, marginLeft: 40 });
    expect(at(paragraphs, 1)).toMatchObject({ spaceBefore: 20 });
    expect(at(numbers.paragraphs as Record<string, unknown>[], 0)).toMatchObject({
      bullet: { number: "lower-roman", start: 3 },
    });
  });

  it("numbers list items split over text boxes by their place in the list", async () => {
    const { slides } = await helper(
      SLIDE(
        `<ol data-box="0 0 100 90" start="2" style="list-style-type: decimal">
           <li data-box="30 0 70 30">Two<ul><li data-box="60 10 40 10" style="list-style-type: disc">Deep</li></ul></li>
           <li data-box="30 30 70 30">Three</li>
           <li data-box="30 60 70 30" value="9">Nine</li>
         </ol>`,
      ),
    ).scan();
    const shown = at(slides, 0).items.flatMap(
      (item) => item.paragraphs as { bullet?: { start?: number; number?: string } }[],
    );
    expect(shown.filter((p) => p.bullet?.number).map((p) => p.bullet?.start)).toEqual([2, 3, 9]);
  });

  it("marks sub- and superscript, however deep the text inside them", async () => {
    const { slides } = await helper(
      SLIDE(
        `<p data-box="0 0 500 40">H<sub>2<b>x</b></sub>O<sup style="vertical-align: super">n</sup><span style="vertical-align: 6px; font-size: 20px">up</span></p>`,
      ),
    ).scan();
    const runs = at(at(slides, 0).items[0]?.paragraphs as { runs: { text: string; baseline: number }[] }[], 0).runs;
    expect(runs.map((r) => [r.text, r.baseline])).toEqual([
      ["H", 0],
      ["2", -25],
      ["x", -25],
      ["O", 0],
      ["n", 30],
      ["up", 20],
    ]);
  });

  it("takes in the text of pseudo-elements beside the text, from the start of the block", async () => {
    const h = helper(
      SLIDE(
        `<p class="c" data-box="100 50 500 40" style="padding-left: 10px"><b data-box="200 50 100 40">Bold</b> rest</p>`,
      ),
    );
    withPseudos(h.window, ".c", '"→ "', '" ←"');
    const { slides } = await h.scan();
    const item = at(at(slides, 0).items, 0);
    const runs = at(item.paragraphs as { runs: { text: string; color: number[] }[] }[], 0).runs;
    expect(runs.map((r) => r.text).join("")).toBe("→ Bold rest ←");
    expect(at(runs, 0).color).toEqual([255, 0, 0, 1]);
    expect(item).toMatchObject({ x: 110, w: 490 });
  });

  it("gives pseudo-element text to the first and last text only, around a block between", async () => {
    const h = helper(
      SLIDE(
        `<div class="c" data-box="0 0 500 200">Top<div data-box="0 50 500 40" style="display: block">Mid</div>End</div>`,
      ),
    );
    withPseudos(h.window, ".c", '"A"', '"Z"');
    const { slides } = await h.scan();
    const words = at(slides, 0).items.map((item) =>
      at(item.paragraphs as { runs: { text: string }[] }[], 0)
        .runs.map((r) => r.text)
        .join(""),
    );
    expect(words).toEqual(["ATop", "Mid", "EndZ"]);
  });

  it("places text by its line, leaves the page as it was, and keeps to whole pixels", async () => {
    const h = helper(SLIDE(`<p data-box="10 20.4 500 40" style="line-height: 40px">Hello</p>`));
    const { slides } = await h.scan();
    expect(at(at(slides, 0).items, 0)).toMatchObject({ y: 20 });
    expect(h.doc.querySelector("p")?.children).toHaveLength(0);
  });

  it("estimates the line in flex boxes, where a measuring mark would become an item", async () => {
    const h = helper(SLIDE(`<div data-box="10 20 500 30" style="display: flex; line-height: 30px">Hello</div>`));
    const { slides } = await h.scan();
    // The mock's glyphs are 10 tall in a line of 30.
    expect(at(at(slides, 0).items, 0)).toMatchObject({ y: 10 });
  });

  it("lets wrapped text keep its block's width past the space hanging off a line", async () => {
    const h = helper(SLIDE(`<p data-box="0 0 784 90" style="font-size: 34px">Wrapping text</p>`));
    h.window.Range.prototype.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 793, bottom: 90, width: 793, height: 90, x: 0, y: 0 }) as DOMRect;
    h.window.Range.prototype.getClientRects = () =>
      [
        { left: 0, top: 0, bottom: 40, width: 793, height: 40 },
        { left: 0, top: 45, bottom: 85, width: 500, height: 40 },
      ] as unknown as DOMRectList;
    const { slides } = await h.scan();
    expect(at(at(slides, 0).items, 0)).toMatchObject({ x: 0, w: 784, wrap: true });
  });

  it("pictures a 3D transform with room for what it paints outside its box", async () => {
    const h = helper(
      SLIDE(
        `<div data-box="400 400 200 100" style="width: 200px; height: 100px; background: linear-gradient(red, blue); transform: matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)"></div>`,
      ),
    );
    await h.scan();
    h.api.isolate(0, "#000000");
    await h.settle();
    expect(at(h.answers, h.answers.length - 1)).toContain("rect=350,350,300,200");
  });

  it("keeps attached images as files, and pictures anything else", async () => {
    const scene = await helperWithImages().scan();
    expect(at(scene.slides, 0).items).toMatchObject([
      { kind: "image", src: "assets/photo.png", alt: "Photo", crop: { l: 0.25, r: 0.25, t: 0, b: 0 } },
      { kind: "shot" },
    ]);
  });

  it("reads rotation and pictures skewed elements", async () => {
    const { slides } = await helper(
      SLIDE(
        `<p data-box="0 0 100 20" style="transform: matrix(0, 1, -1, 0, 0, 0)">Turned</p>
         <p data-box="0 0 100 20" style="transform: matrix(1, 0, 0.5, 1, 0, 0)">Skewed</p>
         <div data-box="0 0 100 20" style="rotate: 10deg"><div><p>Nested</p></div></div>`,
      ),
    ).scan();
    expect(at(slides, 0).items.map((i) => i.kind)).toEqual(["text", "shot", "shot"]);
    expect(at(at(slides, 0).items, 0)).toMatchObject({ rotation: 90 });
  });

  it("keeps the text of a turned text box as text, in the block the editor holds it in", async () => {
    const { slides } = await helper(
      SLIDE(
        `<div data-added="text" data-box="100 100 400 200" style="display: flex; rotate: 10deg"><div data-text-body="">One <span style="font-weight: 700">bold</span><br>Two</div></div>`,
      ),
    ).scan();
    expect(at(slides, 0).items.map((i) => i.kind)).toEqual(["text"]);
    const text = at(at(slides, 0).items, 0);
    expect(text).toMatchObject({ rotation: 10, x: 100, y: 100, w: 400, h: 200 });
    const paragraphs = text.paragraphs as { runs: { text: string }[] }[];
    expect(at(paragraphs, 0).runs.map((run) => run.text)).toEqual(["One ", "bold", "", "Two"]);
  });

  it("orders items by stacking order, then by document order", async () => {
    const { slides } = await helper(
      SLIDE(
        `<p style="position: relative; z-index: 2">Top</p><p>Bottom</p><p style="position: absolute; z-index: -1">Back</p>`,
      ),
    ).scan();
    const words = at(slides, 0).items.map(
      (i) => at(at(i.paragraphs as { runs: { text: string }[] }[], 0).runs, 0).text,
    );
    expect(words).toEqual(["Back", "Bottom", "Top"]);
  });

  it("leaves notes, narration and hidden elements out", async () => {
    const { slides } = await helper(
      SLIDE(
        `<aside class="notes">Secret</aside><aside class="narration">Spoken</aside><p style="display: none">Gone</p><p style="opacity: 0">Clear</p>`,
      ),
    ).scan();
    expect(at(slides, 0).items).toEqual([]);
  });

  it("finds each slide's background", async () => {
    const { slides, shots } = await helper(
      `<section class="slide" id="a" style="background-color: rgb(1, 2, 3)"></section>
       <section class="slide" id="b" style="background-image: linear-gradient(0deg, rgb(0, 0, 0), rgb(1, 1, 1))"></section>
       <section class="slide" id="c"></section>
       <section class="slide" id="d" style="background-image: radial-gradient(red, blue)"></section>`,
    ).scan();
    expect(at(slides, 0).background).toEqual({ color: [1, 2, 3, 1] });
    expect(at(slides, 1).background).toMatchObject({ gradient: { angle: 0 } });
    expect(at(slides, 2).background).toEqual({ color: [255, 255, 255, 1] });
    expect(at(slides, 3).background).toEqual({ shot: 0 });
    expect(shots).toEqual([{ opaque: true }]);
  });

  it("survives every character when sending the scene in pieces", async () => {
    const text = "日本語 🎉 ".repeat(9000);
    const { slides } = await helper(SLIDE(`<p>${text}</p>`)).scan();
    const runs = at(at(at(slides, 0).items, 0).paragraphs as { runs: { text: string }[] }[], 0).runs;
    expect(at(runs, 0).text).toBe(text.trim());
  });

  it("shows shots with rules that outrank the one hiding everything", async () => {
    // jsdom does not weigh selectors, so an element that stays hidden in a browser passes above.
    const h = helper(SLIDE(`<svg data-box="0 0 10 10"></svg>`));
    await h.scan();
    h.api.isolate(0, null);
    const css = h.doc.querySelector("style[data-slop-pptx]")?.textContent ?? "";
    const selectors = css
      .split(/[{}]/)
      .filter((_, i) => i % 2 === 0)
      .flatMap((rule) => rule.split(","));
    const shots = selectors.filter((selector) => selector.includes("data-slop-pptx-shot="));
    expect(shots.length).toBeGreaterThan(0);
    for (const selector of shots) expect(selector.trim()).toMatch(/^html\[data-slop-pptx\] /);
  });

  it("shows only the asked-for shot, on the asked-for paper, and says where it is", async () => {
    const h = helper(SLIDE(`<svg data-box="100 200 300 400"></svg>`));
    await h.scan();
    h.api.isolate(0, "#000000");
    await h.settle();
    expect(h.doc.documentElement.hasAttribute("data-slop-pptx")).toBe(true);
    expect(h.doc.documentElement.style.getPropertyValue("--slop-pptx-paper")).toBe("#000000");
    expect(h.doc.querySelector("svg")?.getAttribute("data-slop-pptx-shot")).toBe("all");
    expect(at(h.answers, h.answers.length - 1)).toBe("isolated=0&rect=100,200,300,400&view=1024,768&scale=1");
  });
});

/** A deck with an attached photo, cropped by `object-fit`, and a format PowerPoint has not. */
function helperWithImages() {
  const h = helper(
    SLIDE(
      `<img data-box="0 0 100 100" src="assets/photo.png" alt="Photo" style="object-fit: cover">
       <img data-box="0 0 100 100" src="assets/art.webp" alt="">`,
    ),
  );
  for (const img of h.doc.querySelectorAll("img")) {
    Object.defineProperty(img, "naturalWidth", { value: 200 });
    Object.defineProperty(img, "naturalHeight", { value: 100 });
  }
  return h;
}
