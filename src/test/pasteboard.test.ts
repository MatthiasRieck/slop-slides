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

function pasteboard({ framed = true, bodyStyle = "", show = false, stage }: { framed?: boolean; bodyStyle?: string; show?: boolean; stage?: [number, number] } = {}) {
  const posted: unknown[] = [];
  const parent = { postMessage: (data: unknown) => posted.push(data) };
  const dom = new JSDOM(DECK(bodyStyle), {
    url: show ? "https://example.test/deck.html?v=1&show#intro" : "https://example.test/deck.html?embed&slide=intro&pan",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "innerWidth", { value: 2560, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 1440, configurable: true });
      if (framed) Object.defineProperty(window, "parent", { value: parent, configurable: true });
    },
  });
  doms.push(dom);
  // The runtime CSS lays the stage out at the deck's slide size; jsdom lays nothing out.
  const stageEl = dom.window.document.querySelector(".deck");
  if (stage && stageEl) {
    Object.defineProperty(stageEl, "offsetWidth", { value: stage[0], configurable: true });
    Object.defineProperty(stageEl, "offsetHeight", { value: stage[1], configurable: true });
  }
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
    zooms: () => posted.filter((m) => (m as View).type === "slop:zoom") as View[],
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
    wheel: (init: WheelEventInit, timeStamp?: number) => {
      const event = new window.WheelEvent("wheel", { cancelable: true, bubbles: true, ...init });
      if (timeStamp !== undefined) Object.defineProperty(event, "timeStamp", { value: timeStamp });
      doc.body.dispatchEvent(event);
      return event;
    },
    click: (target: Element, x = 1500) =>
      target.dispatchEvent(new window.MouseEvent("click", { clientX: x, clientY: 100, bubbles: true, cancelable: true })),
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

  it("centers and frames a slide of another size", () => {
    const p = pasteboard({ stage: [1080, 1350] });
    // (2560 - 1080) / 2, and 1440 - 1350 leaves 45px above.
    expect(p.transform()).toBe("translate(740px,45px) scale(1)");
    const frame = p.$("[data-slop-frame]");
    expect(frame.style.cssText).toContain("width: 1080px");
    expect(frame.style.cssText).toContain("height: 1350px");
  });

  it("fits a slide of another size to the window in a show", () => {
    const p = pasteboard({ show: true, stage: [1080, 1080] });
    // A square slide in a 2560×1440 window: fit to the height, centered across.
    expect(p.transform()).toBe(`translate(560px,0px) scale(${4 / 3})`);
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

  it("zooms with the mouse wheel in view mode too, in Chromium and in WebKit", () => {
    const p = pasteboard();
    const notch = (deltaY: number, wheelDeltaY: number) => {
      const event = new p.window.WheelEvent("wheel", { deltaY, cancelable: true, bubbles: true });
      Object.defineProperty(event, "timeStamp", { value: (p.views().length + 1) * 1000 });
      Object.defineProperty(event, "wheelDeltaY", { value: wheelDeltaY });
      p.doc.body.dispatchEvent(event);
    };
    notch(-40, 120);
    expect(p.views().at(-1)!.k).toBeCloseTo(Math.exp(0.2), 5);
    notch(-4.000244140625, 12);
    // WebKit's notch is a fraction of a line; it zooms rather than panning.
    expect(p.views().at(-1)!.k).toBeCloseTo(Math.exp(0.2 + 4.000244140625 * 0.005), 5);
    expect(p.transform()).toContain(`scale(${p.views().at(-1)!.k})`);
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

  describe("in a show", () => {
    // The window is 2560×1440, so the player fits the slide at 4/3 scale, filling it.
    it("starts with the slide fit to the window, drawing nothing around it", () => {
      const p = pasteboard({ show: true, bodyStyle: "body { background: rgb(10, 20, 30) }" });
      expect(p.transform()).toBe(`translate(0px,0px) scale(${4 / 3})`);
      expect(p.doc.querySelector("[data-slop-frame]")).toBeNull();
      const css = [...p.doc.querySelectorAll("style")].map((s) => s.textContent).join("");
      expect(css).not.toContain("transparent");
      expect(p.$(".deck").style.backgroundColor).toBe("");
      expect(p.views()).toEqual([]);
    });

    it("zooms with the mouse wheel around the pointer and reports where ink belongs", () => {
      const p = pasteboard({ show: true });
      const event = new p.window.WheelEvent("wheel", { deltaY: -4.000244140625, clientX: 1000, clientY: 500, cancelable: true, bubbles: true });
      Object.defineProperty(event, "wheelDeltaY", { value: 12 });
      p.doc.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      const { x, y, k } = p.zooms().at(-1)!;
      expect(k).toBeCloseTo(Math.exp(4.000244140625 * 0.005), 5);
      // What lay under the pointer still does, so ink drawn there moves along with the slide.
      expect(x + 1000 * k).toBeCloseTo(1000, 5);
      expect(y + 500 * k).toBeCloseTo(500, 5);
    });

    it("zooms with a mouse notch and a pinch, pans with a swipe, and follows the window's size", () => {
      const p = pasteboard({ show: true });
      p.wheel({ ctrlKey: true, deltaY: -60, clientX: 0, clientY: 0 }, 1000);
      expect(p.zooms().at(-1)).toMatchObject({ x: 0, y: 0 });
      expect(p.zooms().at(-1)!.k).toBeCloseTo(Math.exp(0.3), 5);
      p.wheel({ deltaY: -3, deltaMode: 1, clientX: 0, clientY: 0 }, 2000);
      expect(p.zooms().at(-1)!.k).toBeGreaterThan(Math.exp(0.3));
      p.key("0");
      p.wheel({ deltaX: 30, deltaY: 100 }, 3000);
      expect(p.transform()).toBe(`translate(-30px,-100px) scale(${4 / 3})`);
      expect(p.zooms().at(-1)).toEqual({ type: "slop:zoom", x: -30, y: -100, k: 1 });
      Object.defineProperty(p.window, "innerWidth", { value: 1920, configurable: true });
      p.window.dispatchEvent(new p.window.Event("resize"));
      // Now letterboxed, 180px down, and still panned.
      expect(p.transform()).toBe("translate(-30px,80px) scale(1)");
    });

    it("leaves clicks and Space to the player, and pans with the middle button", () => {
      const p = pasteboard({ show: true });
      p.drag(p.$("h1"), 50, 0);
      expect(p.transform()).toBe(`translate(0px,0px) scale(${4 / 3})`);
      p.key(" ");
      expect(p.$("#outro").classList.contains("active")).toBe(true);
      expect(p.doc.documentElement.style.cursor).toBe("");
      p.drag(p.$("h1"), 50, 20, 1);
      expect(p.zooms().at(-1)).toEqual({ type: "slop:zoom", x: 50, y: 20, k: 1 });
    });

    it("fits each slide the show moves to, and when the app asks", async () => {
      const p = pasteboard({ show: true });
      p.wheel({ ctrlKey: true, deltaY: -60 }, 1000);
      p.fromParent({ type: "slop:camera", home: true });
      expect(p.transform()).toBe(`translate(0px,0px) scale(${4 / 3})`);
      p.wheel({ ctrlKey: true, deltaY: -60 }, 2000);
      p.click(p.doc.body);
      expect(p.$("#outro").classList.contains("active")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(p.transform()).toBe(`translate(0px,0px) scale(${4 / 3})`);
      expect(p.zooms().at(-1)).toEqual({ type: "slop:zoom", x: 0, y: 0, k: 1 });
    });
  });
});
