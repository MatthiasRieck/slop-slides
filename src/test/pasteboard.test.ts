/**
 * The pasteboard (src-tauri/assets/pasteboard.js) that the backend adds to the stage's slide
 * preview, in view mode on its own and in edit mode under the slide editor. It runs after the
 * player, in the slide's iframe. How it pans and zooms with the editor on top is covered in
 * slideEditor.test.ts.
 */
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

import PASTEBOARD from "../../src-tauri/assets/pasteboard.js?raw";
import RUNTIME from "../../src-tauri/assets/runtime.js?raw";

const DECK = (bodyStyle = "") => `<!DOCTYPE html><html><head><style>${bodyStyle}</style></head><body>
<main class="deck">
  <section class="slide" id="intro"><h1>Hello</h1><a href="#x">Link</a></section>
  <section class="slide" id="outro"><p>Bye</p></section>
</main></body></html>`;

let doms: JSDOM[] = [];

afterEach(() => {
  doms.forEach((d) => d.window.close());
  doms = [];
});

interface View {
  type: string;
  slide: string;
  x: number;
  y: number;
  k: number;
}

function pasteboard({ framed = true, bodyStyle = "" } = {}) {
  const posted: unknown[] = [];
  const parent = { postMessage: (data: unknown) => posted.push(data) };
  const dom = new JSDOM(DECK(bodyStyle), {
    url: "https://example.test/deck.html?embed&slide=intro&pan",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "innerWidth", { value: 2560, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 1440, configurable: true });
      if (framed) Object.defineProperty(window, "parent", { value: parent, configurable: true });
    },
  });
  doms.push(dom);
  dom.window.eval(RUNTIME);
  dom.window.eval(PASTEBOARD);
  const { window } = dom;
  const doc = window.document;
  const $ = (selector: string) => doc.querySelector<HTMLElement>(selector)!;
  const pointer = (type: string, target: Element, x: number, y: number, button = 0) =>
    target.dispatchEvent(new window.PointerEvent(type, { clientX: x, clientY: y, button, bubbles: true, cancelable: true }));
  return {
    window,
    doc,
    $,
    transform: () => $(".deck").style.transform,
    views: () => posted.filter((m) => (m as View).type === "slop:view") as View[],
    keys: () => posted.filter((m) => (m as View).type === "slop:key"),
    drag(target: Element, dx: number, dy: number, button = 0) {
      pointer("pointerdown", target, 100, 100, button);
      pointer("pointermove", target, 100 + dx, 100 + dy, button);
      pointer("pointerup", target, 100 + dx, 100 + dy, button);
    },
    key: (key: string) => {
      const event = new window.KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
      doc.body.dispatchEvent(event);
      return event;
    },
    wheel: (init: WheelEventInit) => {
      const event = new window.WheelEvent("wheel", { cancelable: true, bubbles: true, ...init });
      doc.body.dispatchEvent(event);
      return event;
    },
    fromParent: (data: unknown) => {
      const event = new window.MessageEvent("message", { data });
      Object.defineProperty(event, "source", { value: parent });
      window.dispatchEvent(event);
    },
  };
}

