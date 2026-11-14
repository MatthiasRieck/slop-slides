// @vitest-environment node
/**
 * The player embedded in every deck.html (src-tauri/assets/runtime.js). It runs in the
 * editor's slide iframes, in the presenter, and in exported files opened in any browser.
 */
import { readFileSync } from "node:fs";
import type { DOMWindow } from "jsdom";
import { describe, expect, it, vi } from "vitest";

import { singleSlide } from "../../dev/browserPreview";
import RUNTIME from "../../src-tauri/assets/runtime.js?raw";
import { strokePath, toPixels } from "../lib/ink";
import { openDeck } from "./deckDom";
import SINGLE_DECK from "./fixtures/single-slide/deck.html?raw";
import SINGLE_SECOND from "./fixtures/single-slide/second.html?raw";

const DECK = `<!DOCTYPE html><html><body>
<main class="deck">
  <section class="slide" id="intro"><button>Click me</button><section class="slide nested"></section></section>
  <section class="slide"><p>No id</p></section>
  <section class="slide" id="end"><a href="#x">link</a></section>
</main></body></html>`;

interface PlayerOptions {
  /** Query string and hash, e.g. `?embed&slide=end` or `#2`. */
  at?: string;
  html?: string;
  /** Pretend to be inside an iframe; receives the player's postMessages. */
  parent?: { postMessage: (data: unknown, origin: string) => void };
  size?: [number, number];
  /** The stage's laid-out size (the deck's slide size); jsdom lays nothing out, so it is 0×0 without. */
  stage?: [number, number];
  /** Runs before the player, e.g. to fake layout jsdom does not do. */
  setup?: (window: DOMWindow) => void;
}

function player({ at = "", html = DECK, parent, size = [1920, 1080], stage, setup }: PlayerOptions = {}) {
  const window = openDeck(html, {
    url: `https://example.test/deck.html${at}`,
    size,
    parent,
    stage,
    visual: true,
    setup,
    scripts: [RUNTIME],
  });
  const doc = window.document;
  const topSlides = () => [...doc.querySelectorAll<HTMLElement>(".deck > .slide")];
  return {
    window,
    doc,
    active: () => topSlides().findIndex((s) => s.classList.contains("active")),
    activeCount: () => doc.querySelectorAll(".slide.active").length,
    key: (key: string, held: KeyboardEventInit = {}, target: EventTarget = window) => {
      const event = new window.KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...held });
      target.dispatchEvent(event);
      return event;
    },
    click: (target: Element, clientX: number) =>
      target.dispatchEvent(new window.MouseEvent("click", { clientX, bubbles: true })),
  };
}

const hashOf = (window: DOMWindow) => window.location.hash;

/** A touch event: the fingers still down (`touches`, as [x, y]) and, for one lifted, where it was (`changed`). */
function touch(p: ReturnType<typeof player>, type: string, touches: [number, number][], changed?: [number, number]) {
  const event = new p.window.Event(type, { bubbles: true }) as Event & Record<string, unknown>;
  const at = ([clientX, clientY]: [number, number]) => ({ clientX, clientY });
  event.touches = touches.map(at);
  event.changedTouches = changed ? [at(changed)] : touches.map(at);
  p.doc.dispatchEvent(event);
}

