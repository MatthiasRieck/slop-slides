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
    expect(answers.slice(1)).toEqual(["scanned=0"]);
    api.scan(1);
    await settle();
    expect(answers.slice(1)).toEqual(["scanned=0", "scanned=1"]);
    api.scan(2);
    await settle();
    expect(answers.at(-1)).toMatch(/^scanned=2&chunks=[1-9]\d*$/);
    // Starting over reads the deck anew.
    expect((await scan()).slides.map((s) => s.id)).toEqual(["a", "b", "c"]);
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

  describe("the anchor of a text box", () => {
    const BOX = `data-box="100 100 300 100"`;
    const FILL = "background-color: rgb(0, 0, 255)";
    const anchors = async (html: string) => {
      const { slides } = await helper(SLIDE(html)).scan();
      return at(slides, 0)
        .items.filter((item) => item.kind === "text")
        .map((item) => item.anchor);
    };

    it("is the middle for text a box centres, by flex, grid, a table cell or even padding", async () => {
      expect(
        await anchors(
          `<div ${BOX} style="display: flex; align-items: center; ${FILL}"><p data-box="100 140 300 20">Row</p></div>
           <div ${BOX} style="display: flex; flex-direction: column; justify-content: center; ${FILL}"><p data-box="100 140 300 20">Column</p></div>
           <div ${BOX} style="display: grid; align-items: center; ${FILL}"><p data-box="100 140 300 20">Grid</p></div>
           <div ${BOX} style="display: table-cell; vertical-align: middle; ${FILL}"><p data-box="100 140 300 20">Cell</p></div>
           <div ${BOX} style="padding: 40px 0; ${FILL}"><p data-box="100 140 300 20">Padded</p></div>
           <div ${BOX} style="display: flex; align-items: center"><p data-box="100 140 300 20">No fill</p></div>`,
        ),
      ).toEqual(["center", "center", "center", "center", "center", "center"]);
    });

    it("looks through wrappers to the box that centres the text", async () => {
      expect(
        await anchors(
          `<div ${BOX} style="display: flex; align-items: center; ${FILL}">
             <div data-box="100 140 300 20"><p data-box="100 140 300 20">Deep</p></div>
           </div>`,
        ),
      ).toEqual(["center"]);
    });

    it("is the bottom for text a box pushes down, and the top otherwise", async () => {
      expect(
        await anchors(
          `<div ${BOX} style="display: flex; flex-direction: column; justify-content: flex-end; ${FILL}"><p data-box="100 170 300 20">Bottom</p></div>
           <div ${BOX} style="${FILL}"><p data-box="100 110 300 20">Top</p></div>
           <div ${BOX} style="padding-top: 70px; ${FILL}"><p data-box="100 170 300 20">Padded down</p></div>
           <div ${BOX}><p data-box="100 140 300 20">No box, no alignment</p></div>`,
        ),
      ).toEqual(["bottom", "top", "top", "top"]);
    });

    it("stays the top for text stacked with other content, but not for what stands beside it", async () => {
      expect(
        await anchors(
          `<div ${BOX} style="display: flex; flex-direction: column; justify-content: center; ${FILL}">
             <p data-box="100 125 300 20">Title</p><p data-box="100 155 300 20">Subtitle</p>
           </div>
           <div ${BOX} style="display: flex; align-items: center; ${FILL}">
             <i data-box="100 130 40 40" style="display: block"></i><p data-box="150 140 250 20">Beside an icon</p>
           </div>`,
        ),
      ).toEqual(["top", "top", "center"]);
    });

    it("follows the box for turned text and for text a pseudo-element writes", async () => {
      expect(
        await anchors(
          `<div ${BOX} style="width: 300px; height: 100px; transform: matrix(0, 1, -1, 0, 0, 0); display: flex; flex-direction: column; justify-content: center"><p>Turned</p></div>
           <div ${BOX} style="width: 300px; height: 100px; transform: matrix(0, 1, -1, 0, 0, 0); display: flex; flex-direction: column; justify-content: flex-end"><p>Turned down</p></div>`,
        ),
      ).toEqual(["center", "bottom"]);
      const h = helper(
        SLIDE(
          `<div class="badge" ${BOX} style="display: flex; align-items: center"></div><div class="badge" ${BOX}></div>`,
        ),
      );
      withPseudos(h.window, ".badge", '"1"', "none");
      const { slides } = await h.scan();
      expect(at(slides, 0).items.map((item) => item.anchor)).toEqual(["center", "top"]);
    });

    it("starts a list's text box at its first item, under the list's padding", async () => {
      const { slides } = await helper(
        SLIDE(
          `<ul ${BOX} style="padding: 30px 0; ${FILL}">
             <li data-box="140 130 260 20" style="list-style-type: disc">One</li>
             <li data-box="140 150 260 20" style="list-style-type: disc">Two</li>
           </ul>`,
        ),
      ).scan();
      const list = at(at(slides, 0).items, 1);
      expect(list).toMatchObject({ kind: "text", x: 100, y: 130, w: 300, h: 40, anchor: "center" });
    });
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

type Matrix = [number, number, number, number, number, number];

function times(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** A `transform` attribute of translates, scales, rotations and matrices. */
function transformOf(text: string | null): Matrix {
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  for (const [, name, list] of (text ?? "").matchAll(/(\w+)\(([^)]*)\)/g)) {
    const [a = 0, b, c = 0, d = 0, e = 0, f = 0] = (list ?? "").split(/[\s,]+/).map(Number);
    const turn = (a * Math.PI) / 180;
    if (name === "translate") m = times(m, [1, 0, 0, 1, a, b ?? 0]);
    else if (name === "scale") m = times(m, [a, 0, 0, b ?? a, 0, 0]);
    else if (name === "rotate") {
      // About (b, c), when given.
      const spin: Matrix = [Math.cos(turn), Math.sin(turn), -Math.sin(turn), Math.cos(turn), 0, 0];
      m = times(times(times(m, [1, 0, 0, 1, b ?? 0, c]), spin), [1, 0, 0, 1, -(b ?? 0), -c]);
    } else if (name === "matrix") m = times(m, [a, b ?? 0, c, d, e, f]);
  }
  return m;
}

/** What SVG elements inherit, and what they have when nothing says otherwise. */
const SVG_INHERITED = new Set(
  "fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray fill-opacity stroke-opacity font-size font-family font-weight text-anchor marker-start marker-end".split(
    " ",
  ),
);
const SVG_INITIAL: Record<string, string> = {
  fill: "rgb(0, 0, 0)",
  stroke: "none",
  "stroke-width": "1",
  "font-size": "16px",
};

/**
 * Gives jsdom what a browser knows of an SVG: where each element is drawn (its `transform`s,
 * as `getScreenCTM` multiplies them; the helper itself reads the `viewBox`), the boxes of its
 * text (`data-bbox="x y w h"`), and its presentation attributes as computed style.
 */
function withSvg(window: DOMWindow) {
  const inside = (el: Element | null): el is SVGElement => !!el && el instanceof window.SVGElement;
  const proto = window.SVGElement.prototype as unknown as Record<string, unknown>;
  proto.getScreenCTM = function (this: Element) {
    const chain: Element[] = [];
    for (let el: Element | null = this; inside(el); el = el.parentElement) chain.unshift(el);
    // The outermost <svg>'s own transform is CSS, and no part of what it holds.
    const [a, b, c, d, e, f] = chain
      .slice(1)
      .reduce((m, el) => times(m, transformOf(el.getAttribute("transform"))), [1, 0, 0, 1, 7, 9] as Matrix);
    return { a, b, c, d, e, f };
  };
  proto.getBBox = function (this: Element) {
    const [x = 0, y = 0, width = 0, height = 0] = (this.getAttribute("data-bbox") ?? "").split(" ").map(Number);
    return { x, y, width, height };
  };
  proto.getNumberOfChars = () => 1;
  proto.getExtentOfChar = proto.getBBox;
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((el: Element, which?: string) => {
    const style = computed(el, which);
    if (!inside(el) || !inside(el.parentElement)) return style;
    return new Proxy(style, {
      get(target, prop) {
        if (typeof prop === "string" && /^[a-zA-Z]+$/.test(prop)) {
          const name = prop.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
          for (let node: Element | null = el; inside(node); node = node.parentElement) {
            const value = node.getAttribute(name);
            if (value !== null) return value;
            if (!SVG_INHERITED.has(name)) break;
          }
          if (name in SVG_INITIAL) return SVG_INITIAL[name];
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof window.getComputedStyle;
}

/** The scene of one slide holding `inner`, read as a browser that knows SVG would. */
async function drawn(inner: string) {
  const h = helper(SLIDE(inner));
  withSvg(h.window);
  const scene = await h.scan();
  return { ...h, items: at(scene.slides, 0).items, shots: scene.shots };
}

/** The shapes of the one drawing on the slide: a group's, or the single shape itself. */
function shapesOf(items: Item[]): Item[] {
  expect(items).toHaveLength(1);
  const only = at(items, 0);
  return only.kind === "group" ? (only.items as Item[]) : [only];
}

const RED = "rgb(255, 0, 0)";
const BLUE = "rgb(0, 0, 255)";

describe("SVG as PowerPoint shapes", () => {
  it("reads rectangles, ellipses, paths and lines as shapes of their own, grouped", async () => {
    const { items, shots } = await drawn(
      `<svg data-box="100 200 200 100" viewBox="0 0 100 50">
         <defs><marker id="tip" markerWidth="6"><path d="M0 0 L6 3 L0 6 z"/></marker></defs>
         <rect x="10" y="5" width="20" height="10" rx="2" fill="${RED}" stroke="${BLUE}" stroke-width="1" stroke-dasharray="4 2"/>
         <circle cx="50" cy="25" r="5" fill="${BLUE}" fill-opacity="0.5"/>
         <g transform="translate(50 0)" opacity="0.5"><path d="M0 0 h10 v10 q-5 5 -10 0 z" fill="${RED}"/></g>
         <line x1="0" y1="50" x2="100" y2="0" stroke="${BLUE}" stroke-width="2" stroke-linecap="round" marker-end="url(#tip)"/>
       </svg>`,
    );
    expect(shots).toEqual([]);
    expect(at(items, 0)).toMatchObject({ kind: "group", x: 100, y: 200, w: 200, h: 100 });
    const [rect, circle, path, line] = shapesOf(items);
    // Two canvas pixels to the drawing's unit.
    expect(rect).toMatchObject({ kind: "box", x: 120, y: 210, w: 40, h: 20, radius: 4, ellipse: false, rotation: 0 });
    expect(rect).toMatchObject({
      fill: { color: [255, 0, 0, 1] },
      border: { color: [0, 0, 255, 1], width: 2, dash: "dashed" },
    });
    expect(circle).toMatchObject({
      kind: "box",
      x: 190,
      y: 240,
      w: 20,
      h: 20,
      ellipse: true,
      fill: { color: [0, 0, 255, 0.5] },
      border: null,
    });
    // Relative steps and a smooth curve, moved by its group, at half the group's opacity.
    expect(path).toMatchObject({ kind: "path", x: 200, y: 200, w: 20, h: 25, fill: { color: [255, 0, 0, 0.5] } });
    expect(path?.d).toBe("M 0 0 L 20 0 L 20 20 C 13.33 26.67 6.67 26.67 0 20 Z");
    expect(line).toMatchObject({ kind: "path", x: 100, y: 200, w: 200, h: 100, d: "M 0 100 L 200 0", fill: null });
    expect(line?.border).toMatchObject({ width: 4, cap: "round", tail: { kind: "triangle", size: "lg" }, head: null });
  });

  it("draws arcs as curves, however tersely they are written", async () => {
    for (const d of ["M 10 0 A 10 10 0 0 1 20 10", "M10 0a10 10 0 0110 10", "M10,0 a10,10,0,0,1,10,10"]) {
      const { items } = await drawn(`<svg data-box="0 0 100 100"><path d="${d}" fill="none" stroke="${RED}"/></svg>`);
      expect(shapesOf(items)[0]).toMatchObject({
        kind: "path",
        x: 10,
        y: 0,
        w: 10,
        h: 10,
        d: "M 0 0 C 5.52 0 10 4.48 10 10",
      });
    }
    // A circle in two arcs: four quarter curves, measured where they bulge.
    const { items } = await drawn(
      `<svg data-box="0 0 100 100"><path d="M 10 50 a 40 40 0 1 0 80 0 a 40 40 0 1 0 -80 0 Z" fill="${RED}"/></svg>`,
    );
    const circle = shapesOf(items)[0];
    expect(circle).toMatchObject({ x: 10, y: 10, w: 80, h: 80 });
    expect(String(circle?.d).match(/C/g)).toHaveLength(4);
  });

  it("stops reading an outline where a browser would", async () => {
    const { items } = await drawn(
      `<svg data-box="0 0 100 100"><path d="M 0 0 L 10 0 L 10 10 X 5 L 50 50" fill="${RED}"/></svg>`,
    );
    expect(shapesOf(items)[0]?.d).toBe("M 0 0 L 10 0 L 10 10");
  });

  it("keeps polygons closed, polylines open, and a drawing's fit to its box", async () => {
    const { items } = await drawn(
      `<svg data-box="0 0 200 100" viewBox="0 0 10 10" preserveAspectRatio="xMaxYMid meet">
         <polygon points="0,0 10,0 5,10" fill="${RED}"/>
         <polyline points="0 0 10 10 0 10" fill="none" stroke="${BLUE}" stroke-linejoin="round"/>
       </svg>`,
    );
    const [polygon, polyline] = shapesOf(items);
    // Ten pixels to the unit, against the right edge of the box.
    expect(polygon).toMatchObject({ x: 100, y: 0, w: 100, h: 100, d: "M 0 0 L 100 0 L 50 100 Z" });
    expect(polyline).toMatchObject({ d: "M 0 0 L 100 100 L 0 100", border: { width: 10, join: "round" } });
    const stretched = await drawn(
      `<svg data-box="0 0 200 100" viewBox="0 0 10 10" preserveAspectRatio="none"><polygon points="0,0 10,0 5,10" fill="${RED}"/></svg>`,
    );
    expect(shapesOf(stretched.items)[0]).toMatchObject({ x: 0, w: 200, h: 100 });
  });

  it("turns, mirrors and skews shapes with their transforms", async () => {
    const { items } = await drawn(
      `<svg data-box="0 0 100 100">
         <rect x="10" y="20" width="40" height="20" fill="${RED}" transform="rotate(90)"/>
         <rect x="0" y="0" width="10" height="10" fill="${RED}" transform="matrix(1 0 1 1 50 50)"/>
         <ellipse cx="20" cy="10" rx="20" ry="10" fill="${RED}" transform="scale(-1 1) translate(-100 0)"/>
       </svg>`,
    );
    const [turned, skewed, mirrored] = shapesOf(items);
    // A turned rectangle stays a rectangle PowerPoint can turn back.
    expect(turned).toMatchObject({ kind: "box", w: 40, h: 20 });
    expect(turned?.rotation).toBeCloseTo(90);
    expect(Number(turned?.x) + 20).toBeCloseTo(-30);
    expect(Number(turned?.y) + 10).toBeCloseTo(30);
    expect(skewed).toMatchObject({ kind: "path", x: 50, y: 50, w: 20, h: 10, d: "M 0 0 L 10 0 L 20 10 L 10 10 Z" });
    expect(mirrored).toMatchObject({ kind: "path", x: 60, y: 0, w: 40, h: 20 });
  });

  it("maps linear gradients onto the shape they fill", async () => {
    const { items } = await drawn(
      `<svg data-box="0 0 100 100">
         <defs>
           <linearGradient id="across"><stop offset="0" stop-color="${RED}"/><stop offset="100%" stop-color="${BLUE}" stop-opacity="0.5"/></linearGradient>
           <linearGradient id="down" x1="0" y1="0" x2="0" y2="1" href="#across"/>
           <linearGradient id="middle" gradientUnits="userSpaceOnUse" x1="25" y1="0" x2="75" y2="0" href="#across"/>
           <linearGradient id="one"><stop offset="0" stop-color="${BLUE}"/></linearGradient>
         </defs>
         <rect width="100" height="40" fill="url(#across)"/>
         <rect width="100" height="40" fill="url(#down)" opacity="0.5"/>
         <path d="M0 0 H100 V40 H0 Z" fill="url(#middle)"/>
         <rect width="100" height="40" fill="url(#one)"/>
       </svg>`,
    );
    const [across, down, middle, one] = shapesOf(items);
    expect(across?.fill).toEqual({
      gradient: {
        angle: 90,
        stops: [
          { color: [255, 0, 0, 1], at: 0 },
          { color: [0, 0, 255, 0.5], at: 1 },
        ],
      },
    });
    expect(down?.fill).toMatchObject({
      gradient: { angle: 180, stops: [{ color: [255, 0, 0, 0.5] }, { color: [0, 0, 255, 0.25] }] },
    });
    // A gradient over the middle half: PowerPoint's spans the shape, so its stops move inwards.
    expect(middle?.fill).toMatchObject({ gradient: { angle: 90, stops: [{ at: 0.25 }, { at: 0.75 }] } });
    expect(one?.fill).toEqual({ color: [0, 0, 255, 1] });
  });

  it("keeps SVG text as text where it is drawn", async () => {
    const { items } = await drawn(
      `<svg data-box="100 200 200 100" viewBox="0 0 100 50">
         <text data-bbox="10 10 40 10" text-anchor="middle" font-size="8" font-family="Inter, sans-serif" fill="${BLUE}">
           Hello <tspan font-weight="700" fill="${RED}">world</tspan>
         </text>
         <text data-bbox="0 0 20 10" transform="translate(50 25) rotate(-90)" font-size="8">Axis</text>
         <text font-size="8"><tspan x="0" y="10" data-bbox="0 2 30 10">One</tspan><tspan x="0" dy="12" data-bbox="0 14 30 10" text-anchor="end">Two</tspan></text>
       </svg>`,
    );
    const [label, axis, one, two] = shapesOf(items);
    expect(label).toMatchObject({ kind: "text", x: 120, y: 220, w: 80, h: 20, wrap: false, rotation: 0 });
    const paragraph = at(label?.paragraphs as { align: string; runs: Record<string, unknown>[] }[], 0);
    expect(paragraph.align).toBe("center");
    expect(paragraph.runs).toMatchObject([
      { text: "Hello ", font: "Inter", size: 16, bold: false, color: [0, 0, 255, 1] },
      { text: "world", size: 16, bold: true, color: [255, 0, 0, 1] },
    ]);
    // Turned about its own middle, as PowerPoint turns a text box.
    expect(axis).toMatchObject({ kind: "text", w: 40, h: 20 });
    expect(axis?.rotation).toBeCloseTo(-90);
    expect(Number(axis?.x) + 20).toBeCloseTo(100 + 2 * (50 + 5));
    expect(Number(axis?.y) + 10).toBeCloseTo(200 + 2 * (25 - 10));
    // Lines placed one by one: a text box each.
    expect(one).toMatchObject({ kind: "text", x: 100, y: 204, w: 60, h: 20 });
    expect(two).toMatchObject({ kind: "text", y: 228, paragraphs: [{ align: "right", runs: [{ text: "Two" }] }] });
  });

  it("leaves a drawing one picture when PowerPoint cannot draw part of it", async () => {
    const shape = `<rect width="10" height="10" fill="${RED}"/>`;
    const beyond = [
      `<rect width="10" height="10" fill="${RED}" filter="url(#blur)"/>`,
      `<g mask="url(#m)">${shape}</g>`,
      `<g clip-path="url(#c)">${shape}</g>`,
      `${shape}<image href="assets/a.png" width="10" height="10"/>`,
      `${shape}<use href="#icon"/>`,
      `${shape}<foreignObject width="10" height="10"><p>Text</p></foreignObject>`,
      `<defs><radialGradient id="r"><stop offset="0" stop-color="${RED}"/><stop offset="1" stop-color="${BLUE}"/></radialGradient></defs><rect width="10" height="10" fill="url(#r)"/>`,
      `<rect width="10" height="10" fill="none" stroke="url(#gone)"/>`,
      `<polygon points="0,0 10,0 5,10" fill="${RED}" stroke="${BLUE}" marker-end="url(#tip)"/>`,
      `<text data-bbox="0 0 10 10"><textPath href="#p">Along</textPath></text>`,
      `<text data-bbox="0 0 10 10" x="0 5 10">Each</text>`,
      `<text data-bbox="0 0 10 10" transform="matrix(1 0 1 1 0 0)">Skewed</text>`,
    ];
    for (const inner of beyond) {
      const { items, shots } = await drawn(`<svg data-box="0 0 100 100">${inner}</svg>`);
      expect(
        items.map((i) => i.kind),
        inner,
      ).toEqual(["shot"]);
      expect(shots, inner).toHaveLength(1);
    }
  });

  it("leaves a drawing a picture when the browser cuts off what PowerPoint would show", async () => {
    const circle = `<circle cx="100" cy="50" r="40" fill="${RED}"/>`;
    const cut = await drawn(`<svg data-box="0 0 100 100" style="overflow: hidden">${circle}</svg>`);
    expect(cut.items.map((i) => i.kind)).toEqual(["shot"]);
    const shown = await drawn(`<svg data-box="0 0 100 100" style="overflow: visible">${circle}</svg>`);
    expect(shown.items.map((i) => i.kind)).toEqual(["box"]);
    // Text is measured generously: its box is taller than its letters.
    const label = await drawn(
      `<svg data-box="0 0 100 100" style="overflow: hidden"><text data-bbox="0 -3 40 12" font-size="10">Top</text></svg>`,
    );
    expect(label.items.map((i) => i.kind)).toEqual(["text"]);
  });

  it("skips what an SVG does not show", async () => {
    const { items, shots } = await drawn(
      `<svg data-box="0 0 100 100">
         <title>Chart</title><style>rect { rx: 2px }</style>
         <rect width="10" height="10" fill="none"/>
         <rect width="10" height="10" fill="${RED}" opacity="0"/>
         <rect width="10" height="10" fill="${RED}" display="none"/>
         <rect width="10" height="10" fill="${RED}" visibility="hidden"/>
         <rect width="0" height="10" fill="${RED}"/>
         <path d="" fill="${RED}"/>
         <text data-bbox="0 0 10 10" fill="none">Unseen</text>
       </svg>`,
    );
    expect(items).toEqual([]);
    expect(shots).toEqual([]);
  });

  it("draws an outline over its shape as that shape's outline", async () => {
    const { items } = await drawn(
      `<svg data-box="0 0 100 100">
         <path d="M0 0 L50 0 L25 40 Z" fill="${RED}"/>
         <path d="M0 0 L50 0 L25 40 Z" fill="none" stroke="${BLUE}" stroke-width="3"/>
       </svg>`,
    );
    expect(items).toHaveLength(1);
    expect(at(items, 0)).toMatchObject({
      kind: "path",
      fill: { color: [255, 0, 0, 1] },
      border: { color: [0, 0, 255, 1], width: 3 },
    });
  });

  it("draws the stretches of an outline its dashes leave, as a ring filled part of the way", async () => {
    const ring = (attrs: string) =>
      `<circle cx="50" cy="50" r="40" fill="none" stroke="${BLUE}" stroke-width="10" ${attrs}/>`;
    const { items } = await drawn(
      `<svg data-box="0 0 100 100">
         ${ring('pathLength="100" stroke-dasharray="50 100" transform="rotate(-90 50 50)"')}
         <g stroke-dasharray="1 1">${ring('pathLength="1"')}</g>
         ${ring('pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1"')}
         ${ring('stroke-dasharray="20 6"')}
         <rect x="10" y="10" width="80" height="80" fill="${RED}" stroke="${BLUE}" stroke-dasharray="100 1000"/>
         <line x1="0" y1="0" x2="100" y2="0" stroke="${BLUE}" stroke-dasharray="10 30 20 1000" stroke-dashoffset="-20"/>
       </svg>`,
    );
    const [half, drawnIn, dashed, square, corner, marks] = shapesOf(items);
    // Half of the ring, from the top, down its right side: two quarter curves, no dashes.
    expect(half).toMatchObject({ kind: "path", fill: null, border: { width: 10, dash: null } });
    expect(
      String(half?.d)
        .match(/[MLCZ]/g)
        ?.join(""),
    ).toBe("MCC");
    expect(Number(half?.x)).toBeCloseTo(50);
    expect(Number(half?.y)).toBeCloseTo(10);
    expect(Number(half?.w)).toBeCloseTo(40);
    expect(Number(half?.h)).toBeCloseTo(80);
    // A ring a dash as long as itself draws in is a ring; one not yet drawn in shows nothing.
    expect(drawnIn).toMatchObject({ kind: "box", ellipse: true, border: { dash: null } });
    // A pattern that repeats stays PowerPoint's own dashes.
    expect(dashed).toMatchObject({ kind: "box", ellipse: true, border: { dash: "dashed" } });
    // The fill keeps its shape, under the stretch of outline: the top edge and a way down the right.
    expect(square).toMatchObject({
      kind: "box",
      x: 10,
      y: 10,
      w: 80,
      h: 80,
      fill: { color: [255, 0, 0, 1] },
      border: null,
    });
    expect(corner).toMatchObject({ kind: "path", x: 10, y: 10, w: 80, h: 20, d: "M 0 0 L 80 0 L 80 20", fill: null });
    // Two dashes, pushed along by the offset; measured from the first.
    expect(marks).toMatchObject({ kind: "path", x: 20, w: 60, d: "M 0 0 L 10 0 M 40 0 L 60 0" });
    expect(shapesOf(items)).toHaveLength(6);
  });

  it("carries a drawing's own transform into its shapes, as for a line the import mirrored", async () => {
    const { items } = await drawn(
      `<svg data-box="0 0 100 50" viewBox="0 0 100 50" style="width: 100px; height: 50px; transform: matrix(-1, 0, 0, 1, 0, 0)">
         <path d="M0 0 L100 50" fill="none" stroke="${BLUE}"/>
       </svg>`,
    );
    expect(at(items, 0)).toMatchObject({ kind: "path", x: 0, y: 0, w: 100, h: 50, d: "M 100 0 L 0 50" });
    // Turned a quarter: the box on screen is the turned one, the drawing its laid-out size.
    const turned = await drawn(
      `<svg data-box="25 -25 50 100" viewBox="0 0 100 50" style="width: 100px; height: 50px; transform: matrix(0, 1, -1, 0, 0, 0)">
         <path d="M0 0 L100 0" fill="none" stroke="${BLUE}"/>
       </svg>`,
    );
    const line = at(turned.items, 0);
    expect(line.d).toBe("M 0 0 L 0 100");
    expect(Number(line.x)).toBeCloseTo(75);
    expect(Number(line.y)).toBeCloseTo(-25);
  });

  /** A figure as the editor draws it: its shape in an SVG stretched over the box. */
  const figure = (svg: string, style = "") =>
    `<div data-shape="triangle" data-box="100 100 200 100" style="background-image: url(&quot;data:image/svg+xml,${svg
      .replace(/%/g, "%25")
      .replace(/#/g, "%23")
      .replace(/</g, "%3C")
      .replace(
        />/g,
        "%3E",
      )}&quot;); background-size: 100% 100%; background-repeat: no-repeat; ${style}"><div data-text-body data-box="150 130 100 40">Label</div></div>`;
  const TRIANGLE = "M100 0 L200 100 L0 100 Z";
  const edged =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 100' preserveAspectRatio='none'><clipPath id='edge'><path d='${TRIANGLE}'/></clipPath>` +
    `<g transform='matrix(1 0 0 -1 0 100)'><path d='${TRIANGLE}' fill='${RED}'/>` +
    `<path d='${TRIANGLE}' fill='none' stroke='${BLUE}' stroke-width='8' stroke-dasharray='4 4' stroke-linejoin='round' clip-path='url(#edge)'/></g></svg>`;

  it("draws the editor's figures as one freeform with their border, flip and text", async () => {
    const { items, shots, doc } = await drawn(figure(edged));
    expect(shots).toEqual([]);
    expect(items.map((i) => i.kind)).toEqual(["path", "text"]);
    // Flipped top to bottom; its outline, cut to the shape, shows half as wide as it is drawn.
    expect(at(items, 0)).toMatchObject({ x: 100, y: 100, w: 200, h: 100, d: "M 100 100 L 200 0 L 0 0 Z" });
    expect(at(items, 0)).toMatchObject({
      fill: { color: [255, 0, 0, 1] },
      border: { color: [0, 0, 255, 1], width: 4, dash: "dotted", join: "round" },
    });
    expect(doc.querySelector(".slide")?.children).toHaveLength(1);
  });

  it("gives a figure the shadow the editor keeps around it", async () => {
    const h = helper(SLIDE(figure(edged)));
    withSvg(h.window);
    const shadow =
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='blur'%3E%3CfeGaussianBlur stdDeviation='6'/%3E%3C/filter%3E" +
      "%3Cg transform='translate(0 4)'%3E%3Cpath d='M0 0' fill='black' fill-opacity='0.35' filter='url(%23blur)'/%3E%3C/g%3E%3C/svg%3E\")";
    const computed = h.window.getComputedStyle;
    const around = (source: string) => {
      h.window.getComputedStyle = ((el: Element, which?: string) => {
        const style = computed(el, which);
        if (!el.hasAttribute("data-shape")) return style;
        return new Proxy(style, {
          get: (target, prop) =>
            prop === "getPropertyValue"
              ? (name: string) => (name === "border-image-source" ? source : "")
              : Reflect.get(target, prop),
        });
      }) as typeof h.window.getComputedStyle;
    };
    around(shadow);
    const scene = await h.scan();
    expect(at(at(scene.slides, 0).items, 0).shadow).toEqual({ color: [0, 0, 0, 0.35], x: 0, y: 4, blur: 12 });
    // Any other image around a box is no shadow PowerPoint has: a picture of it all.
    around('url("assets/frame.png")');
    const framed = await h.scan();
    expect(at(framed.slides, 0).items.map((i) => i.kind)).toEqual(["shot", "text"]);
  });

  it("turns a figure's shape with its box", async () => {
    const { items } = await drawn(figure(edged, "transform: matrix(0, 1, -1, 0, 0, 0)"));
    const shape = at(items, 0);
    // About the middle of the box, (200, 150): its top edge now runs down its right side.
    expect(shape).toMatchObject({ kind: "path", d: "M 0 100 L 100 200 L 100 0 Z" });
    expect(Number(shape.x)).toBeCloseTo(150);
    expect(Number(shape.y)).toBeCloseTo(50);
  });

  it("pictures a background SVG it cannot or must not read into the page", async () => {
    const plain = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 100'><path d='${TRIANGLE}' fill='${RED}'/></svg>`;
    const kinds = async (svg: string, style = "") => (await drawn(figure(svg, style))).items.map((i) => i.kind);
    expect(await kinds(plain)).toEqual(["path", "text"]);
    // Tiled or fitted some other way: not the one drawing over the box.
    expect(await kinds(plain, "background-size: 50px 50px")).toEqual(["shot", "text"]);
    expect(await kinds(plain.replace("<path", "<script>window.ran = true</script><path"))).toEqual(["shot", "text"]);
    expect(await kinds(plain.replace("<path", "<style>path { fill: blue }</style><path"))).toEqual(["shot", "text"]);
    expect(await kinds(plain.replace("fill=", "filter='url(%23f)' fill="))).toEqual(["shot", "text"]);
    expect(await kinds("<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0'")).toEqual(["shot", "text"]);
    // Handlers an image never runs are gone before it is measured in the page.
    const h = helper(SLIDE(figure(plain.replace("<path", "<path onclick='window.ran = true'"))));
    withSvg(h.window);
    const seen: string[] = [];
    const attach = h.window.Element.prototype.attachShadow;
    h.window.Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
      const root = attach.call(this, init);
      const append = root.appendChild.bind(root);
      root.appendChild = ((node: Element) => {
        seen.push(node.outerHTML);
        return append(node);
      }) as typeof root.appendChild;
      return root;
    };
    expect(at((await h.scan()).slides, 0).items.map((i) => i.kind)).toEqual(["path", "text"]);
    expect(seen).toHaveLength(1);
    expect(at(seen, 0)).not.toContain("onclick");
  });
});
