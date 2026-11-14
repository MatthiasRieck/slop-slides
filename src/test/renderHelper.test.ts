// @vitest-environment node
/**
 * The render helper (src-tauri/assets/render.js), run by the app, after overflow.js, in the
 * hidden window that renders slides for the agent. It answers each step by navigating to
 * /.render-signal?<answer>.
 */

import type { DOMWindow } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import OVERFLOW from "../../src-tauri/assets/overflow.js?raw";
import RENDER from "../../src-tauri/assets/render.js?raw";

import { openHelper } from "./deckDom";

const DECK = `<!DOCTYPE html><html><head></head><body>
<main class="deck">
  <section class="slide active" id="intro"><h1>Title</h1></section>
  <section class="slide" id="secret" data-hidden><p>Hidden</p></section>
  <section class="slide" id="long"><p class="big">Too long</p><div class="glow" aria-hidden="true">x</div></section>
</main></body></html>`;

interface Helper {
  ready: () => void;
  show: (id: string, at?: number | null) => void;
  preview: (ref: string) => void;
}

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

/**
 * Loads the deck, lays it out at half size, runs the helper, and records its answers. `paint` is
 * what the app tells it a capture waits for the page to be drawn (render.rs): nothing on macOS.
 */
function helper({ paint, setup }: { paint?: number; setup?: (window: DOMWindow) => void } = {}) {
  const resizes = vi.fn();
  const {
    window,
    api: render,
    answers,
  } = openHelper<Helper>(DECK, "Render", {
    setup(window) {
      window.addEventListener("resize", resizes);
      window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        if (this.matches(".slide")) return box(0, 0, 960, 540) as DOMRect;
        if (this.matches(".big")) return box(0, 500, 200, 100) as DOMRect;
        if (this.matches(".glow")) return box(900, 0, 200, 100) as DOMRect;
        return box(0, 0, 100, 100) as DOMRect;
      };
      Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", { get: () => 1920 });
      if (paint !== undefined) Object.assign(window, { __slopRenderPaint: paint });
      setup?.(window);
    },
    scripts: [OVERFLOW, RENDER],
  });
  const slide = (id: string) => window.document.getElementById(id) as HTMLElement;
  return { render, answers, slide, resizes, window };
}

const answered = (answer: string) => new URLSearchParams(answer);