describe("player: standalone", () => {
  it("shows the first slide and records it in the URL", () => {
    const p = player();
    expect(p.active()).toBe(0);
    expect(p.activeCount()).toBe(1);
    expect(hashOf(p.window)).toBe("#intro");
  });

  it("starts at the slide named in the hash, by id or 1-based number", () => {
    expect(player({ at: "#end" }).active()).toBe(2);
    expect(player({ at: "#2" }).active()).toBe(1);
    expect(player({ at: "#99" }).active()).toBe(2);
    expect(player({ at: "#0" }).active()).toBe(0);
    expect(player({ at: "#unknown" }).active()).toBe(0);
  });

  it("decodes ids in the hash", () => {
    const html = DECK.replace(`id="end"`, `id="the end"`);
    expect(player({ html, at: "#the%20end" }).active()).toBe(2);
  });

  it("names slides without an id by their number", () => {
    const p = player();
    p.key("ArrowRight");
    expect(hashOf(p.window)).toBe("#2");
  });

  it.each([
    ["ArrowRight", 1],
    ["ArrowDown", 1],
    ["PageDown", 1],
    [" ", 1],
    ["Enter", 1],
    ["n", 1],
    ["N", 1],
    ["End", 2],
  ])("%j moves forward", (key, expected) => {
    const p = player();
    const event = p.key(key);
    expect(p.active()).toBe(expected);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([["ArrowLeft"], ["ArrowUp"], ["PageUp"], ["Backspace"], ["p"], ["P"]])("%j moves back", (key) => {
    const p = player({ at: "#end" });
    expect(p.key(key).defaultPrevented).toBe(true);
    expect(p.active()).toBe(1);
  });

  it("Shift+Space moves back", () => {
    const p = player({ at: "#end" });
    expect(p.key(" ", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(p.active()).toBe(1);
  });

  it.each([
    ["f", { metaKey: true }],
    ["f", { ctrlKey: true }],
    ["ArrowLeft", { metaKey: true }],
    ["ArrowLeft", { altKey: true }],
    ["ArrowRight", { altKey: true }],
    [" ", { ctrlKey: true }],
    ["Home", { metaKey: true }],
    ["b", { metaKey: true }],
    ["1", { ctrlKey: true }],
  ] as [string, KeyboardEventInit][])("leaves %j with a modifier (%j) to the browser", (key, held) => {
    const p = player({ at: "#2" });
    const request = vi.fn();
    p.doc.documentElement.requestFullscreen = request;
    expect(p.key(key, held).defaultPrevented).toBe(false);
    expect(p.active()).toBe(1);
    expect(request).not.toHaveBeenCalled();
    expect(p.doc.documentElement.hasAttribute("data-slop-blank")).toBe(false);
  });

  it("Shift means nothing with the arrows, so they are left alone", () => {
    const p = player();
    expect(p.key("ArrowRight", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(p.key("Enter", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(p.active()).toBe(0);
  });

  it("leaves Enter and Space to a focused control, and every key to a field", () => {
    const html = DECK.replace("<p>No id</p>", '<p>No id</p><input id="field">');
    const p = player({ html });
    const button = p.doc.querySelector("button")!;
    expect(p.key("Enter", {}, button).defaultPrevented).toBe(false);
    expect(p.key(" ", {}, button).defaultPrevented).toBe(false);
    expect(p.active()).toBe(0);
    const field = p.doc.getElementById("field")!;
    for (const key of ["ArrowRight", "b", "Backspace", "1"]) expect(p.key(key, {}, field).defaultPrevented).toBe(false);
    expect(p.active()).toBe(0);
    expect(p.doc.documentElement.hasAttribute("data-slop-blank")).toBe(false);
    // The arrows still navigate from a button.
    p.key("ArrowRight", {}, button);
    expect(p.active()).toBe(1);
  });

  describe("blanking the screen", () => {
    const blank = (p: ReturnType<typeof player>) => p.doc.documentElement.getAttribute("data-slop-blank");

    it.each([
      ["b", "black"],
      ["B", "black"],
      [".", "black"],
      ["w", "white"],
      ["W", "white"],
    ])("%j blanks it to %s, and again brings the slide back", (key, color) => {
      const p = player();
      expect(p.key(key).defaultPrevented).toBe(true);
      expect(blank(p)).toBe(color);
      p.key(key);
      expect(blank(p)).toBeNull();
    });

    it("switches between black and white", () => {
      const p = player();
      p.key("b");
      p.key("w");
      expect(blank(p)).toBe("white");
    });

    it("a navigation key or a click brings the slide back without moving on", () => {
      const p = player({ at: "#2" });
      for (const key of ["ArrowRight", " ", "Backspace", "Enter", "Home", "n"]) {
        p.key("b");
        p.key(key);
        expect(blank(p)).toBeNull();
        expect(p.active()).toBe(1);
      }
      p.key("w");
      p.click(p.doc.body, 1500);
      expect(blank(p)).toBeNull();
      expect(p.active()).toBe(1);
      p.click(p.doc.body, 1500);
      expect(p.active()).toBe(2);
    });

    it("hides the deck over a black or white page, but not in print", () => {
      const css = readFileSync("src-tauri/assets/runtime.css", "utf8");
      expect(css).toMatch(/html\[data-slop-blank\] \.deck\s*\{[^}]*opacity:\s*0\s*!important/);
      expect(css).toMatch(/html\[data-slop-blank="white"\] body\s*\{[^}]*background:\s*#fff\s*!important/);
      const print = css.slice(css.indexOf("@media print"));
      expect(print).toMatch(/html\[data-slop-blank\] \.deck,[^{]*\{[^}]*opacity:\s*1\s*!important/);
    });
  });

  describe("jumping to a slide by its number", () => {
    it("a number then Enter goes to that slide", () => {
      const p = player();
      expect(p.key("3").defaultPrevented).toBe(true);
      expect(p.active()).toBe(0);
      expect(p.key("Enter").defaultPrevented).toBe(true);
      expect(p.active()).toBe(2);
      p.key("1");
      p.key("Enter");
      expect(p.active()).toBe(0);
    });

    it("takes several digits and stops at the last slide", () => {
      const p = player();
      p.key("1");
      p.key("2");
      p.key("Enter");
      expect(p.active()).toBe(2);
    });

    it("forgets the number on another key, and after a pause", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const p = player();
      p.key("3");
      p.key("ArrowRight");
      expect(p.active()).toBe(1);
      // Enter alone goes on to the next slide.
      p.key("Home");
      p.key("Enter");
      expect(p.active()).toBe(1);
      p.key("3");
      vi.advanceTimersByTime(3000);
      p.key("Home");
      p.key("Enter");
      expect(p.active()).toBe(1);
    });

    it("counts the slides shown", () => {
      const html = DECK.replace('<section class="slide"><p>', '<section class="slide" data-hidden><p>');
      const p = player({ html });
      p.key("2");
      p.key("Enter");
      expect(p.doc.querySelector(".slide.active")?.id).toBe("end");
    });
  });

  it("Home jumps to the start and navigation stops at either end", () => {
    const p = player({ at: "#end" });
    p.key("ArrowRight");
    expect(p.active()).toBe(2);
    p.key("Home");
    expect(p.active()).toBe(0);
    p.key("ArrowLeft");
    expect(p.active()).toBe(0);
  });

  it("leaves other keys to the page", () => {
    const p = player();
    expect(p.key("a").defaultPrevented).toBe(false);
    expect(p.key("Tab").defaultPrevented).toBe(false);
    expect(p.active()).toBe(0);
  });

  it("names its keys in the comment that heads the file", () => {
    const head = RUNTIME.slice(0, RUNTIME.indexOf("*/"));
    for (const key of [
      "Space",
      "PageDown",
      "Enter",
      "Backspace",
      "Shift+Space",
      "Home/End",
      "N/P",
      "B or .",
      "W",
      "F",
      "R",
      "O for all slides",
      "K to play",
      "? for the list of keys",
      "?autoplay",
      "?loop",
    ]) {
      expect(head).toContain(key);
    }
  });

  it("F toggles full screen", () => {
    const p = player();
    const request = vi.fn();
    p.doc.documentElement.requestFullscreen = request;
    expect(p.key("f").defaultPrevented).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    const exit = vi.fn();
    Object.defineProperty(p.doc, "fullscreenElement", { value: p.doc.documentElement, configurable: true });
    p.doc.exitFullscreen = exit;
    p.key("F");
    expect(exit).toHaveBeenCalledOnce();
  });

  it("follows hash changes", () => {
    const p = player();
    p.window.location.hash = "#end";
    p.window.dispatchEvent(new p.window.HashChangeEvent("hashchange"));
    expect(p.active()).toBe(2);
  });

  it("a mouse click advances wherever it lands, the left quarter too", () => {
    const p = player();
    const slide = p.doc.querySelector("#intro p, #intro") as Element;
    p.click(slide, 1500);
    expect(p.active()).toBe(1);
    p.click(p.doc.body, 100);
    expect(p.active()).toBe(2);
  });

  it("a tap in the left quarter of a touch screen goes back", () => {
    const p = player({ at: "#end" });
    // Told by the click itself, where the browser says what made it.
    const tap = new p.window.MouseEvent("click", { clientX: 100, bubbles: true });
    Object.defineProperty(tap, "pointerType", { value: "touch" });
    p.doc.body.dispatchEvent(tap);
    expect(p.active()).toBe(1);
    // Or by the touch that ended just before it.
    touch(p, "touchstart", [[100, 300]]);
    touch(p, "touchend", [], [100, 300]);
    p.click(p.doc.body, 100);
    expect(p.active()).toBe(0);
    touch(p, "touchstart", [[1500, 300]]);
    touch(p, "touchend", [], [1500, 300]);
    p.click(p.doc.body, 1500);
    expect(p.active()).toBe(1);
  });

  it("clicks on interactive elements do not navigate", () => {
    const html = DECK.replace(
      "<button>Click me</button>",
      `<button>Click me</button><details><summary>More</summary></details><label>Name <input></label>
       <audio controls></audio><span role="button">Vote</span><span onclick="void 0">Count</span>`,
    );
    const p = player({ html });
    for (const control of ["button", "summary", "label", "input", "audio", "[role=button]", "[onclick]"]) {
      p.click(p.doc.querySelector(control)!, 1500);
      expect(p.active(), control).toBe(0);
    }
    p.key("End");
    p.click(p.doc.querySelector("a")!, 100);
    expect(p.active()).toBe(2);
  });

  it("a click that ends a selection of text does not navigate", () => {
    const p = player({ at: "#2" });
    const text = p.doc.querySelector("p")!.firstChild!;
    const range = p.doc.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 2);
    p.window.getSelection()!.addRange(range);
    p.click(p.doc.querySelector("p")!, 1500);
    expect(p.active()).toBe(1);
    p.window.getSelection()!.removeAllRanges();
    p.click(p.doc.querySelector("p")!, 1500);
    expect(p.active()).toBe(2);
  });

  it("swipes navigate", () => {
    const p = player();
    touch(p, "touchstart", [[500, 300]]);
    touch(p, "touchend", [], [400, 300]);
    expect(p.active()).toBe(1);
    touch(p, "touchstart", [[400, 300]]);
    touch(p, "touchend", [], [480, 310]);
    expect(p.active()).toBe(0);
    touch(p, "touchstart", [[400, 300]]);
    touch(p, "touchend", [], [420, 300]);
    expect(p.active()).toBe(0); // short drags are not swipes
  });

  it("a pinch, a second finger, a diagonal drag and a zoomed page change no slide", () => {
    const p = player({ at: "#2" });
    // Two fingers down at once.
    touch(p, "touchstart", [
      [500, 300],
      [700, 300],
    ]);
    touch(p, "touchend", [[700, 300]], [300, 300]);
    touch(p, "touchend", [], [900, 300]);
    expect(p.active()).toBe(1);
    // A second finger joining a touch.
    touch(p, "touchstart", [[500, 300]]);
    touch(p, "touchstart", [
      [500, 300],
      [700, 300],
    ]);
    touch(p, "touchend", [], [300, 300]);
    expect(p.active()).toBe(1);
    // As far down as across.
    touch(p, "touchstart", [[500, 300]]);
    touch(p, "touchend", [], [400, 400]);
    expect(p.active()).toBe(1);
    // A swipe over a zoomed page pans it.
    Object.defineProperty(p.window, "visualViewport", { value: { scale: 2 }, configurable: true });
    touch(p, "touchstart", [[500, 300]]);
    touch(p, "touchend", [], [300, 300]);
    expect(p.active()).toBe(1);
    Object.defineProperty(p.window, "visualViewport", { value: { scale: 1 }, configurable: true });
    touch(p, "touchstart", [[500, 300]]);
    touch(p, "touchend", [], [300, 300]);
    expect(p.active()).toBe(2);
  });

  it("scales the 1920×1080 stage to fit and centers it", () => {
    const p = player({ size: [960, 1080] });
    const deck = p.doc.querySelector<HTMLElement>(".deck")!;
    expect(deck.style.transform).toBe("translate(0px,270px) scale(0.5)");
    Object.defineProperty(p.window, "innerWidth", { value: 3840 });
    Object.defineProperty(p.window, "innerHeight", { value: 1080 });
    p.window.dispatchEvent(new p.window.Event("resize"));
    expect(deck.style.transform).toBe("translate(960px,0px) scale(1)");
  });

  it("scales a stage of another slide size, as laid out by the runtime CSS", () => {
    // A 1080×1350 portrait slide in a 1920×1080 window: fit to the height.
    const p = player({ stage: [1080, 1350] });
    const deck = p.doc.querySelector<HTMLElement>(".deck")!;
    expect(deck.style.transform).toBe("translate(528px,0px) scale(0.8)");
    Object.defineProperty(p.window, "innerWidth", { value: 540 });
    Object.defineProperty(p.window, "innerHeight", { value: 1350 });
    p.window.dispatchEvent(new p.window.Event("resize"));
    expect(deck.style.transform).toBe("translate(0px,337.5px) scale(0.5)");
  });

  it("ignores slides nested inside slides", () => {
    const p = player();
    p.key("End");
    expect(p.active()).toBe(2);
    expect(p.doc.querySelector(".nested")!.classList.contains("active")).toBe(false);
  });

  it("does nothing on a page without slides", () => {
    const p = player({ html: `<main class="deck"></main>` });
    expect(p.doc.querySelector<HTMLElement>(".deck")!.style.transform).toBe("");
    expect(hashOf(p.window)).toBe("");
    const none = player({ html: `<section class="slide" id="a"></section>` });
    expect(none.activeCount()).toBe(0);
  });
});

describe("player: embedded in the editor", () => {
  it("shows the requested slide without touching the URL", () => {
    const p = player({ at: "?embed&slide=end" });
    expect(p.active()).toBe(2);
    expect(hashOf(p.window)).toBe("");
  });

  it("finds unnamed slides by the positional ids the editor gives them", () => {
    // deck.rs `load` names a slide without an id "#<n>"; slideUrl passes that through.
    expect(player({ at: "?embed&slide=%232" }).active()).toBe(1);
    expect(player({ at: "?embed&slide=2" }).active()).toBe(1);
    expect(player({ at: "?embed&slide=%23" }).active()).toBe(0);
  });

  it("does not navigate on its own, but forwards keys to the editor", () => {
    const parent = { postMessage: vi.fn() };
    const p = player({ at: "?embed&slide=intro", parent });
    const event = p.key("ArrowRight");
    expect(p.active()).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    expect(parent.postMessage).toHaveBeenCalledWith(
      { type: "slop:key", key: "ArrowRight", mod: false, shift: false },
      "*",
    );
    p.click(p.doc.body, 1500);
    expect(p.active()).toBe(0);
  });

  it("marks thumbnails as static so animations show their final frame", () => {
    expect(player({ at: "?embed&slide=intro&static" }).doc.documentElement.hasAttribute("data-slop-static")).toBe(true);
    expect(player({ at: "?embed&slide=intro" }).doc.documentElement.hasAttribute("data-slop-static")).toBe(false);
  });
});

describe("player: in the presenter", () => {
  it("reports each slide shown to the editor", () => {
    const parent = { postMessage: vi.fn() };
    const p = player({ at: "#intro", parent });
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: "slop:slide", id: "intro", index: 0 }, "*");
    p.key("ArrowRight");
    expect(parent.postMessage).toHaveBeenCalledWith(
      { type: "slop:key", key: "ArrowRight", mod: false, shift: false },
      "*",
    );
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: "slop:slide", id: null, index: 1 }, "*");
    expect(p.active()).toBe(1);
  });

  it("tells the presenter when a modifier is held", () => {
    const parent = { postMessage: vi.fn() };
    const p = player({ parent });
    p.window.dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "z", metaKey: true }));
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: "slop:key", key: "z", mod: true, shift: false }, "*");
    p.window.dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: "slop:key", key: "z", mod: true, shift: false }, "*");
    p.window.dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "Z", metaKey: true, shiftKey: true }));
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: "slop:key", key: "Z", mod: true, shift: true }, "*");
  });

  it("navigates on keys the presenter forwards while its drawing tools have focus", () => {
    const parent = { postMessage: vi.fn() };
    const p = player({ parent });
    const go = (key: unknown) =>
      p.window.dispatchEvent(new p.window.MessageEvent("message", { data: { type: "slop:go", key } }));
    go("ArrowRight");
    expect(p.active()).toBe(1);
    go("End");
    expect(p.active()).toBe(2);
    go("ArrowLeft");
    expect(p.active()).toBe(1);
    go("x");
    p.window.dispatchEvent(new p.window.MessageEvent("message", { data: "ArrowRight" }));
    p.window.dispatchEvent(new p.window.MessageEvent("message", { data: null }));
    expect(p.active()).toBe(1);
  });

  it("keeps the animations that began with the slide to the app's narration clock", () => {
    // jsdom runs no animations: fake them, and the document's clock, as a browser has them.
    const timeline = { currentTime: 1000 };
    const fake = (target: Element, endTime: number, startTime: number | null, name: string | null = "rise") => ({
      animationName: name,
      effect: { target, getComputedTiming: () => ({ endTime }) },
      currentTime: 0 as number | null,
      startTime,
      playState: "running",
      play() {
        this.playState = "running";
      },
      pause() {
        this.playState = "paused";
      },
    });
    let animations: ReturnType<typeof fake>[] = [];
    const p = player({
      at: "?embed&slide=intro",
      parent: { postMessage: vi.fn() },
      setup: (window) => {
        Object.assign(window.document, { timeline, getAnimations: () => animations });
      },
    });
    // The slide showed at 1000 ms on the document's clock.
    const [intro, other] = [p.doc.getElementById("intro")!, p.doc.getElementById("end")!];
    const word = fake(intro.querySelector("button")!, 5000, 1000);
    const beat = fake(intro, Number.POSITIVE_INFINITY, 1010);
    // A loop running since before the slide showed, carrying on across slides.
    const loop = fake(intro, Number.POSITIVE_INFINITY, 0);
    const still = fake(intro, 5000, null);
    still.playState = "paused";
    const elsewhere = fake(other, 5000, 1000);
    const fade = fake(intro, 350, 1000, null);
    animations = [word, beat, loop, still, elsewhere, fade];
    const clock = (at: unknown, slide = "intro", paused = false) =>
      p.window.dispatchEvent(new p.window.MessageEvent("message", { data: { type: "slop:clock", slide, at, paused } }));

    clock(2.5);
    expect([word.currentTime, word.playState]).toEqual([2500, "running"]);
    expect(beat.currentTime).toBe(2500);
    for (const left of [loop, elsewhere, fade]) expect(left.currentTime).toBe(0);
    expect(still.playState).toBe("paused");
    // Running, a small drift is left alone; a larger one is caught up, even once seeking moved
    // its start.
    word.currentTime = 2530;
    word.startTime = 0;
    clock(2.5);
    expect(word.currentTime).toBe(2530);
    clock(3.5);
    expect(word.currentTime).toBe(3500);
    // Past its end it rests on its last frame, and plays again from earlier on.
    clock(9);
    expect([word.currentTime, word.playState]).toEqual([5000, "paused"]);
    expect(beat.playState).toBe("running");
    clock(1);
    expect([word.currentTime, word.playState]).toEqual([1000, "running"]);
    // Nothing for another slide, or a time that is none.
    clock(2, "end");
    clock("later");
    clock(-1);
    expect(word.currentTime).toBe(1000);

    // Held at a moment (the timeline's playhead, not playing), they stop exactly there, however
    // little they drifted, and move with it; what was paused on purpose or runs across slides is left.
    clock(1.02, "intro", true);
    expect([word.currentTime, word.playState]).toEqual([1020, "paused"]);
    expect([beat.currentTime, beat.playState]).toEqual([1020, "paused"]);
    clock(0.4, "intro", true);
    expect([word.currentTime, word.playState]).toEqual([400, "paused"]);
    expect([loop.currentTime, loop.playState, still.playState]).toEqual([0, "running", "paused"]);
    // Playing again takes them on from there.
    clock(0.5);
    expect([word.currentTime, word.playState]).toEqual([500, "running"]);
    // Let go of while held, they run on their own again; one resting on its end stays there.
    clock(2, "intro", true);
    clock(null);
    expect([word.currentTime, word.playState, beat.playState]).toEqual([2000, "running", "running"]);
    expect(still.playState).toBe("paused");
    clock(9, "intro", true);
    clock(null);
    expect([word.currentTime, word.playState]).toEqual([5000, "paused"]);
    expect(beat.playState).toBe("running");
  });

  it("counts animations that began within a frame of the slide showing as the slide's", () => {
    const fake = (target: Element, startTime: number | null, endTime = 5000) => ({
      animationName: "rise",
      effect: { target, getComputedTiming: () => ({ endTime }) },
      currentTime: 0 as number | null,
      startTime,
      playState: "running",
      play() {
        this.playState = "running";
      },
      pause() {
        this.playState = "paused";
      },
    });
    let animations: ReturnType<typeof fake>[] = [];
    const clockOf = (timeline: object | undefined) => {
      const p = player({
        at: "?embed&slide=intro",
        parent: { postMessage: vi.fn() },
        setup: (window) => {
          Object.assign(window.document, { timeline, getAnimations: () => animations });
        },
      });
      return { p, intro: p.doc.getElementById("intro")! };
    };

    // The slide showed at 1000 ms: an animation 50 ms earlier is still its own, 51 ms is not.
    let { p, intro } = clockOf({ currentTime: 1000 });
    const edge = fake(intro, 950);
    const before = fake(intro, 949);
    // One with no length (reduced motion) rests at its end.
    const none = fake(intro, 1000, 0);
    animations = [edge, before, none];
    p.window.dispatchEvent(
      new p.window.MessageEvent("message", { data: { type: "slop:clock", slide: "intro", at: 2 } }),
    );
    expect(edge.currentTime).toBe(2000);
    expect(before.currentTime).toBe(0);
    expect([none.currentTime, none.playState]).toEqual([0, "paused"]);

    // Without a document clock (WebKit before its first frame) every animation on the slide is
    // its own.
    ({ p, intro } = clockOf(undefined));
    const early = fake(intro, 0);
    animations = [early];
    p.window.dispatchEvent(
      new p.window.MessageEvent("message", { data: { type: "slop:clock", slide: "intro", at: 1.5 } }),
    );
    expect(early.currentTime).toBe(1500);
  });

  it("takes the keys the presenter forwards with Shift, and leaves N and P to its tools", () => {
    const parent = { postMessage: vi.fn() };
    const p = player({ at: "#end", parent });
    const go = (key: string, shift = false) =>
      p.window.dispatchEvent(new p.window.MessageEvent("message", { data: { type: "slop:go", key, shift } }));
    go(" ", true);
    expect(p.active()).toBe(1);
    go("Backspace");
    expect(p.active()).toBe(0);
    go("Enter");
    expect(p.active()).toBe(1);
    go("n");
    go("p");
    expect(p.active()).toBe(1);
    expect(p.key("n").defaultPrevented).toBe(false);
    expect(p.key("p").defaultPrevented).toBe(false);
    expect(p.active()).toBe(1);
    go("3");
    go("Enter");
    expect(p.active()).toBe(2);
    go("b");
    expect(p.doc.documentElement.getAttribute("data-slop-blank")).toBe("black");
    go("ArrowLeft");
    expect(p.doc.documentElement.hasAttribute("data-slop-blank")).toBe(false);
    expect(p.active()).toBe(2);
  });

  it("tells the presenter of Alt, and does not act on a key held with a modifier", () => {
    const parent = { postMessage: vi.fn() };
    const p = player({ parent });
    expect(p.key("ArrowRight", { altKey: true }).defaultPrevented).toBe(false);
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      { type: "slop:key", key: "ArrowRight", mod: false, shift: false, alt: true },
      "*",
    );
    expect(p.key("ArrowRight", { metaKey: true }).defaultPrevented).toBe(false);
    expect(p.active()).toBe(0);
  });

  it("tells the presenter when the pointer moves over the slide, a few times a second at most", () => {
    let now = 10_000;
    const clock = (window: DOMWindow) => {
      window.Date.now = () => now;
    };
    const parent = { postMessage: vi.fn() };
    const p = player({ parent, setup: clock });
    const moves = () => parent.postMessage.mock.calls.filter(([d]) => (d as { type: string }).type === "slop:pointer");
    const move = () => p.doc.dispatchEvent(new p.window.MouseEvent("mousemove", { bubbles: true }));
    move();
    move();
    expect(moves()).toHaveLength(1);
    expect(moves()[0]).toEqual([{ type: "slop:pointer" }, "*"]);
    now = 10_300;
    move();
    expect(moves()).toHaveLength(2);
    // Not from the editor's frames, nor a file of its own.
    const embedded = { postMessage: vi.fn() };
    const e = player({ at: "?embed&slide=intro", parent: embedded });
    e.doc.dispatchEvent(new e.window.MouseEvent("mousemove", { bubbles: true }));
    expect(embedded.postMessage).not.toHaveBeenCalledWith({ type: "slop:pointer" }, "*");
  });

  it("hides the cursor while the presenter says the pointer rests, and tells of the next move at once", () => {
    const parent = { postMessage: vi.fn() };
    const p = player({ parent });
    const idle = (value: boolean) =>
      p.window.dispatchEvent(new p.window.MessageEvent("message", { data: { type: "slop:idle", idle: value } }));
    const hidden = () => p.doc.documentElement.hasAttribute("data-slop-idle");
    p.doc.dispatchEvent(new p.window.MouseEvent("mousemove", { bubbles: true }));
    idle(true);
    expect(hidden()).toBe(true);
    parent.postMessage.mockClear();
    p.doc.dispatchEvent(new p.window.MouseEvent("mousemove", { bubbles: true }));
    expect(parent.postMessage).toHaveBeenCalledWith({ type: "slop:pointer" }, "*");
    // Told once: the moves that follow before the presenter answers say nothing new.
    for (let i = 0; i < 10; i++) p.doc.dispatchEvent(new p.window.MouseEvent("mousemove", { bubbles: true }));
    expect(parent.postMessage.mock.calls.filter(([d]) => d.type === "slop:pointer")).toHaveLength(1);
    idle(false);
    expect(hidden()).toBe(false);
    const css = readFileSync("src-tauri/assets/runtime.css", "utf8");
    expect(css).toMatch(/html\[data-slop-idle\] \*\s*\{[^}]*cursor:\s*none\s*!important/);
    // A file of its own takes no such message.
    const alone = player();
    alone.window.dispatchEvent(new alone.window.MessageEvent("message", { data: { type: "slop:idle", idle: true } }));
    expect(alone.doc.documentElement.hasAttribute("data-slop-idle")).toBe(false);
  });

  it("ignores forwarded keys when not in the presenter", () => {
    const go = (p: ReturnType<typeof player>) =>
      p.window.dispatchEvent(new p.window.MessageEvent("message", { data: { type: "slop:go", key: "End" } }));
    const standalone = player();
    go(standalone);
    expect(standalone.active()).toBe(0);
    const embedded = player({ at: "?embed&slide=intro", parent: { postMessage: vi.fn() } });
    go(embedded);
    expect(embedded.active()).toBe(0);
  });

  it("leaves full screen to the app", () => {
    const parent = { postMessage: vi.fn() };
    const p = player({ parent });
    const request = vi.fn();
    p.doc.documentElement.requestFullscreen = request;
    expect(p.key("f").defaultPrevented).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not report a slide that is already showing", () => {
    const parent = { postMessage: vi.fn() };
    const p = player({ parent });
    parent.postMessage.mockClear();
    p.key("Home");
    expect(parent.postMessage.mock.calls.filter(([d]) => (d as { type: string }).type === "slop:slide")).toEqual([]);
  });
});