describe("pasteboard", () => {
  it("does nothing outside the app's preview", () => {
    const p = pasteboard({ framed: false });
    expect(p.doc.querySelector("[data-slop-frame]")).toBeNull();
    expect(p.window.slopPasteboard).toBeUndefined();
  });

  it("centers the slide at full size, keeps it clipped, and frames it", () => {
    const p = pasteboard();
    expect(p.transform()).toBe("translate(320px,180px) scale(1)");
    const frame = p.$("[data-slop-frame]");
    expect(frame.style.cssText).toContain("left: 320px");
    expect(frame.style.cssText).toContain("width: 1920px");
    const css = [...p.doc.querySelectorAll("style")].map((s) => s.textContent).join("");
    expect(css).toMatch(/html, body \{ background: transparent !important/);
    expect(css).toMatch(/\[data-slop-frame\] \{[^}]*box-shadow:[^}]*outline: 1px solid var\(--slop-border/);
    // Only the editor lets the slide show what runs past its edge.
    expect(css).not.toContain("overflow: visible");
  });

  it("keeps the color the deck painted behind its slides, now that the page is transparent", () => {
    expect(pasteboard({ bodyStyle: "body { background: rgb(10, 20, 30) }" }).$(".deck").style.backgroundColor).toBe("rgb(10, 20, 30)");
    expect(pasteboard({ bodyStyle: ".deck { background: rgb(1, 2, 3) }" }).$(".deck").style.backgroundColor).toBe("");
  });

  it("pans by dragging the slide, and reports the view", () => {
    const p = pasteboard();
    p.drag(p.$("h1"), 50, -30);
    expect(p.transform()).toBe("translate(370px,150px) scale(1)");
    expect(p.views().at(-1)).toEqual({ type: "slop:view", slide: "intro", x: 50, y: -30, k: 1 });
    // A click that barely moves is not a pan.
    p.drag(p.$("h1"), 2, 1);
    expect(p.transform()).toBe("translate(370px,150px) scale(1)");
  });

  it("leaves links and other controls on the slide to be clicked", () => {
    const p = pasteboard();
    p.drag(p.$("a"), 50, 0);
    expect(p.transform()).toBe("translate(320px,180px) scale(1)");
    p.drag(p.$("a"), 50, 0, 1);
    expect(p.transform()).toBe("translate(370px,180px) scale(1)");
  });

  it("pans with a trackpad swipe and zooms with a pinch around the pointer", () => {
    const p = pasteboard();
    p.wheel({ deltaX: 30, deltaY: 100 });
    expect(p.views().at(-1)).toMatchObject({ x: -30, y: -100, k: 1 });
    p.fromParent({ type: "slop:camera", home: true });
    const event = p.wheel({ ctrlKey: true, deltaY: -60, clientX: 320, clientY: 180 });
    expect(event.defaultPrevented).toBe(true);
    const { x, y, k } = p.views().at(-1)!;
    expect(k).toBeCloseTo(Math.exp(0.3), 5);
    // The slide's corner under the pointer stays put.
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(0, 5);
    expect(p.$("[data-slop-frame]").style.cssText).toContain(`width: ${1920 * k}px`);
  });

  it("returns home with 0 and pans with Space held, keeping both keys from the app", () => {
    const p = pasteboard();
    p.drag(p.$("h1"), 50, 50);
    expect(p.key("0").defaultPrevented).toBe(true);
    expect(p.transform()).toBe("translate(320px,180px) scale(1)");
    p.key(" ");
    expect(p.doc.documentElement.style.cursor).toBe("grab");
    p.drag(p.$("a"), 20, 0);
    expect(p.transform()).toBe("translate(340px,180px) scale(1)");
    expect(p.keys()).toEqual([]);
    // Other keys still reach the app, for slide navigation.
    p.key("ArrowRight");
    expect(p.keys()).toEqual([expect.objectContaining({ type: "slop:key", key: "ArrowRight" })]);
  });

  it("restores the view and takes the app's colors", () => {
    const p = pasteboard();
    p.fromParent({ type: "slop:camera", x: -200, y: 50, k: 0.5 });
    expect(p.transform()).toBe("translate(120px,230px) scale(0.5)");
    p.fromParent({ type: "slop:camera", x: "a", y: 0, k: 1 });
    expect(p.transform()).toBe("translate(120px,230px) scale(0.5)");
    p.fromParent({ type: "slop:canvas", color: "rgb(1, 2, 3)", accent: "rgb(4, 5, 6)", border: "rgb(7, 8, 9)" });
    const style = p.doc.documentElement.style;
    expect([style.getPropertyValue("--slop-canvas"), style.getPropertyValue("--slop-accent"), style.getPropertyValue("--slop-border")]).toEqual([
      "rgb(1, 2, 3)",
      "rgb(4, 5, 6)",
      "rgb(7, 8, 9)",
    ]);
  });
});
