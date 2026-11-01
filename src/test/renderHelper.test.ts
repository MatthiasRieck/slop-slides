/**
 * The render helper (src-tauri/assets/render.js), run by the app, after overflow.js, in the
 * hidden window that renders slides for the agent. It answers each step by navigating to
 * /.render-signal?<answer>.
 */
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import OVERFLOW from "../../src-tauri/assets/overflow.js?raw";
import RENDER from "../../src-tauri/assets/render.js?raw";

const DECK = `<!DOCTYPE html><html><head></head><body>
<main class="deck">
  <section class="slide active" id="intro"><h1>Title</h1></section>
  <section class="slide" id="secret" data-hidden><p>Hidden</p></section>
  <section class="slide" id="long"><p class="big">Too long</p><div class="glow" aria-hidden="true">x</div></section>
</main></body></html>`;

let doms: JSDOM[] = [];

afterEach(() => {
  for (const d of doms) d.window.close();
  doms = [];
  vi.useRealTimers();
});

interface Helper {
  ready: () => void;
  show: (id: string) => void;
}

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

/** Loads the deck, lays it out at half size, runs the helper, and records its answers. */
function helper() {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const dom = new JSDOM(DECK, { url: "https://example.test/talk/deck.html?static&print", runScripts: "outside-only" });
  doms.push(dom);
  const { window } = dom;
  const answers: string[] = [];
  const resizes = vi.fn();
  window.addEventListener("resize", resizes);
  Object.assign(window, { __slopRenderSignal: (answer: string) => answers.push(answer) });
  window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.matches(".slide")) return box(0, 0, 960, 540) as DOMRect;
    if (this.matches(".big")) return box(0, 500, 200, 100) as DOMRect;
    if (this.matches(".glow")) return box(900, 0, 200, 100) as DOMRect;
    return box(0, 0, 100, 100) as DOMRect;
  };
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", { get: () => 1920 });
  window.eval(OVERFLOW);
  window.eval(RENDER);
  const render = (window as unknown as { __slopRender: Helper }).__slopRender;
  const slide = (id: string) => window.document.getElementById(id) as HTMLElement;
  return { render, answers, slide, resizes };
}

const answered = (answer: string) => new URLSearchParams(answer);

describe("the render helper", () => {
  it("reports every slide once fonts and images are ready, hidden ones too", async () => {
    const { answers } = helper();
    await vi.waitFor(() => {
      vi.advanceTimersByTime(100);
      expect(answers).toEqual(["ready&slides=3"]);
    });
  });

  it("shows only the asked slide and says where it is", () => {
    const { render, answers, slide, resizes } = helper();
    render.show("intro");
    expect(slide("intro").classList.contains("active")).toBe(true);
    expect(slide("long").classList.contains("active")).toBe(false);
    expect(resizes).toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    const shown = answered(answers.at(-1) as string);
    expect(shown.get("shown")).toBe("intro");
    expect(shown.get("rect")).toBe("0,0,960,540");
    expect(shown.get("view")).toBe("1024,768");
    expect(JSON.parse(shown.get("overflow") as string)).toEqual([]);
  });

  it("can show a hidden slide", () => {
    const { render, slide } = helper();
    render.show("secret");
    expect(slide("secret").classList.contains("active")).toBe(true);
    expect(slide("intro").classList.contains("active")).toBe(false);
  });

  it("reports what runs past the slide in slide pixels, leaving out decoration", () => {
    const { render, answers } = helper();
    render.show("long");
    vi.advanceTimersByTime(150);
    const shown = answered(answers.at(-1) as string);
    expect(JSON.parse(shown.get("overflow") as string)).toEqual(['<p> "Too long" runs past the bottom edge by 120px']);
  });

  it("leaves the shown slide alone when the id is unknown", () => {
    const { render, answers, slide } = helper();
    render.show("a&b");
    expect(answered(answers.at(-1) as string).get("shown")).toBe("a&b");
    expect(answered(answers.at(-1) as string).get("missing")).toBe("1");
    expect(slide("intro").classList.contains("active")).toBe(true);
  });

  it("caps the findings an answer carries", () => {
    const { render, answers, slide } = helper();
    slide("long").innerHTML = Array.from({ length: 30 }, (_, n) => `<p class="big">Line ${n}</p>`).join("");
    render.show("long");
    vi.advanceTimersByTime(150);
    expect(JSON.parse(answered(answers.at(-1) as string).get("overflow") as string)).toHaveLength(20);
  });
});