describe("player: control strip", () => {
  const strip = (p: ReturnType<typeof player>) => p.doc.querySelector<HTMLElement>(".slop-controls");
  const shown = (p: ReturnType<typeof player>) => p.doc.documentElement.hasAttribute("data-slop-controls");
  const button = (p: ReturnType<typeof player>, name: string) =>
    [...strip(p)!.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")!.startsWith(name))!;
  const move = (p: ReturnType<typeof player>, type = "mousemove") =>
    p.doc.dispatchEvent(new p.window.Event(type, { bubbles: true }));
  const fullscreen = (window: DOMWindow) => {
    window.document.documentElement.requestFullscreen = vi.fn();
  };

  const names = (p: ReturnType<typeof player>) =>
    [...strip(p)!.children].map((el) => el.getAttribute("aria-label") ?? el.textContent);

  it("has previous, the slide count, next, all slides, full screen and the keys", () => {
    const p = player({ setup: fullscreen });
    expect(strip(p)!.getAttribute("role")).toBe("toolbar");
    expect(names(p)).toEqual([
      "Previous slide (←)",
      "1 / 3",
      "Next slide (→)",
      "All slides (O)",
      "Full screen (F)",
      "Keys (?)",
    ]);
  });

  it("leaves full screen out where the browser has none", () => {
    expect(names(player())).not.toContain("Full screen (F)");
  });

  it("gives a finger room on its buttons", () => {
    const css = readFileSync("src-tauri/assets/runtime.css", "utf8");
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.slop-controls button \{\s*width: 44px;\s*height: 44px;/);
  });

  it("comes into sight for Tab, so the keyboard can reach it", () => {
    const p = player();
    expect(p.key("Tab").defaultPrevented).toBe(false);
    expect(shown(p)).toBe(true);
  });

  it("navigates, keeps count and goes full screen", () => {
    const p = player({ setup: fullscreen });
    button(p, "Next").click();
    expect(p.active()).toBe(1);
    expect(strip(p)!.querySelector(".slop-controls-count")!.textContent).toBe("2 / 3");
    button(p, "Previous").click();
    expect(p.active()).toBe(0);
    p.key("End");
    expect(strip(p)!.querySelector(".slop-controls-count")!.textContent).toBe("3 / 3");
    button(p, "Full screen").click();
    expect(p.doc.documentElement.requestFullscreen).toHaveBeenCalledOnce();
  });

  it("counts the slides shown, not the hidden ones", () => {
    const html = DECK.replace('<section class="slide"><p>', '<section class="slide" data-hidden><p>');
    expect(strip(player({ html }))!.querySelector(".slop-controls-count")!.textContent).toBe("1 / 2");
  });

  it("does not take the press that advances the slide, and a press on it advances nothing", () => {
    const p = player();
    p.click(strip(p)!.querySelector(".slop-controls-count")!, 1500);
    expect(p.active()).toBe(0);
    // Its buttons leave the focus where it was, so it can go again.
    const down = new p.window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button(p, "Next").dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    const css = readFileSync("src-tauri/assets/runtime.css", "utf8");
    const rule = /\.slop-controls\s*\{([^}]*)\}/.exec(css)![1]!;
    // Only as wide as its buttons, in the middle: the slide beside it still takes a press.
    expect(rule).toMatch(/left:\s*50%/);
    expect(rule).not.toMatch(/(^|[\s;])(right|width|inset):/);
  });

  it("shows while the pointer moves or after a touch, and goes after a pause", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = player();
    expect(shown(p)).toBe(false);
    move(p);
    expect(shown(p)).toBe(true);
    vi.advanceTimersByTime(2000);
    move(p);
    vi.advanceTimersByTime(2000);
    expect(shown(p)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(shown(p)).toBe(false);
    move(p, "touchstart");
    expect(shown(p)).toBe(true);
  });

  it("stays while the pointer is on it or the keyboard is in it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = player();
    move(p);
    strip(p)!.dispatchEvent(new p.window.MouseEvent("mouseenter"));
    vi.advanceTimersByTime(10_000);
    expect(shown(p)).toBe(true);
    strip(p)!.dispatchEvent(new p.window.MouseEvent("mouseleave"));
    vi.advanceTimersByTime(2500);
    expect(shown(p)).toBe(false);
    move(p);
    button(p, "Next").focus();
    vi.advanceTimersByTime(10_000);
    expect(shown(p)).toBe(true);
    button(p, "Next").blur();
    vi.advanceTimersByTime(2500);
    expect(shown(p)).toBe(false);
  });

  it("brings a blanked slide back instead of moving on", () => {
    const p = player();
    p.key("b");
    button(p, "Next").click();
    expect(p.doc.documentElement.hasAttribute("data-slop-blank")).toBe(false);
    expect(p.active()).toBe(0);
  });

  it.each([
    ["in the app's show", "#intro", true],
    ["in the editor's frames", "?embed&slide=intro", true],
    ["in a thumbnail", "?embed&slide=intro&static", true],
    ["for a still", "?static", false],
    ["for a PDF, video or image capture", "?static&print", false],
    ["for a video with animations", "?print", false],
  ])("is not there %s", (_where, at, framed) => {
    const p = player({ at, parent: framed ? { postMessage: vi.fn() } : undefined });
    expect(strip(p)).toBeNull();
    move(p);
    expect(shown(p)).toBe(false);
  });

  it("is hidden from the pointer and the keyboard until shown, without motion when asked, and never printed", () => {
    const css = readFileSync("src-tauri/assets/runtime.css", "utf8");
    expect(css).toMatch(/\.slop-controls\s*\{[^}]*visibility:\s*hidden/);
    expect(css).toMatch(/html\[data-slop-controls\] \.slop-controls\s*\{[^}]*visibility:\s*visible/);
    const reduced = css.slice(css.indexOf("prefers-reduced-motion"), css.indexOf("@media print"));
    expect(reduced).toMatch(/\.slop-controls[^{]*\{[^}]*transition:\s*none\s*!important/);
    const print = css.slice(css.indexOf("@media print"));
    expect(print).toMatch(/\.slop-controls,[^{]*\{[^}]*display:\s*none\s*!important/);
  });
});

describe("player: hidden slides", () => {
  const HIDDEN = `<!DOCTYPE html><html><body>
<main class="deck">
  <section class="slide" id="a"></section>
  <section class="slide" id="b" data-hidden></section>
  <section class="slide" id="c"></section>
  <section class="slide" id="d" data-hidden></section>
</main></body></html>`;
  const play = (at: string, parent?: PlayerOptions["parent"]) => {
    const p = player({ at, html: HIDDEN, parent });
    return { ...p, activeId: () => p.doc.querySelector(".slide.active")?.id };
  };

  it("skips hidden slides when navigating", () => {
    const p = play("#a");
    expect(p.activeId()).toBe("a");
    p.key("ArrowRight");
    expect(p.activeId()).toBe("c");
    p.key("ArrowRight");
    expect(p.activeId()).toBe("c");
    p.key("ArrowLeft");
    expect(p.activeId()).toBe("a");
    p.key("End");
    expect(p.activeId()).toBe("c");
  });

  it("starting on a hidden slide lands on the next shown one, or the last", () => {
    expect(play("#b").activeId()).toBe("c");
    expect(play("#d").activeId()).toBe("c");
  });

  it("numbers slides by shown position", () => {
    expect(play("#2").activeId()).toBe("c");
  });

  it("never reports a hidden slide to the presenter", () => {
    const postMessage = vi.fn();
    play("#b", { postMessage });
    const ids = postMessage.mock.calls.map(([data]) => (data as { id?: string }).id);
    expect(ids).toEqual(["c"]);
  });

  it("still renders a hidden slide when the editor embeds it", () => {
    expect(play("?embed&slide=b").activeId()).toBe("b");
    expect(play("?embed&slide=%232").activeId()).toBe("b");
  });
});

describe("player: section markers", () => {
  const SECTIONED = DECK.replace(
    `<section class="slide" id="end">`,
    `<div class="deck-section" data-title="Last part"></div>\n  <section class="slide" id="end">`,
  ).replace(`<main class="deck">`, `<main class="deck">\n  <div class="deck-section" data-title="First part"></div>`);

  it("steps through slides only, never stopping on a marker", () => {
    const p = player({ html: SECTIONED });
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push(p.doc.querySelector(".slide.active")?.id ?? "");
      p.key("ArrowRight");
    }
    expect(seen).toEqual(["intro", "", "end"]);
    expect(p.activeCount()).toBe(1);
    expect(p.doc.querySelectorAll(".deck-section.active")).toHaveLength(0);
  });

  it("addresses slides by position without counting markers", () => {
    const p = player({ html: SECTIONED, at: "#2" });
    expect(p.active()).toBe(1);
    const embedded = player({ html: SECTIONED, at: "?embed&slide=end" });
    expect(embedded.doc.querySelector(".slide.active")?.id).toBe("end");
  });

  it("is hidden by the runtime stylesheet, on screen and in print", () => {
    const css = readFileSync("src-tauri/assets/runtime.css", "utf8");
    expect(css).toMatch(/\.deck > \.deck-section\s*\{[^}]*display:\s*none\s*!important/);
  });
});

