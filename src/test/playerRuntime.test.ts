/**
 * The player embedded in every deck.html (src-tauri/assets/runtime.js). It runs in the
 * editor's slide iframes, in the presenter, and in exported files opened in any browser.
 */
import { JSDOM, type DOMWindow } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import RUNTIME from "../../src-tauri/assets/runtime.js?raw";

const DECK = `<!DOCTYPE html><html><body>
<main class="deck">
  <section class="slide" id="intro"><button>Click me</button><section class="slide nested"></section></section>
  <section class="slide"><p>No id</p></section>
  <section class="slide" id="end"><a href="#x">link</a></section>
</main></body></html>`;

let doms: JSDOM[] = [];

afterEach(() => {
  doms.forEach((d) => d.window.close());
  doms = [];
});

interface PlayerOptions {
  /** Query string and hash, e.g. `?embed&slide=end` or `#2`. */
  at?: string;
  html?: string;
  /** Pretend to be inside an iframe; receives the player's postMessages. */
  parent?: { postMessage: (data: unknown, origin: string) => void };
  size?: [number, number];
}

function player({ at = "", html = DECK, parent, size = [1920, 1080] }: PlayerOptions = {}) {
  const dom = new JSDOM(html, {
    url: `https://example.test/deck.html${at}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "innerWidth", { value: size[0], configurable: true });
      Object.defineProperty(window, "innerHeight", { value: size[1], configurable: true });
      if (parent) Object.defineProperty(window, "parent", { value: parent, configurable: true });
    },
  });
  doms.push(dom);
  dom.window.eval(RUNTIME);
  const { window } = dom;
  const doc = window.document;
  const topSlides = () => [...doc.querySelectorAll<HTMLElement>(".deck > .slide")];
  return {
    window,
    doc,
    active: () => topSlides().findIndex((s) => s.classList.contains("active")),
    activeCount: () => doc.querySelectorAll(".slide.active").length,
    key: (key: string) => {
      const event = new window.KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
      window.dispatchEvent(event);
      return event;
    },
    click: (target: Element, clientX: number) =>
      target.dispatchEvent(new window.MouseEvent("click", { clientX, bubbles: true })),
  };
}

const hashOf = (window: DOMWindow) => window.location.hash;

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
    ["End", 2],
  ])("%j moves forward", (key, expected) => {
    const p = player();
    const event = p.key(key);
    expect(p.active()).toBe(expected);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([["ArrowLeft"], ["ArrowUp"], ["PageUp"]])("%j moves back", (key) => {
    const p = player({ at: "#end" });
    p.key(key);
    expect(p.active()).toBe(1);
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
    expect(p.active()).toBe(0);
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

  it("clicking the right of the slide advances, the left quarter goes back", () => {
    const p = player();
    const slide = p.doc.querySelector("#intro p, #intro") as Element;
    p.click(slide, 1500);
    expect(p.active()).toBe(1);
    p.click(p.doc.body, 100);
    expect(p.active()).toBe(0);
  });

  it("clicks on interactive elements do not navigate", () => {
    const p = player();
    p.click(p.doc.querySelector("button")!, 1500);
    expect(p.active()).toBe(0);
    p.key("End");
    p.click(p.doc.querySelector("a")!, 100);
    expect(p.active()).toBe(2);
  });

  it("swipes navigate", () => {
    const p = player();
    const touch = (type: string, clientX: number) => {
      const event = new p.window.Event(type, { bubbles: true }) as Event & Record<string, unknown>;
      event[type === "touchstart" ? "touches" : "changedTouches"] = [{ clientX }];
      p.doc.dispatchEvent(event);
    };
    touch("touchstart", 500);
    touch("touchend", 400);
    expect(p.active()).toBe(1);
    touch("touchstart", 400);
    touch("touchend", 480);
    expect(p.active()).toBe(0);
    touch("touchstart", 400);
    touch("touchend", 420);
    expect(p.active()).toBe(0); // short drags are not swipes
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
    expect(parent.postMessage).toHaveBeenCalledWith({ type: "slop:key", key: "ArrowRight" }, "*");
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
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: "slop:slide", id: "intro" }, "*");
    p.key("ArrowRight");
    expect(parent.postMessage).toHaveBeenCalledWith({ type: "slop:key", key: "ArrowRight" }, "*");
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: "slop:slide", id: null }, "*");
    expect(p.active()).toBe(1);
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
