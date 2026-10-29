/**
 * The video export helper (src-tauri/assets/video.js), run by the app in the hidden window that
 * records a deck. It answers each step by navigating to /.video-signal?<answer>, and moves every
 * animation in the page to the video's clock.
 */
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import VIDEO_JS from "../../src-tauri/assets/video.js?raw";

const DECK = `<!DOCTYPE html><html><head></head><body>
<main class="deck">
  <section class="slide active" id="intro"><h1 id="title">Title</h1><div id="logo-a" data-morph="logo"></div><div data-morph="solo"></div></section>
  <section class="slide" data-hidden><p>Hidden</p></section>
  <section class="slide" id="end"><p id="body">End</p><div id="logo-b" data-morph="logo"></div></section>
</main></body></html>`;

let doms: JSDOM[] = [];

afterEach(() => {
  for (const d of doms) d.window.close();
  doms = [];
  vi.useRealTimers();
});

interface Helper {
  next: (at: number) => void;
  frame: (at: number) => void;
}

/** A stand-in for a Web Animations `Animation` on `target`, ending at `end` ms. */
class FakeAnimation {
  currentTime: number | null = 0;
  paused = false;
  finished = false;
  constructor(
    public target: Element,
    end: number,
  ) {
    this.effect = { target, getComputedTiming: () => ({ endTime: end }) };
  }
  effect: { target: Element; getComputedTiming: () => { endTime: number } };
  pause() {
    this.paused = true;
  }
  finish() {
    this.finished = true;
  }
}

/** Enough of a 2D DOMMatrix for the helper's morph poses; jsdom has none. */
type Affine = [number, number, number, number, number, number];

class FakeMatrix {
  m: Affine = [1, 0, 0, 1, 0, 0];
  static of(m: Affine) {
    const out = new FakeMatrix();
    out.m = m;
    return out;
  }
  multiply(o: FakeMatrix) {
    const [a, b, c, d, e, f] = this.m;
    const [A, B, C, D, E, F] = o.m;
    return FakeMatrix.of([
      a * A + c * B,
      b * A + d * B,
      a * C + c * D,
      b * C + d * D,
      a * E + c * F + e,
      b * E + d * F + f,
    ]);
  }
  translate(x = 0, y = 0) {
    return this.multiply(FakeMatrix.of([1, 0, 0, 1, x, y]));
  }
  scale(x = 1, y = x) {
    return this.multiply(FakeMatrix.of([x, 0, 0, y, 0, 0]));
  }
  toString() {
    return `matrix(${this.m.join(", ")})`;
  }
}

/** Puts `el` at `x`, `y` on its slide, `width` × `height`, as layout would. */
function place(el: HTMLElement, x: number, y: number, width: number, height: number) {
  const slide = el.closest(".slide");
  const values = { offsetLeft: x, offsetTop: y, offsetWidth: width, offsetHeight: height, offsetParent: slide };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(el, key, { value, configurable: true });
}