describe("player: review marks", () => {
  const MARKS = {
    intro: [
      {
        tool: "pen",
        color: "#ef4444",
        points: [
          [0.1, 0.2],
          [0.5, 0.5],
        ],
      },
      { tool: "highlighter", color: "#facc15", points: [[0.25, 0.25]] },
    ],
    gone: [{ tool: "pen", color: "#000", points: [[0, 0]] }],
  };
  const REVIEWED = DECK.replace(
    "</body>",
    `<script type="application/json" id="slopslide-review">${JSON.stringify(MARKS)}</script></body>`,
  );
  const shown = (p: ReturnType<typeof player>) => p.doc.documentElement.hasAttribute("data-slop-review");

  it("starts hidden and toggles with R", () => {
    const p = player({ html: REVIEWED });
    expect(shown(p)).toBe(false);
    expect(p.doc.querySelector(".slop-review")).toBeNull();
    expect(p.key("r").defaultPrevented).toBe(true);
    expect(shown(p)).toBe(true);
    p.key("R");
    expect(shown(p)).toBe(false);
    p.key("r");
    expect(p.doc.querySelectorAll(".slop-review")).toHaveLength(1);
  });

  it("never shows them in the app's show, which the audience sees", () => {
    const p = player({ html: REVIEWED, at: "?show&review" });
    expect(shown(p)).toBe(false);
    expect(p.key("r").defaultPrevented).toBe(false);
    expect(shown(p)).toBe(false);
    expect(p.doc.querySelector(".slop-review")).toBeNull();
  });

  it("draws each slide's strokes over that slide, in slide pixels", () => {
    const p = player({ html: REVIEWED, at: "?review" });
    expect(shown(p)).toBe(true);
    const svg = p.doc.querySelector("#intro > svg.slop-review")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 1920 1080");
    const [pen, dot] = [...svg.querySelectorAll("path")];
    expect(pen!.getAttribute("d")).toBe("M192 216L960 540");
    expect(pen!.getAttribute("stroke")).toBe("#ef4444");
    expect(pen!.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    expect(dot!.getAttribute("d")).toBe("M480 270l0.01 0");
    expect(dot!.getAttribute("stroke-opacity")).toBe("0.4");
  });

  it("draws marks in the pixels of the deck's slide size", () => {
    const p = player({ html: REVIEWED, at: "?review", stage: [1080, 1080] });
    const svg = p.doc.querySelector("#intro > svg.slop-review")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 1080 1080");
    expect(svg.querySelector("path")!.getAttribute("d")).toBe("M108 216L540 540");
  });

  it("draws longer strokes as the same smooth curve the app draws", () => {
    const points: [number, number][] = [
      [0, 0],
      [0.5, 0],
      [0.5, 0.5],
      [0, 0.5],
    ];
    const html = DECK.replace(
      "</body>",
      `<script type="application/json" id="slopslide-review">${JSON.stringify({ intro: [{ tool: "pen", color: "#000", points }] })}</script></body>`,
    );
    const p = player({ html, at: "?review" });
    const path = p.doc.querySelector("#intro > svg.slop-review path")!;
    expect(path.getAttribute("d")).toBe("M0 0L480 0Q960 0 960 270Q960 540 0 540");
    expect(path.getAttribute("d")).toBe(strokePath(toPixels(points, 1920, 1080)));
  });

  it("leaves Cmd+R to the browser and decks without marks alone", () => {
    const p = player({ html: REVIEWED });
    const event = new p.window.KeyboardEvent("keydown", { key: "r", metaKey: true, cancelable: true });
    p.window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(shown(p)).toBe(false);
    const plain = player();
    expect(plain.key("r").defaultPrevented).toBe(false);
    expect(shown(plain)).toBe(false);
  });

  it("leaves the marks to the editor in embedded previews", () => {
    const p = player({ html: REVIEWED, at: "?embed&review" });
    expect(p.doc.querySelector(".slop-review")).toBeNull();
  });

  it("ignores a damaged review block", () => {
    const p = player({ html: REVIEWED.replace('{"intro"', "{intro") });
    expect(p.key("r").defaultPrevented).toBe(false);
    expect(p.active()).toBe(0);
  });

  it("is hidden by the runtime stylesheet until shown", () => {
    const css = readFileSync("src-tauri/assets/runtime.css", "utf8");
    expect(css).toMatch(/\.slide > \.slop-review\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/html\[data-slop-review\] \.slide > \.slop-review\s*\{[^}]*display:\s*block/);
  });
});

describe("player: text that shrinks to fit", () => {
  const FIT_DECK = `<!DOCTYPE html><html><body><main class="deck">
  <section class="slide" id="a">
    <div id="box" data-autofit="shrink" style="height: 200px; font-size: 40px">Long text <span id="big" style="font-size: 80px">big</span> <b>bold</b></div>
    <div id="short" data-autofit="shrink" style="font-size: 40px">Short</div>
    <div id="plain" style="font-size: 40px">Overflowing, but not asked to fit</div>
  </section>
</main></body></html>`;

  /** Lays out a box 200px tall whose text is as tall as 10× its own font size (5× for #short). */
  const layout = (window: DOMWindow) => {
    const proto = window.HTMLElement.prototype;
    const size = (el: HTMLElement) => Number.parseFloat(el.style.fontSize || "40");
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 200 });
    Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(proto, "scrollWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(proto, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return size(this) * (this.id === "short" ? 5 : 10);
      },
    });
  };

  it("scales every font size in the box by the same factor until the text fits", () => {
    const p = player({ html: FIT_DECK, setup: layout });
    const box = p.doc.getElementById("box")!;
    const big = p.doc.getElementById("big")!;
    const k = Number.parseFloat(box.style.fontSize) / 40;
    // 10 × 40px × k must fit in 200px (give or take a pixel), and the search lands just under it.
    expect(10 * 40 * k).toBeLessThanOrEqual(201);
    expect(k).toBeGreaterThan(0.49);
    expect(box.style.getPropertyPriority("font-size")).toBe("important");
    expect(Number.parseFloat(big.style.fontSize) / 80).toBeCloseTo(k, 2);
    expect(Number.parseFloat(p.doc.querySelector<HTMLElement>("#box b")!.style.fontSize) / 40).toBeCloseTo(k, 2);
    const fit = (p.window as unknown as { slopAutofit: { scale: (el: Element) => number } }).slopAutofit;
    expect(fit.scale(box)).toBeCloseTo(k, 3);
  });

  it("leaves text that fits, and boxes that do not ask, alone", () => {
    const p = player({ html: FIT_DECK, setup: layout });
    expect(p.doc.getElementById("short")!.getAttribute("style")).toBe("font-size: 40px");
    expect(p.doc.getElementById("plain")!.getAttribute("style")).toBe("font-size: 40px");
  });

  it("gives back the inline font sizes it replaced, so the markup can be saved without the fit", () => {
    const p = player({ html: FIT_DECK, setup: layout });
    const fit = (p.window as unknown as { slopAutofit: Record<string, (el: Element) => unknown> }).slopAutofit;
    const box = p.doc.getElementById("box")!;
    expect(fit.original!(box)).toEqual({ value: "40px", priority: "" });
    expect(fit.original!(p.doc.querySelector("#box b")!)).toEqual({ value: "", priority: "" });
    fit.unfit!(box);
    expect(box.outerHTML).toBe(
      `<div id="box" data-autofit="shrink" style="height: 200px; font-size: 40px;">Long text <span id="big" style="font-size: 80px;">big</span> <b>bold</b></div>`,
    );
    expect(fit.original!(box)).toBeNull();
    expect(fit.scale!(box)).toBe(1);
  });

  interface Autofit {
    fit: (el: Element) => boolean;
    unfit: (el: Element) => void;
    scale: (el: Element) => number;
  }
  const autofit = (window: DOMWindow) => (window as unknown as { slopAutofit: Autofit }).slopAutofit;

  /**
   * `layout`, with #box's text as tall as `lines.count`× its font size, counting how often each
   * box is measured: once for whether it overflows at all, then once for every size tried.
   */
  function measured(lines = { count: 10 }) {
    const reads: Record<string, number> = {};
    const setup = (window: DOMWindow) => {
      layout(window);
      Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get(this: HTMLElement) {
          reads[this.id] = (reads[this.id] ?? 0) + 1;
          const size = Number.parseFloat(this.style.fontSize || "40");
          return size * (this.id === "short" ? 5 : lines.count);
        },
      });
    };
    return { lines, reads, setup };
  }

  it("searches from the size a box was fitted to before, and finds what a full search does", () => {
    const m = measured();
    const p = player({ html: FIT_DECK, setup: m.setup });
    const box = p.doc.getElementById("box")!;
    const fit = autofit(p.window);
    const size = () => Number.parseFloat(box.style.fontSize);
    // From scratch: whether it overflows, then halving 0.2 to 1 down to a hundredth.
    expect(m.reads.box).toBe(7);
    const first = size();
    // Nothing changed: it fits where it did and no larger, and that is all it takes to know.
    m.reads.box = 0;
    expect(fit.fit(box)).toBe(true);
    expect(m.reads.box).toBe(3);
    expect(size()).toBe(first);
    // The editor takes the fit off while it changes the text; the next search still starts there.
    for (const [count, tries] of [
      // A little more text, as when typing: found in a few tries.
      [10.2, 5],
      [10.5, 5],
      [10.4, 5],
      // Far from where it was (a paste, say) it gets there too, in a few tries more than from scratch.
      [18, 13],
      [7, 13],
    ] as const) {
      fit.unfit(box);
      m.lines.count = count;
      m.reads.box = 0;
      fit.fit(box);
      const scratch = measured({ count });
      const full = player({ html: FIT_DECK, setup: scratch.setup });
      const whole = Number.parseFloat(full.doc.getElementById("box")!.style.fontSize);
      // Within the hundredth the search stops at; a full search never takes fewer tries.
      expect(Math.abs(size() - whole)).toBeLessThanOrEqual(0.4);
      expect(fit.scale(box)).toBeCloseTo(autofit(full.window).scale(full.doc.getElementById("box")!), 2);
      expect(scratch.reads.box).toBeGreaterThanOrEqual(7);
      expect(m.reads.box).toBeLessThanOrEqual(tries);
      // It fits, and a hundredth more would not.
      expect(count * size()).toBeLessThanOrEqual(201);
      expect(count * (size() + 0.4)).toBeGreaterThan(201);
    }
    // Text that fits again gets its own size back.
    m.lines.count = 4;
    expect(fit.fit(box)).toBe(false);
    expect(box.style.fontSize).toBe("40px");
    expect(fit.scale(box)).toBe(1);
  });

  const TWO_SLIDES = `<!DOCTYPE html><html><body><main class="deck">
  <section class="slide" id="a"><div id="one" data-autofit="shrink" style="font-size: 40px">Long</div></section>
  <section class="slide" id="b"><div id="two" data-autofit="shrink" style="font-size: 40px">Long</div></section>
</main></body></html>`;

  it("fits only the slide an embedded preview shows, and every slide of a show or a print", () => {
    const fittedIn = (at: string) => {
      const m = measured();
      const p = player({ html: TWO_SLIDES, at, setup: m.setup });
      const fit = autofit(p.window);
      return {
        scales: ["one", "two"].map((id) => fit.scale(p.doc.getElementById(id)!) < 1),
        measured: Object.keys(m.reads).sort(),
      };
    };
    // The other slide's box is not even measured.
    expect(fittedIn("?embed&slide=b")).toEqual({ scales: [false, true], measured: ["two"] });
    expect(fittedIn("?embed&slide=a&static")).toEqual({ scales: [true, false], measured: ["one"] });
    for (const at of ["", "#b", "?show", "?print", "?static&print"]) {
      expect(fittedIn(at)).toEqual({ scales: [true, true], measured: ["one", "two"] });
    }
  });

  describe("as the page loads", () => {
    /** A page whose web fonts load when the test says; `fits()` counts how often every box was fitted. */
    function loading({ fonts = true } = {}) {
      const m = measured();
      const faces = [{ status: "loading" }, { status: "unloaded" }];
      let fontsReady = () => {};
      const p = player({
        html: FIT_DECK.replace("</section>", '<img id="picture"></section>'),
        setup: (window) => {
          m.setup(window);
          if (!fonts) return;
          const ready = new Promise<void>((resolve) => {
            fontsReady = resolve;
          });
          Object.defineProperty(window.document, "fonts", {
            value: { ready, forEach: (fn: (face: { status: string }) => void) => faces.forEach(fn) },
          });
        },
      });
      return {
        ...p,
        lines: m.lines,
        faces,
        /** #short fits, so each fit of every box measures it once. */
        fits: () => m.reads.short,
        size: () => Number.parseFloat(p.doc.getElementById("box")!.style.fontSize),
        fontsReady: async () => {
          fontsReady();
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
        loaded: () => p.window.dispatchEvent(new p.window.Event("load")),
      };
    }

    it("fits once when nothing arrives that changes how the text measures", async () => {
      const p = loading();
      expect(p.fits()).toBe(1);
      // No font was loaded after all (the text needed none), and the page had nothing to wait for.
      p.faces[0]!.status = "error";
      await p.fontsReady();
      p.loaded();
      expect(p.fits()).toBe(1);
    });

    it("fits again once a web font arrived, however late", async () => {
      const p = loading();
      const before = p.size();
      p.loaded();
      expect(p.fits()).toBe(1);
      // The font is in: the same text now runs longer.
      p.faces[0]!.status = "loaded";
      p.lines.count = 12;
      await p.fontsReady();
      expect(p.fits()).toBe(2);
      expect(p.size()).toBeLessThan(before);
      expect(12 * p.size()).toBeLessThanOrEqual(201);
    });

    it("fits again after an image or a style sheet arrived, or failed to", async () => {
      const p = loading();
      await p.fontsReady();
      // Their events do not bubble.
      p.doc.getElementById("picture")!.dispatchEvent(new p.window.Event("load"));
      p.loaded();
      expect(p.fits()).toBe(2);
      p.loaded();
      expect(p.fits()).toBe(2);
      p.doc.getElementById("picture")!.dispatchEvent(new p.window.Event("error"));
      p.loaded();
      expect(p.fits()).toBe(3);
    });

    it("fits again whenever something may have arrived, where the browser does not say which fonts loaded", () => {
      const p = loading({ fonts: false });
      p.loaded();
      expect(p.fits()).toBe(2);
    });
  });
});