describe("the render helper", () => {
  it("holds the slide's animations where they are a moment after it shows, everything else done", () => {
    const { render, window } = helper();
    const animation = (target: Element, endTime: number, name: string | null) => ({
      animationName: name,
      effect: { target, getComputedTiming: () => ({ endTime }) },
      currentTime: 0,
      state: "running",
      pause() {
        this.state = "paused";
      },
      finish() {
        if (endTime === Number.POSITIVE_INFINITY) throw new Error("InvalidStateError");
        this.state = "finished";
      },
    });
    const long = window.document.getElementById("long")!;
    const word = animation(long.querySelector(".big")!, 4000, "pop");
    const short = animation(long.querySelector(".glow")!, 800, "glow");
    const fade = animation(long, 350, null);
    const elsewhere = animation(window.document.getElementById("intro")!, Number.POSITIVE_INFINITY, "spin");
    const animations = [word, short, fade, elsewhere];
    Object.assign(window.document, { getAnimations: () => animations });
    render.show("long", 2.5);
    expect([word.currentTime, word.state]).toEqual([2500, "paused"]);
    expect([short.currentTime, short.state]).toEqual([800, "paused"]);
    expect(fade.state).toBe("finished");
    expect(elsewhere.state).toBe("paused");
    // Without a moment, the page (loaded still) is left as it is.
    word.state = "running";
    render.show("long", null);
    expect(word.state).toBe("running");
  });

  it("reports every slide as soon as the page has loaded, hidden ones too", () => {
    const { answers } = helper();
    // Each slide is waited for as it shows, not the page as a whole for a while.
    expect(answers).toEqual(["ready&slides=3"]);
  });

  it("does not restart when WebView2 finishes a canceled signal navigation", async () => {
    const { render, answers, window } = helper();
    await vi.runAllTimersAsync();
    expect(answers).toEqual(["ready&slides=3"]);
    // WebView2 fires NavigationCompleted even though the app canceled /.render-signal.
    window.eval(RENDER);
    render.show("intro");
    await vi.runAllTimersAsync();
    expect(answers.map((answer) => answer.split("&")[0])).toEqual(["ready", "shown=intro"]);
    expect((window as unknown as { __slopRender: Helper }).__slopRender).toBe(render);
  });

  it("shows only the asked slide and says where it is", async () => {
    const { render, answers, slide, resizes } = helper();
    render.show("intro");
    expect(slide("intro").classList.contains("active")).toBe(true);
    expect(slide("long").classList.contains("active")).toBe(false);
    expect(resizes).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
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

  it("reports what runs past the slide in slide pixels, leaving out decoration", async () => {
    const { render, answers } = helper();
    render.show("long");
    await vi.advanceTimersByTimeAsync(100);
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

  it("caps the findings an answer carries", async () => {
    const { render, answers, slide } = helper();
    slide("long").innerHTML = Array.from({ length: 30 }, (_, n) => `<p class="big">Line ${n}</p>`).join("");
    render.show("long");
    await vi.advanceTimersByTimeAsync(100);
    expect(JSON.parse(answered(answers.at(-1) as string).get("overflow") as string)).toHaveLength(20);
  });
  it("captures a slide once it is ready, with no fixed wait where the capture draws the page", async () => {
    const { render, answers } = helper({ paint: 0 });
    render.show("intro");
    // Promises only: no timer has to run out.
    await vi.advanceTimersByTimeAsync(0);
    expect(answered(answers.at(-1) as string).get("shown")).toBe("intro");
    expect(vi.getTimerCount()).toBe(1); // only the safety cap, never reached
  });

  it("waits for the slide's images, fonts and background images, and no longer", async () => {
    let decoded: () => void = () => {};
    let fontsIn: () => void = () => {};
    const loads: string[] = [];
    const { render, answers, slide } = helper({
      paint: 0,
      setup(window) {
        Object.defineProperty(window.document, "fonts", {
          value: { ready: new Promise<void>((resolve) => (fontsIn = resolve)) },
        });
        window.HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
          loads.push(this.getAttribute("src") ?? this.src);
          return this.isConnected ? new Promise<void>((resolve) => (decoded = resolve)) : Promise.resolve();
        };
      },
    });
    slide("long").innerHTML = '<img src="assets/photo.png"><div style="background-image: url(assets/bg.png)"></div>';
    render.show("long");
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toEqual(["assets/photo.png", "assets/bg.png"]);
    expect(answers).toHaveLength(1);
    fontsIn();
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).toHaveLength(1);
    decoded();
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).toHaveLength(1);
    // A large background image is decoded as it is drawn: given a moment for that.
    await vi.advanceTimersByTimeAsync(50);
    expect(answered(answers.at(-1) as string).get("shown")).toBe("long");
  });

  it("captures a slide that never gets ready after a short cap", async () => {
    const { render, answers } = helper({
      paint: 0,
      setup(window) {
        Object.defineProperty(window.document, "fonts", { value: { ready: new Promise(() => {}) } });
      },
    });
    render.show("intro");
    await vi.advanceTimersByTimeAsync(2999);
    expect(answers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(answered(answers.at(-1) as string).get("shown")).toBe("intro");
  });

  it("shows the slide a preview names, as the player finds it, fitted, without overflow findings", async () => {
    const fit = vi.fn();
    const { render, answers, slide } = helper({
      paint: 0,
      setup(window) {
        Object.assign(window, { slopAutofit: { fit } });
      },
    });
    slide("long").insertAdjacentHTML("beforeend", '<div data-autofit="shrink">Fit me</div>');
    for (const [ref, shown] of [
      ["long", "long"],
      ["#2", "secret"],
      ["nope", "intro"],
      ["", "intro"],
    ] as const) {
      render.preview(ref);
      await vi.advanceTimersByTimeAsync(0);
      expect(slide(shown).classList.contains("active"), ref).toBe(true);
      const answer = answered(answers.at(-1) as string);
      expect(answer.get("shown")).toBe(ref);
      expect(answer.has("rect")).toBe(true);
      expect(answer.has("overflow")).toBe(false);
    }
    expect(fit).toHaveBeenCalledTimes(1);
  });
});
