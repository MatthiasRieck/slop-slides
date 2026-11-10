// @vitest-environment node
/**
 * The render helper (src-tauri/assets/render.js), run by the app, after overflow.js, in the
 * hidden window that renders slides for the agent. It answers each step by navigating to
 * /.render-signal?<answer>.
 */
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

  it("reports every slide once fonts and images are ready, hidden ones too", async () => {
    const { answers } = helper();
    await vi.waitFor(() => {
      vi.advanceTimersByTime(100);
      expect(answers).toEqual(["ready&slides=3"]);
    });
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