describe("player: without JavaScript", () => {
  const CSS = readFileSync("src-tauri/assets/runtime.css", "utf8");
  // Chat apps on iOS open decks in Quick Look, which renders HTML but runs no scripts.
  function styled(flagged: boolean) {
    const html = DECK.replace(
      "<html>",
      `<html${flagged ? " data-slop-player" : ""}><head><style>${CSS}</style></head>`,
    ).replace('<section class="slide"><p>No id</p>', '<section class="slide" data-hidden><p class="reveal">No id</p>');
    const window = openDeck(html, { visual: true });
    const doc = window.document;
    const style = (selector: string) => window.getComputedStyle(doc.querySelector(selector)!);
    return { doc, style };
  }

  it("is switched on by the player", () => {
    expect(player().doc.documentElement.hasAttribute("data-slop-player")).toBe(true);
  });

  it("lists every shown slide, in the flow, when no script flags the player", () => {
    const { style } = styled(false);
    expect(style("#intro").visibility).toBe("visible");
    expect(style("#intro").opacity).toBe("1");
    expect(style("#intro").position).toBe("relative");
    expect(style("#end").visibility).toBe("visible");
    expect(style("[data-hidden]").display).toBe("none");
    expect(style("body").overflow).not.toBe("hidden");
  });

  it("keeps slides visible and the page scrolling despite the deck's own styles", () => {
    const deckStyles =
      "<style>html, body { height: 100%; overflow: hidden } .slide { opacity: 0; visibility: hidden } .reveal { opacity: 0 }</style>";
    const html = DECK.replace("<html>", `<html><head><style>${CSS}</style>${deckStyles}</head>`).replace(
      "<p>No id</p>",
      '<p class="reveal">No id</p>',
    );
    const window = openDeck(html, { visual: true });
    const style = (selector: string) => window.getComputedStyle(window.document.querySelector(selector)!);
    expect(style("#intro").visibility).toBe("visible");
    expect(style("#intro").opacity).toBe("1");
    expect(style(".reveal").opacity).toBe("1");
    expect(style("body").overflow).toBe("visible");
    expect(style("html").overflow).toBe("visible");
  });

  it("hides all but the active slide once the player is flagged", () => {
    const { doc, style } = styled(true);
    expect(style("#intro").visibility).toBe("hidden");
    expect(style("#intro").position).toBe("absolute");
    doc.getElementById("intro")!.classList.add("active");
    expect(style("#intro").visibility).toBe("visible");
    expect(style("[data-hidden] .reveal").opacity).toBe("0");
  });

  it("stops mobile browsers from enlarging slide text", () => {
    // iOS inflates small text on narrow screens, which overflows the zoomed slides.
    expect(CSS).toMatch(/html\s*\{[^}]*-webkit-text-size-adjust:\s*100%/);
    expect(CSS).toMatch(/html\s*\{[^}]*[^-]text-size-adjust:\s*100%/);
  });

  it("sizes the stage from the slide size variables the app sets", () => {
    // The app appends the size rules (--slop-w / --slop-h, the printed page, the zoom steps for
    // narrow windows) for the deck's slide size; see src-tauri/src/size.rs.
    expect(CSS).toMatch(/\.deck \{[^}]*width: var\(--slop-w, 1920px\)/);
    expect(CSS).toMatch(/\.deck > \.slide \{[^}]*height: var\(--slop-h, 1080px\) !important/);
    // The one zoom here is the overview's, which the player sets for the window.
    expect(CSS.match(/zoom:[^;]*;/g)).toEqual(["zoom: var(--slop-overview-zoom, 0.2);"]);
    expect(CSS).not.toContain("@page");
  });
});