/** Loads the deck, runs the helper, and records its answers instead of navigating. */
function helper(options: { url?: string; matrix?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const dom = new JSDOM(DECK, {
    url: options.url ?? "https://example.test/talk/deck.html?print",
    runScripts: "outside-only",
  });
  doms.push(dom);
  const { window } = dom;
  const doc = window.document;
  const answers: string[] = [];
  const animations: FakeAnimation[] = [];
  const keys: string[] = [];
  const poses: { el: Element; keyframes: Keyframe[]; timing: KeyframeAnimationOptions }[] = [];
  // jsdom cannot navigate, which is how the helper answers in the app.
  Object.assign(window, { __slopVideoSignal: (answer: string) => answers.push(answer) });
  Object.assign(doc, {
    getAnimations: () => animations.filter((a) => !a.finished),
    startViewTransition: () => {
      throw new Error("a hidden page skips view transitions");
    },
  });
  if (options.matrix !== false) Object.assign(window, { DOMMatrix: FakeMatrix });
  Object.assign(window.HTMLElement.prototype, {
    animate(this: Element, keyframes: Keyframe[], timing: KeyframeAnimationOptions) {
      poses.push({ el: this, keyframes, timing });
      const animation = new FakeAnimation(this, Number(timing.duration));
      animations.push(animation);
      return animation;
    },
  });
  // The player moves on with → as the presenter does; this stands in for it.
  window.addEventListener("keydown", (event) => {
    keys.push(event.key);
    const slides = doc.querySelectorAll(".deck > .slide:not([data-hidden])");
    slides.forEach((el, i) => {
      el.classList.toggle("active", i === 1);
    });
  });
  window.eval(VIDEO_JS);
  const api = (window as unknown as { __slopVideo: Helper }).__slopVideo;
  const settle = async () => {
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(5000);
  };
  const animate = (id: string, end: number) => {
    const animation = new FakeAnimation(doc.getElementById(id)!, end);
    animations.push(animation);
    return animation;
  };
  return { window, doc, api, answers, settle, animate, keys, poses };
}

describe("video helper", () => {
  it("reports when the deck is ready, with its shown slides and where the first one is", async () => {
    const { answers, settle } = helper();
    await settle();
    expect(answers).toEqual(["ready&slides=2&rect=0,0,0,0&view=1024,768"]);
  });

  it("pauses each animation and moves it to the video's clock", async () => {
    const { api, answers, settle, animate } = helper();
    const entrance = animate("title", 700);
    await settle();
    expect(entrance.paused).toBe(true);
    expect(entrance.currentTime).toBe(0);

    api.frame(250);
    expect(entrance.currentTime).toBe(250);
    expect(answers.at(-1)).toBe("frame&busy=1");

    api.frame(700);
    expect(entrance.finished).toBe(true);
    expect(answers.at(-1)).toBe("frame&busy=0");
  });

  it("starts animations from when they first appear", async () => {
    const { api, answers, settle, animate } = helper();
    await settle();
    api.frame(1000);
    expect(answers.at(-1)).toBe("frame&busy=0");
    const late = animate("title", 500);
    api.frame(1100);
    expect(late.currentTime).toBe(0);
    api.frame(1300);
    expect(late.currentTime).toBe(200);
  });

  it("moves on with the → key, starting the next slide's animations at that moment", async () => {
    const { api, answers, settle, animate, keys, doc } = helper();
    await settle();
    let entrance: FakeAnimation | null = null;
    doc.defaultView!.addEventListener("keydown", () => {
      entrance = animate("body", 700);
    });
    api.next(5000);
    expect(keys).toEqual(["ArrowRight"]);
    expect(answers.at(-1)).toBe("next");
    expect(doc.getElementById("end")!.classList.contains("active")).toBe(true);
    api.frame(5100);
    expect(entrance!.currentTime).toBe(100);
    expect(answers.at(-1)).toBe("frame&busy=1");
  });

  it("ignores animations on slides that are not shown", async () => {
    const { api, answers, settle, animate, doc } = helper();
    const behind = animate("body", Number.POSITIVE_INFINITY);
    await settle();
    // A stylesheet hides inactive slides; jsdom has none, so say so directly.
    (doc.getElementById("end") as HTMLElement).style.visibility = "hidden";
    api.frame(100);
    expect(behind.currentTime).toBe(100);
    expect(answers.at(-1)).toBe("frame&busy=0");
  });

  it("stays busy while an animation repeats forever", async () => {
    const { api, answers, settle, animate } = helper();
    animate("title", Number.POSITIVE_INFINITY);
    await settle();
    api.frame(60_000);
    expect(answers.at(-1)).toBe("frame&busy=1");
  });

  it("turns off view transitions, which a hidden page skips", () => {
    const { doc } = helper();
    expect(doc.startViewTransition).toBeUndefined();
  });

  it("morphs shared heroes from the other's place and size to their own", async () => {
    const { api, answers, settle, poses, doc } = helper();
    const [a, b] = [doc.getElementById("logo-a")!, doc.getElementById("logo-b")!];
    place(a, 100, 100, 200, 200);
    place(b, 1000, 300, 400, 400);
    await settle();
    api.next(5000);
    expect(doc.documentElement.hasAttribute("data-slop-video-morph")).toBe(true);
    expect(poses.map((p) => p.el)).toEqual([a, b]);
    const transforms = (i: number) => poses[i]!.keyframes.map((k) => k.transform);
    // About their centres: the old one goes over to the new one's place, twice its size...
    expect(transforms(0)).toEqual(["matrix(1, 0, 0, 1, 0, 0)", "matrix(2, 0, 0, 2, 1000, 300)"]);
    // ...while the new one starts over the old one, at half its size.
    expect(transforms(1)).toEqual(["matrix(0.5, 0, 0, 0.5, -1000, -300)", "matrix(1, 0, 0, 1, 0, 0)"]);
    expect(poses[1]!.keyframes[0]).toMatchObject({ translate: "none", rotate: "none", scale: "none" });
    expect(poses[1]!.timing).toEqual({ duration: 550, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    api.frame(5300);
    expect(answers.at(-1)).toBe("frame&busy=1");
    api.frame(5550);
    expect(answers.at(-1)).toBe("frame&busy=0");
  });

  it("only fades between slides that share no hero", async () => {
    const { api, settle, poses, doc } = helper();
    doc.getElementById("logo-b")!.setAttribute("data-morph", "other");
    await settle();
    api.next(5000);
    expect(poses).toEqual([]);
    expect(doc.documentElement.hasAttribute("data-slop-video-morph")).toBe(false);
  });

  it("does not morph stills, as the player does not", async () => {
    const { api, settle, poses, doc } = helper({ url: "https://example.test/talk/deck.html?static&print" });
    doc.documentElement.setAttribute("data-slop-static", "");
    await settle();
    api.next(5000);
    expect(poses).toEqual([]);
  });

  it("fades where the browser cannot work out poses", async () => {
    const { api, settle, poses, keys } = helper({ matrix: false });
    await settle();
    api.next(5000);
    expect(poses).toEqual([]);
    expect(keys).toEqual(["ArrowRight"]);
  });
});
