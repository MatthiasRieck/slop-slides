/**
 * The PowerPoint export helper (src-tauri/assets/pptx.js), run by the app in the hidden window
 * that exports a deck. It answers each step by navigating to /.pptx-signal?<answer>.
 */
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import PPTX_JS from "../../src-tauri/assets/pptx.js?raw";

let doms: JSDOM[] = [];

afterEach(() => {
  for (const d of doms) d.window.close();
  doms = [];
  vi.useRealTimers();
});

interface Helper {
  scan: () => void;
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
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const page = `<!DOCTYPE html><html><head><style>${css}</style></head><body><main class="deck">${slides}</main></body></html>`;
  const dom = new JSDOM(page, { url: "https://example.test/talk/deck.html?static&print", runScripts: "outside-only" });
  doms.push(dom);
  const { window } = dom;
  const answers: string[] = [];
  Object.assign(window, { __slopPptxSignal: (answer: string) => answers.push(answer) });
  // jsdom has no layout.
  window.Element.prototype.getBoundingClientRect = function (this: Element) {
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
  window.eval(PPTX_JS);
  const api = (window as unknown as { __slopPptx: Helper }).__slopPptx;
  const settle = async () => {
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(5000);
  };
  const scan = async (): Promise<Scene> => {
    await settle();
    api.scan();
    await settle();
    const chunks = Number(answers.find((a) => a.startsWith("scanned"))?.split("chunks=")[1]);
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

/** jsdom keeps `border-radius` as written; browsers report these. */
const CORNERS = (radius: string) =>
  ["top-left", "top-right", "bottom-right", "bottom-left"].map((c) => `border-${c}-radius: ${radius}`).join("; ");

const SLIDE = (inner: string, attrs = "") => `<section class="slide" id="s" ${attrs}>${inner}</section>`;

describe("PowerPoint helper", () => {
  it("reports when the deck is ready, counting shown slides only", async () => {
    const { answers, settle } = helper(`${SLIDE("")}<section class="slide" data-hidden></section>`);
    await settle();
    expect(answers).toEqual(["ready&slides=1"]);
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