describe("player: shared heroes", () => {
  const html = DECK.replace("<button>", '<img data-morph="hero"><button>').replace(
    "<p>No id</p>",
    '<img data-morph="hero"><p>No id</p>',
  );
  function setup(window: DOMWindow) {
    Object.assign(window.document, {
      startViewTransition: vi.fn((update: () => void) => {
        update();
        return { ready: Promise.resolve(), finished: Promise.resolve(), skipTransition: vi.fn() };
      }),
    });
  }
  it("matches heroes forward and backward and cleans up snapshot names", async () => {
    const p = player({ html, setup });
    const start = p.doc.startViewTransition;
    expect(start).not.toHaveBeenCalled();
    p.key("ArrowRight");
    expect(start).toHaveBeenCalledOnce();
    expect(p.active()).toBe(1);
    expect(p.doc.querySelector<HTMLElement>(".active img")!.style.viewTransitionName).toBe("slop-hero");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.doc.querySelector<HTMLElement>(".active img")!.style.viewTransitionName).toBe("");
    p.key("ArrowLeft");
    expect(start).toHaveBeenCalledTimes(2);
    expect(p.active()).toBe(0);
  });
  it("falls back without browser support and does not morph editor previews", () => {
    const p = player({ html });
    p.key("ArrowRight");
    expect(p.active()).toBe(1);
    const embedded = player({ html, setup, at: "?embed&slide=2" });
    expect(embedded.doc.startViewTransition).not.toHaveBeenCalled();
  });
  it("respects reduced motion and static rendering", () => {
    const p = player({
      html,
      setup: (w) => {
        setup(w);
        Object.assign(w, { matchMedia: () => ({ matches: true }) });
      },
    });
    p.key("ArrowRight");
    expect(p.active()).toBe(1);
    expect(p.doc.startViewTransition).not.toHaveBeenCalled();
    const still = player({ html, setup, at: "?static" });
    still.key("ArrowRight");
    expect(still.doc.startViewTransition).not.toHaveBeenCalled();
  });
});

/**
 * A preview is served its deck cut down to the one slide it shows (src-tauri/src/html/single.rs,
 * mirrored by `singleSlide`): the other slides are empty stand-ins. The player must find the same
 * slide in it, at the same place among as many slides, as in the whole deck.
 */
describe("player: a preview's deck cut down to one slide", () => {
  const places = (p: ReturnType<typeof player>) => {
    const slides = [...p.doc.querySelectorAll<HTMLElement>(".deck > .slide")];
    return {
      count: slides.length,
      active: p.active(),
      activeCount: p.activeCount(),
      ids: slides.map((slide) => slide.id),
      // What CSS counts by: each slide's place among the deck's children.
      nth: slides.map((slide) => [...slide.parentElement!.children].indexOf(slide)),
      whole: slides.flatMap((slide, index) => (slide.childElementCount > 0 ? [index] : [])),
    };
  };

  it("shows the same slide, in the same place, as the whole deck does", () => {
    for (const reference of ["intro", "plan", "end", "#1", "#2", "#3", "#4", "#99", "#0", "unknown", ""]) {
      const at = `?embed&slide=${encodeURIComponent(reference)}&static`;
      const whole = places(player({ html: SINGLE_DECK, at }));
      const single = places(player({ html: singleSlide(SINGLE_DECK, reference), at }));
      expect(single.count, reference).toBe(4);
      expect(single.active, reference).toBe(whole.active);
      expect(single.activeCount, reference).toBe(1);
      expect(single.ids, reference).toEqual(whole.ids);
      expect(single.nth, reference).toEqual(whole.nth);
      expect(single.whole, reference).toEqual([whole.active]);
    }
  });

  it("finds a slide without an id by its position in the page the app serves", () => {
    // The page exactly as the backend cuts it (the Rust tests hold it to this file).
    const p = player({ html: SINGLE_SECOND, at: "?embed&slide=%232&static" });
    const shown = p.doc.querySelector<HTMLElement>(".deck > .slide.active")!;
    expect(p.active()).toBe(1);
    expect(shown.querySelector("img")?.getAttribute("src")).toBe("assets/second.png");
    expect(shown.hasAttribute("data-hidden")).toBe(true);
    expect(p.doc.querySelectorAll(".deck > .slide")).toHaveLength(4);
    expect(p.doc.querySelectorAll(".deck > .slide img, .deck > .slide video")).toHaveLength(1);
  });

  it("leaves nothing of the other slides for the page to load", () => {
    const p = player({ html: singleSlide(SINGLE_DECK, "plan"), at: "?embed&slide=plan&static" });
    const loads = [...p.doc.querySelectorAll("[src]")].map((el) => el.getAttribute("src"));
    expect(loads).toEqual(["assets/plan.mp4"]);
    // The editor's page, which keeps the other slides' ids, loads nothing more and shows the same.
    const edited = player({ html: singleSlide(SINGLE_DECK, "plan", true), at: "?embed&slide=plan&static&edit=0" });
    expect([...edited.doc.querySelectorAll("[src]")].map((el) => el.getAttribute("src"))).toEqual(loads);
    expect(places(edited).active).toBe(2);
    expect(edited.doc.getElementById("el-1")?.closest(".slide")?.id).toBe("intro");
    const slides = [...p.doc.querySelectorAll<HTMLElement>(".deck > .slide")];
    const styled = slides.map((slide) => slide.getAttribute("style"));
    expect(styled).toEqual([null, null, "color: red", null]);
  });
});

describe("player: the number being typed", () => {
  const count = (p: ReturnType<typeof player>) => p.doc.querySelector(".slop-controls-count")!.textContent;
  const shown = (p: ReturnType<typeof player>) => p.doc.documentElement.hasAttribute("data-slop-controls");

  it("shows in the strip, which comes into sight for it, until it is used or forgotten", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = player();
    p.key("1");
    p.key("2");
    expect(count(p)).toBe("→ 12");
    expect(shown(p)).toBe(true);
    p.key("Enter");
    expect(count(p)).toBe("3 / 3");
    p.key("2");
    expect(count(p)).toBe("→ 2");
    vi.advanceTimersByTime(3000);
    expect(count(p)).toBe("3 / 3");
  });

  it("is corrected with Backspace and given up with Escape, moving nowhere", () => {
    const p = player({ at: "#2" });
    p.key("3");
    p.key("1");
    expect(p.key("Backspace").defaultPrevented).toBe(true);
    expect(count(p)).toBe("→ 3");
    p.key("Backspace");
    expect(count(p)).toBe("2 / 3");
    expect(p.active()).toBe(1);
    // Nothing typed: Backspace is the previous slide again.
    p.key("Backspace");
    expect(p.active()).toBe(0);
    p.key("3");
    expect(p.key("Escape").defaultPrevented).toBe(true);
    p.key("Enter");
    expect(p.active()).toBe(1);
  });

  it("is told to the app's show, and says whether a 0 would be one of its digits", () => {
    const parent = { postMessage: vi.fn() };
    const p = player({ parent });
    const typing = () => (p.window as unknown as { slopPlayer: { typing: () => boolean } }).slopPlayer.typing();
    expect(typing()).toBe(false);
    p.key("1");
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: "slop:typed", typed: "1" }, "*");
    expect(typing()).toBe(true);
    p.key("0");
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: "slop:typed", typed: "10" }, "*");
    p.key("Escape");
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: "slop:typed", typed: "" }, "*");
    expect(typing()).toBe(false);
  });

  it("counts every slide in the app's show, as its slide list does, a hidden one standing for the next shown", () => {
    const html = `<main class="deck">
      <section class="slide" id="a"></section>
      <section class="slide" id="b" data-hidden></section>
      <section class="slide" id="c"></section>
      <section class="slide" id="d"></section>
    </main>`;
    const id = (p: ReturnType<typeof player>) => p.doc.querySelector(".slide.active")?.id;
    const jump = (p: ReturnType<typeof player>, digits: string) => {
      for (const digit of digits) p.key(digit);
      p.key("Enter");
      return id(p);
    };
    const show = player({ html, parent: { postMessage: vi.fn() } });
    expect(jump(show, "4")).toBe("d");
    expect(jump(show, "2")).toBe("c");
    expect(jump(show, "1")).toBe("a");
    expect(jump(show, "99")).toBe("d");
    expect(jump(show, "0")).toBe("a");
    // A file of its own knows only the slides it shows.
    expect(jump(player({ html }), "2")).toBe("c");
  });
});

describe("player: what the app's show is told and asks for", () => {
  const messages = (parent: { postMessage: ReturnType<typeof vi.fn> }, type: string) =>
    parent.postMessage.mock.calls.map(([data]) => data as Record<string, unknown>).filter((d) => d.type === type);
  const send = (p: ReturnType<typeof player>, data: unknown) =>
    p.window.dispatchEvent(new p.window.MessageEvent("message", { data }));

  it("says when the screen is blanked and when the slide is back", () => {
    const parent = { postMessage: vi.fn() };
    const p = player({ parent });
    p.key("b");
    p.key("w");
    p.key("ArrowRight");
    expect(messages(parent, "slop:blank").map((d) => d.color)).toEqual(["black", "white", null]);
    expect(p.active()).toBe(0);
  });

  it("blanks the screen and brings the slide back when asked", () => {
    const parent = { postMessage: vi.fn() };
    const p = player({ parent });
    const blank = () => p.doc.documentElement.getAttribute("data-slop-blank");
    send(p, { type: "slop:blank", color: "black" });
    expect(blank()).toBe("black");
    send(p, { type: "slop:blank", color: "white" });
    expect(blank()).toBe("white");
    send(p, { type: "slop:blank", color: null });
    expect(blank()).toBeNull();
    send(p, { type: "slop:blank", color: "url(x)" });
    expect(blank()).toBeNull();
    // Not a file of its own.
    const alone = player();
    send(alone, { type: "slop:blank", color: "black" });
    expect(alone.doc.documentElement.hasAttribute("data-slop-blank")).toBe(false);
  });

  it("goes to the slide picked in the app's overview, bringing a blanked slide back", () => {
    const parent = { postMessage: vi.fn() };
    const p = player({ parent });
    p.key("b");
    send(p, { type: "slop:goto", id: "end" });
    expect(p.active()).toBe(2);
    expect(p.doc.documentElement.hasAttribute("data-slop-blank")).toBe(false);
    send(p, { type: "slop:goto", id: "#2" });
    expect(p.active()).toBe(1);
  });

  it("ends on a dark screen after the last slide, and asks to end the show from there", () => {
    const parent = { postMessage: vi.fn() };
    const p = player({ at: "#end", parent });
    const ended = () => p.doc.documentElement.hasAttribute("data-slop-end");
    p.key("ArrowRight");
    expect(ended()).toBe(true);
    expect(p.active()).toBe(2);
    expect(messages(parent, "slop:end")).toEqual([{ type: "slop:end", ended: true }]);
    expect(messages(parent, "slop:exit")).toEqual([]);
    // Back shows the last slide again.
    p.key("ArrowLeft");
    expect(ended()).toBe(false);
    expect(p.active()).toBe(2);
    expect(messages(parent, "slop:end")).toHaveLength(2);
    // A click goes on like a key; going on from the end asks to end the show.
    p.click(p.doc.body, 1500);
    expect(ended()).toBe(true);
    p.key(" ");
    expect(messages(parent, "slop:exit")).toEqual([{ type: "slop:exit" }]);
    // Any slide asked for leaves the end.
    p.key("Home");
    expect(ended()).toBe(false);
    expect(p.active()).toBe(0);
    p.key("End");
    p.key("Enter");
    expect(ended()).toBe(true);
    send(p, { type: "slop:goto", id: "intro" });
    expect(ended()).toBe(false);
    expect(p.active()).toBe(0);
    const css = readFileSync("src-tauri/assets/runtime.css", "utf8");
    expect(css).toMatch(/html\[data-slop-end\] \.deck\s*\{[^}]*opacity:\s*0\s*!important/);
  });

  it("a file of its own has no end screen: it stays on its last slide", () => {
    const p = player({ at: "#end" });
    p.key("ArrowRight");
    p.click(p.doc.body, 1500);
    expect(p.doc.documentElement.hasAttribute("data-slop-end")).toBe(false);
    expect(p.active()).toBe(2);
  });

  it("hands a link out of the deck to the app instead of following it, and follows one within", () => {
    const html = DECK.replace(
      '<a href="#x">link</a>',
      '<a href="#x">link</a><a id="web" href="https://example.com/demo" target="_blank"><b>demo</b></a><a id="mail" href="mailto:a@example.com">mail</a>',
    );
    const parent = { postMessage: vi.fn() };
    const p = player({ html, at: "#end", parent });
    const press = (el: Element) => {
      const event = new p.window.MouseEvent("click", { bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(press(p.doc.querySelector("#web b")!)).toBe(true);
    expect(press(p.doc.querySelector("#mail")!)).toBe(true);
    expect(messages(parent, "slop:link").map((d) => d.href)).toEqual([
      "https://example.com/demo",
      "mailto:a@example.com",
    ]);
    expect(press(p.doc.querySelector('a[href="#x"]')!)).toBe(false);
    expect(messages(parent, "slop:link")).toHaveLength(2);
    expect(p.active()).toBe(2);
    // In a browser the link is the browser's.
    const alone = player({ html, at: "#end" });
    const event = new alone.window.MouseEvent("click", { bubbles: true, cancelable: true });
    alone.doc.querySelector("#web")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("player: playing by itself", () => {
  const TIMED = `<main class="deck">
    <section class="slide" id="a" data-duration="2"></section>
    <section class="slide" id="b"></section>
    <section class="slide" id="c" data-duration="1.5"></section>
  </main>`;
  const timed = (at: string) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    return player({ html: TIMED, at });
  };
  const button = (p: ReturnType<typeof player>, name: string) =>
    [...p.doc.querySelectorAll(".slop-controls button")].find((b) => b.getAttribute("aria-label")!.startsWith(name));

  it("?autoplay shows each slide for its own time, or five seconds, and stops after the last", () => {
    const p = timed("?autoplay");
    vi.advanceTimersByTime(1999);
    expect(p.active()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(p.active()).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(p.active()).toBe(2);
    expect(button(p, "Pause")).toBeTruthy();
    vi.advanceTimersByTime(60_000);
    expect(p.active()).toBe(2);
    expect(button(p, "Play")).toBeTruthy();
  });

  it("?autoplay=8 names the seconds of a slide without a time of its own", () => {
    const p = timed("?autoplay=8#b");
    vi.advanceTimersByTime(7999);
    expect(p.active()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(p.active()).toBe(2);
  });

  it("?loop starts over after the last slide, by itself or by hand", () => {
    const p = timed("?autoplay&loop#c");
    vi.advanceTimersByTime(1500);
    expect(p.active()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(p.active()).toBe(1);
    const byHand = player({ at: "?loop#end" });
    byHand.key("ArrowRight");
    expect(byHand.active()).toBe(0);
    byHand.key("End");
    byHand.click(byHand.doc.body, 1500);
    expect(byHand.active()).toBe(0);
  });

  it("gives a slide gone to by hand its whole time", () => {
    const p = timed("?autoplay");
    vi.advanceTimersByTime(1500);
    p.key("End");
    vi.advanceTimersByTime(1000);
    p.key("Home");
    vi.advanceTimersByTime(1999);
    expect(p.active()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(p.active()).toBe(1);
  });

  it("K and the strip's button pause and play; without ?autoplay there is no button until K", () => {
    const p = timed("");
    expect(button(p, "Play")).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(p.active()).toBe(0);
    expect(p.key("k").defaultPrevented).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(p.active()).toBe(1);
    (button(p, "Pause") as HTMLElement).click();
    vi.advanceTimersByTime(60_000);
    expect(p.active()).toBe(1);
    p.key("K");
    vi.advanceTimersByTime(5000);
    expect(p.active()).toBe(2);
  });

  it("holds the slide while the screen is blank", () => {
    const p = timed("?autoplay");
    p.key("b");
    vi.advanceTimersByTime(10_000);
    expect(p.active()).toBe(0);
    p.key("b");
    vi.advanceTimersByTime(2000);
    expect(p.active()).toBe(1);
  });

  it("is not for the app's show or a capture", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const framed = player({ html: TIMED, at: "?autoplay", parent: { postMessage: vi.fn() } });
    const still = player({ html: TIMED, at: "?autoplay&print" });
    vi.advanceTimersByTime(60_000);
    expect(framed.active()).toBe(0);
    expect(still.active()).toBe(0);
    expect(framed.key("k").defaultPrevented).toBe(false);
  });
});

describe("player: keeping the display awake", () => {
  function awake(at = "") {
    const release = vi.fn(async () => {});
    const request = vi.fn(async () => ({ release, addEventListener: vi.fn() }));
    let full: Element | null = null;
    const p = player({
      at,
      setup: (window) => {
        Object.defineProperty(window.navigator, "wakeLock", { value: { request }, configurable: true });
        Object.defineProperty(window.document, "fullscreenElement", { get: () => full, configurable: true });
      },
    });
    const fullscreen = (on: boolean) => {
      full = on ? p.doc.documentElement : null;
      p.doc.dispatchEvent(new p.window.Event("fullscreenchange"));
    };
    return { p, request, release, fullscreen };
  }

  it("asks for it in full screen and lets go of it after", async () => {
    const { request, release, fullscreen } = awake();
    expect(request).not.toHaveBeenCalled();
    fullscreen(true);
    expect(request).toHaveBeenCalledExactlyOnceWith("screen");
    fullscreen(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
  });

  it("asks for it while playing by itself", () => {
    const { p, request } = awake("?autoplay");
    expect(request).toHaveBeenCalledOnce();
    p.key("k");
    p.key("k");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does without where the browser has none, or refuses", () => {
    const p = player({ at: "?autoplay" });
    expect(p.active()).toBe(0);
    const refused = vi.fn(() => Promise.reject(new Error("no")));
    const q = player({
      at: "?autoplay",
      setup: (window) => Object.defineProperty(window.navigator, "wakeLock", { value: { request: refused } }),
    });
    expect(refused).toHaveBeenCalledOnce();
    expect(q.active()).toBe(0);
  });
});

describe("player: all slides at once", () => {
  const HIDDEN = DECK.replace('<section class="slide"><p>', '<section class="slide" data-hidden><p>');
  const open = (p: ReturnType<typeof player>) => p.doc.documentElement.hasAttribute("data-slop-overview");
  const picked = (p: ReturnType<typeof player>) => p.doc.querySelector("[data-slop-picked]")?.id;

  it("O opens it on the slide on screen and closes it again, as Escape does", () => {
    const p = player({ at: "#end" });
    expect(p.key("o").defaultPrevented).toBe(true);
    expect(open(p)).toBe(true);
    expect(picked(p)).toBe("end");
    expect(Number(p.doc.documentElement.style.getPropertyValue("--slop-overview-zoom"))).toBeGreaterThan(0);
    p.key("O");
    expect(open(p)).toBe(false);
    expect(picked(p)).toBeUndefined();
    p.key("o");
    p.key("Escape");
    expect(open(p)).toBe(false);
    expect(p.active()).toBe(2);
  });

  it("the arrows pick a slide and Enter goes to it; the keys move no slide meanwhile", () => {
    const p = player({ at: "#end" });
    p.key("o");
    p.key("ArrowLeft");
    p.key("ArrowLeft");
    p.key("ArrowLeft");
    expect(picked(p)).toBe("intro");
    expect(p.active()).toBe(2);
    p.key("End");
    expect(picked(p)).toBe("end");
    p.key("Home");
    p.key("b");
    expect(p.doc.documentElement.hasAttribute("data-slop-blank")).toBe(false);
    p.key("Enter");
    expect(open(p)).toBe(false);
    expect(p.active()).toBe(0);
  });

  it("a press on a slide goes to it, on whatever it lands; a press beside them closes it", () => {
    const p = player();
    p.key("o");
    const event = new p.window.MouseEvent("click", { bubbles: true, cancelable: true });
    p.doc.querySelector("#end a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(open(p)).toBe(false);
    expect(p.active()).toBe(2);
    p.key("o");
    p.click(p.doc.body, 10);
    expect(open(p)).toBe(false);
    expect(p.active()).toBe(2);
  });

  it("has a button in the strip, and lays the slides out by the stylesheet, the hidden ones left out", () => {
    const p = player({ html: HIDDEN });
    const button = [...p.doc.querySelectorAll<HTMLElement>(".slop-controls button")].find(
      (b) => b.getAttribute("aria-label") === "All slides (O)",
    )!;
    button.click();
    expect(open(p)).toBe(true);
    button.click();
    expect(open(p)).toBe(false);
    const css = readFileSync("src-tauri/assets/runtime.css", "utf8");
    expect(css).toMatch(/html\[data-slop-overview\] \.deck\s*\{[^}]*transform:\s*none\s*!important/);
    expect(css).toMatch(/html\[data-slop-overview\] \.deck > \.slide\s*\{[^}]*visibility:\s*visible\s*!important/);
    expect(css).toMatch(/html\[data-slop-overview\] \.deck > \.slide\[data-hidden\]\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/html\[data-slop-overview\] \.slide \.reveal\s*\{[^}]*animation:\s*none\s*!important/);
  });

  it("is closed for printing, and is not there in the app's show", () => {
    const p = player();
    p.key("o");
    p.window.dispatchEvent(new p.window.Event("beforeprint"));
    expect(open(p)).toBe(false);
    const framed = player({ parent: { postMessage: vi.fn() } });
    expect(framed.key("o").defaultPrevented).toBe(false);
    expect(open(framed)).toBe(false);
  });
});

describe("player: the list of keys", () => {
  const open = (p: ReturnType<typeof player>) => p.doc.documentElement.hasAttribute("data-slop-help");
  const panel = (p: ReturnType<typeof player>) => p.doc.querySelector<HTMLElement>(".slop-help");

  it("? lists the keys in a dialog, and ? or Escape closes it", () => {
    const p = player();
    expect(panel(p)).toBeNull();
    expect(p.key("?").defaultPrevented).toBe(true);
    expect(open(p)).toBe(true);
    expect(panel(p)!.getAttribute("role")).toBe("dialog");
    const text = panel(p)!.textContent!;
    for (const said of ["Next slide", "Previous slide", "Go to that slide", "All slides", "Black / white screen"]) {
      expect(text).toContain(said);
    }
    expect(text).toContain("?autoplay");
    expect(text).toContain("?loop");
    expect(p.doc.activeElement).toBe(panel(p));
    p.key("?");
    expect(open(p)).toBe(false);
    p.key("?");
    p.key("Escape");
    expect(open(p)).toBe(false);
    expect(p.doc.querySelectorAll(".slop-help")).toHaveLength(1);
  });

  it("lists full screen only where the browser has it", () => {
    const without = player();
    without.key("?");
    expect([...panel(without)!.querySelectorAll("dt")].map((dt) => dt.textContent)).not.toContain("F");
    const withIt = player({
      setup: (window) => {
        window.document.documentElement.requestFullscreen = vi.fn();
      },
    });
    withIt.key("?");
    expect([...panel(withIt)!.querySelectorAll("dt")].map((dt) => dt.textContent)).toContain("F");
  });

  it("any other key closes it and does what it does; a press beside it only closes it", () => {
    const p = player();
    p.key("?");
    p.key("ArrowRight");
    expect(open(p)).toBe(false);
    expect(p.active()).toBe(1);
    p.key("?");
    p.click(p.doc.body, 1500);
    expect(open(p)).toBe(false);
    expect(p.active()).toBe(1);
  });

  it("has a button in the strip, and offers to print", () => {
    const p = player();
    const print = vi.fn();
    p.window.print = print;
    [...p.doc.querySelectorAll<HTMLElement>(".slop-controls button")]
      .find((b) => b.getAttribute("aria-label") === "Keys (?)")!
      .click();
    expect(open(p)).toBe(true);
    const buttons = [...panel(p)!.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Print or save as PDF", "Close"]);
    buttons[0]!.click();
    expect(print).toHaveBeenCalledOnce();
    expect(open(p)).toBe(false);
  });

  it("is the app's own in its show", () => {
    const p = player({ parent: { postMessage: vi.fn() } });
    expect(p.key("?").defaultPrevented).toBe(false);
    expect(panel(p)).toBeNull();
  });
});

describe("player: for a screen reader", () => {
  const TITLED = `<!DOCTYPE html><html><head><title>Roadmap</title></head><body><main class="deck">
    <section class="slide" id="a"><h1>Where we  are</h1></section>
    <section class="slide" id="b" aria-label="Numbers"><p>No heading</p></section>
    <section class="slide" id="c"><h2>Next steps</h2></section>
  </main></body></html>`;

  it("says each slide as it shows, politely", () => {
    const p = player({ html: TITLED });
    const live = p.doc.querySelector(".slop-live")!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("Slide 1 of 3: Where we are");
    p.key("ArrowRight");
    expect(live.textContent).toBe("Slide 2 of 3");
    p.key("ArrowRight");
    expect(live.textContent).toBe("Slide 3 of 3: Next steps");
    const css = readFileSync("src-tauri/assets/runtime.css", "utf8");
    expect(css).toMatch(/\.slop-live\s*\{[^}]*clip-path:\s*inset\(50%\)/);
  });

  it("names the slide in the page's title, before the deck's", () => {
    const p = player({ html: TITLED });
    expect(p.doc.title).toBe("Where we are · Roadmap");
    p.key("ArrowRight");
    expect(p.doc.title).toBe("Slide 2 · Roadmap");
    const untitled = player();
    expect(untitled.doc.title).toBe("Slide 1 of 3");
  });

  it("marks each slide as one, under its number and heading, keeping a label the deck gave it", () => {
    const p = player({ html: TITLED });
    const slides = [...p.doc.querySelectorAll(".slide")];
    expect(slides.map((s) => s.getAttribute("role"))).toEqual(["group", "group", "group"]);
    expect(slides.map((s) => s.getAttribute("aria-roledescription"))).toEqual(["slide", "slide", "slide"]);
    expect(slides.map((s) => s.getAttribute("aria-label"))).toEqual([
      "Slide 1 of 3: Where we are",
      "Numbers",
      "Slide 3 of 3: Next steps",
    ]);
  });

  it("marks nothing where the page may be saved or is only captured", () => {
    for (const at of ["?embed&slide=a", "?static&print"]) {
      const p = player({ html: TITLED, at, parent: at.includes("embed") ? { postMessage: vi.fn() } : undefined });
      expect(p.doc.querySelector(".slide[role]"), at).toBeNull();
      expect(p.doc.querySelector(".slop-live"), at).toBeNull();
      expect(p.doc.title).toBe("Roadmap");
    }
  });
});

describe("player: on a phone held upright", () => {
  const upright = (matches: boolean) => (window: DOMWindow) => {
    window.matchMedia = ((query: string) => ({
      matches: matches && query.includes("orientation: portrait"),
    })) as unknown as typeof window.matchMedia;
  };
  const hint = (p: ReturnType<typeof player>) => p.doc.querySelector(".slop-hint");

  it("says for a moment that sideways shows more", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = player({ setup: upright(true), size: [390, 844] });
    expect(hint(p)!.textContent).toBe("Turn your phone sideways for a larger view");
    vi.advanceTimersByTime(6000);
    expect(hint(p)).toBeNull();
  });

  it("stops saying so once the phone is turned", () => {
    const p = player({ setup: upright(true), size: [390, 844] });
    p.window.dispatchEvent(new p.window.Event("resize"));
    expect(hint(p)).toBeNull();
  });

  it("says nothing on a desk, nor for a deck that is upright itself", () => {
    expect(hint(player({ setup: upright(false) }))).toBeNull();
    expect(hint(player({ setup: upright(true), stage: [1080, 1920] }))).toBeNull();
  });
});
