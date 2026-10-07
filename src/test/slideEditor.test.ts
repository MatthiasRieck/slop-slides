/**
 * The slide editor (src-tauri/assets/editor.js) that the backend adds to the stage's slide
 * preview in edit mode. It runs after the player and the pasteboard, in the slide's iframe.
 */
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import EDITOR from "../../src-tauri/assets/editor.js?raw";
import PASTEBOARD from "../../src-tauri/assets/pasteboard.js?raw";
import RUNTIME from "../../src-tauri/assets/runtime.js?raw";

const DECK = `<!DOCTYPE html><html><head></head><body>
<main class="deck">
  <section class="slide" id="intro">
    <h1 class="title">Hello <em>there</em></h1>
    <div class="card"><p>One</p><p style="color: red">Two</p></div>
    <svg viewBox="0 0 10 10"><circle r="1"></circle></svg>
    <div class="overlay"><span class="zone"></span></div>
    <div class="shape" style="background: rgb(10, 20, 30)"></div>
  </section>
  <section class="slide" id="outro"><p>Bye</p></section>
</main></body></html>`;

let doms: JSDOM[] = [];

afterEach(() => {
  doms.forEach((d) => d.window.close());
  doms = [];
  vi.useRealTimers();
});

interface Commit {
  type: string;
  slide: string;
  markup: string;
  select: number[] | null;
}

function editor({ slide = "intro", framed = true } = {}) {
  const posted: unknown[] = [];
  const parent = { postMessage: (data: unknown) => posted.push(data) };
  const dom = new JSDOM(DECK, {
    url: `https://example.test/deck.html?embed&slide=${slide}&static&edit=0`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "innerWidth", { value: 1920, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 1080, configurable: true });
      if (framed) Object.defineProperty(window, "parent", { value: parent, configurable: true });
    },
  });
  doms.push(dom);
  dom.window.eval(RUNTIME);
  dom.window.eval(PASTEBOARD);
  dom.window.eval(EDITOR);
  const { window } = dom;
  const doc = window.document;
  const $ = (selector: string) => doc.querySelector<HTMLElement>(selector)!;
  const pointer = (type: string, target: Element, x: number, y: number) =>
    target.dispatchEvent(
      new window.PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }),
    );
  return {
    window,
    doc,
    $,
    posted: () => posted,
    commits: () => posted.filter((m) => (m as Commit).type === "slop:edit-commit") as Commit[],
    keys: () => posted.filter((m) => (m as { type: string }).type === "slop:key"),
    down: (target: Element, x = 100, y = 100) => pointer("pointerdown", target, x, y),
    move: (target: Element, x: number, y: number) => pointer("pointermove", target, x, y),
    up: (target: Element, x = 100, y = 100) => pointer("pointerup", target, x, y),
    drag(target: Element, dx: number, dy: number) {
      this.down(target, 100, 100);
      this.move(target, 100 + dx, 100 + dy);
      this.up(target, 100 + dx, 100 + dy);
    },
    key: (key: string, init: KeyboardEventInit = {}) => {
      const event = new window.KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...init });
      (doc.activeElement ?? doc.body).dispatchEvent(event);
      return event;
    },
    fromParent: (data: unknown) => {
      const event = new window.MessageEvent("message", { data });
      Object.defineProperty(event, "source", { value: parent });
      window.dispatchEvent(event);
    },
    selected: () => [...doc.querySelectorAll("[data-slop-selected]")],
  };
}

describe("slide editor", () => {
  it("does nothing outside the app's preview", () => {
    const e = editor({ framed: false });
    e.down(e.$("h1"));
    expect(e.selected()).toEqual([]);
  });

  it("selects the element under the pointer, skipping inline text runs", () => {
    const e = editor();
    e.down(e.$("em"));
    expect(e.selected()).toEqual([e.$("h1")]);
    e.down(e.$(".card p"));
    expect(e.selected()).toEqual([e.$(".card p")]);
    e.down(e.$("circle"));
    expect(e.selected()).toEqual([e.$("svg")]);
    e.down(e.$("#intro"));
    expect(e.selected()).toEqual([]);
  });

  it("looks past elements that show nothing, like invisible hover zones", () => {
    const e = editor();
    e.down(e.$(".zone"));
    expect(e.selected()).toEqual([]);
    e.down(e.$(".shape"));
    expect(e.selected()).toEqual([e.$(".shape")]);
  });

  it("moves a dragged element with an inline translate and saves the slide", () => {
    const e = editor();
    const h1 = e.$("h1");
    e.drag(h1, 40, -12);
    expect(h1.style.translate).toBe("40px -12px");
    expect(h1.hasAttribute("data-moved")).toBe(true);
    const [commit] = e.commits();
    expect(commit).toMatchObject({ slide: "intro", select: [0] });
    expect(commit!.markup).toMatch(/^<section class="slide" id="intro">/);
    expect(commit!.markup).toContain(`<h1 class="title" style="translate: 40px -12px;" data-moved="">Hello`);
    expect(commit!.markup).not.toMatch(/active|data-slop|contenteditable/);
  });

  it("adds to an earlier offset, and clears it when moved back", () => {
    const e = editor();
    const p = e.$(".card p:nth-child(2)");
    e.drag(p, 10, 5);
    e.drag(p, 10, 5);
    expect(p.style.translate).toBe("20px 10px");
    e.drag(p, -20, -10);
    expect(p.hasAttribute("data-moved")).toBe(false);
    expect(p.getAttribute("style")).toBe("color: red;");
    expect(e.commits()).toHaveLength(3);
  });

  it("treats tiny pointer jitter as a click, not a move", () => {
    const e = editor();
    e.drag(e.$("h1"), 2, 1);
    expect(e.$("h1").hasAttribute("data-moved")).toBe(false);
    expect(e.commits()).toEqual([]);
  });

  it("nudges the selection with the arrow keys and saves once they settle", () => {
    vi.useFakeTimers();
    const e = editor();
    e.down(e.$("h1"));
    e.up(e.$("h1"));
    expect(e.key("ArrowRight").defaultPrevented).toBe(true);
    e.key("ArrowDown", { shiftKey: true });
    expect(e.$("h1").style.translate).toBe("1px 10px");
    expect(e.keys()).toEqual([]);
    expect(e.commits()).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(e.commits()).toHaveLength(1);
  });

  it("lets keys through to the app when nothing is selected", () => {
    const e = editor();
    e.key("ArrowRight");
    expect(e.keys()).toEqual([{ type: "slop:key", key: "ArrowRight", mod: false, shift: false }]);
  });

  it("saves a pending nudge before passing undo to the app", () => {
    vi.useFakeTimers();
    const e = editor();
    e.down(e.$("h1"));
    e.key("ArrowLeft");
    e.key("z", { metaKey: true });
    expect(e.commits()).toHaveLength(1);
    expect(e.keys()).toEqual([{ type: "slop:key", key: "z", mod: true, shift: false }]);
  });

  it("walks up to the parent with Escape", () => {
    const e = editor();
    e.down(e.$(".card p"));
    e.key("Escape");
    expect(e.selected()).toEqual([e.$(".card")]);
    e.key("Escape");
    expect(e.selected()).toEqual([]);
    expect(e.keys()).toEqual([]);
  });

  it("removes the selection with Delete", () => {
    const e = editor();
    e.down(e.$(".card p"));
    e.key("Delete");
    expect(e.doc.querySelectorAll(".card p")).toHaveLength(1);
    expect(e.commits()[0]!.markup).toContain(`<div class="card"><p style="color: red">Two</p></div>`);
  });

  it("edits text on double-click and saves it when done", () => {
    const e = editor();
    const p = e.$(".card p");
    e.down(p);
    e.up(p);
    e.down(p);
    expect(p.getAttribute("contenteditable")).toBe("true");
    // Typing goes to the text, not to the app or the editor's shortcuts.
    expect(e.key("ArrowLeft").defaultPrevented).toBe(false);
    expect(e.key("Backspace").defaultPrevented).toBe(false);
    expect(e.keys()).toEqual([]);
    expect(p.isConnected).toBe(true);
    p.textContent = "Uno";
    e.key("Enter");
    expect(p.hasAttribute("contenteditable")).toBe(false);
    const [commit] = e.commits();
    expect(commit!.markup).toContain(`<div class="card"><p>Uno</p>`);
    expect(commit!.markup).not.toMatch(/contenteditable|data-slop/);
  });

  it("keeps focus in the text it starts editing, and lets clicks through overlays while typing", () => {
    const e = editor();
    const p = e.$(".card p");
    e.down(p);
    e.up(p);
    const second = new e.window.PointerEvent("pointerdown", { clientX: 100, clientY: 100, button: 0, bubbles: true, cancelable: true });
    p.dispatchEvent(second);
    // The browser would otherwise move focus to whatever was clicked, like an invisible overlay.
    expect(second.defaultPrevented).toBe(true);
    expect(e.doc.activeElement).toBe(p);
    expect(e.$("#intro").hasAttribute("data-slop-typing")).toBe(true);
    expect(e.window.getComputedStyle(e.$(".overlay")).pointerEvents).toBe("none");
    expect(e.window.getComputedStyle(p).pointerEvents).toBe("auto");
    p.textContent = "Uno";
    e.key("Enter");
    expect(e.$("#intro").hasAttribute("data-slop-typing")).toBe(false);
    expect(e.commits()[0]!.markup).not.toMatch(/data-slop/);
  });

  it("starts editing with Enter and ends it by clicking elsewhere", () => {
    const e = editor();
    const h1 = e.$("h1");
    e.down(h1);
    e.key("Enter");
    expect(h1.getAttribute("contenteditable")).toBe("true");
    // Clicks inside the text being edited place the caret.
    e.down(e.$("em"));
    expect(h1.getAttribute("contenteditable")).toBe("true");
    e.down(e.$(".card"));
    expect(h1.hasAttribute("contenteditable")).toBe(false);
    expect(e.selected()).toEqual([e.$(".card")]);
    // Unchanged text is not saved.
    expect(e.commits()).toEqual([]);
  });

  it("does not edit elements without text", () => {
    const e = editor();
    e.down(e.$("svg"));
    e.key("Enter");
    expect(e.$("svg").hasAttribute("contenteditable")).toBe(false);
  });

  it("selects by path when the app asks, as after a reload", () => {
    const e = editor();
    e.fromParent({ type: "slop:edit-select", path: [1, 1] });
    expect(e.selected()).toEqual([e.$(".card p:nth-child(2)")]);
    e.fromParent({ type: "slop:edit-select", path: [9] });
    expect(e.selected()).toEqual([]);
    e.fromParent({ type: "slop:edit-select", path: [0] });
    e.fromParent({ type: "slop:edit-select", path: null });
    expect(e.selected()).toEqual([]);
  });

  it("only edits the slide being shown", () => {
    const e = editor({ slide: "outro" });
    e.down(e.$("h1"));
    expect(e.selected()).toEqual([]);
    e.drag(e.$("#outro p"), 30, 0);
    expect(e.commits()[0]).toMatchObject({ slide: "outro", select: [0] });
  });
  describe("scale and rotate handles", () => {
    /** Selects the heading, laid out as a 200×100 box centered at (500, 300). */
    function withHeading() {
      const e = editor();
      const h1 = e.$("h1");
      Object.defineProperty(h1, "offsetWidth", { value: 200, configurable: true });
      Object.defineProperty(h1, "offsetHeight", { value: 100, configurable: true });
      h1.getBoundingClientRect = () => new e.window.DOMRect(400, 250, 200, 100);
      e.down(h1);
      e.up(h1);
      const ui = e.$("[data-slop-ui]");
      /** "rotate", or a stretch handle by direction from the center, like "1 1" (bottom right). */
      const handle = (kind: string) =>
        ui.querySelector<HTMLElement>(kind === "rotate" ? `[data-handle="rotate"]` : `[data-dir="${kind}"]`)!;
      const pointer = (type: string, target: Element, x: number, y: number, init: PointerEventInit = {}) =>
        target.dispatchEvent(
          new e.window.PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, ...init }),
        );
      const pull = (kind: string, from: [number, number], to: [number, number], init: PointerEventInit = {}) => {
        pointer("pointerdown", handle(kind), ...from);
        pointer("pointermove", handle(kind), ...to, init);
        pointer("pointerup", handle(kind), ...to);
      };
      return { e, h1, ui, handle, pull };
    }

    it("shows handles around the selection, outside the slide", () => {
      const { e, ui, handle } = withHeading();
      expect(ui.style.display).toBe("");
      expect([ui.style.left, ui.style.top, ui.style.width, ui.style.height]).toEqual(["400px", "250px", "200px", "100px"]);
      expect(ui.querySelectorAll('[data-handle="scale"]')).toHaveLength(8);
      expect(ui.querySelectorAll("[data-axis]")).toHaveLength(4);
      expect(handle("rotate")).toBeTruthy();
      expect(e.$("#intro").contains(ui)).toBe(false);
      e.down(e.$("#intro"));
      expect(ui.style.display).toBe("none");
    });

    it("stretches from a corner while the opposite corner stays put", () => {
      const { e, h1, ui, pull } = withHeading();
      pull("1 1", [600, 350], [650, 400]);
      // 250×150 now; the top-left corner stays at (400, 250), so the center moves by (25, 25).
      expect(h1.style.scale).toBe("1.25 1.5");
      expect(h1.style.translate).toBe("25px 25px");
      expect(h1.hasAttribute("data-moved")).toBe(true);
      expect([ui.style.width, ui.style.height]).toEqual(["250px", "150px"]);
      expect(e.selected()).toEqual([h1]);
      const [commit] = e.commits();
      expect(commit!.markup).toContain(`style="scale: 1.25 1.5; translate: 25px 25px;" data-moved="">Hello`);
      expect(commit!.markup).not.toMatch(/data-slop/);
      expect(commit!.select).toEqual([0]);
      expect(e.commits()).toHaveLength(1);
    });

    it("stretches one axis from an edge, and from the top-left corner the other way", () => {
      const { e, h1, pull } = withHeading();
      pull("1 0", [600, 300], [650, 320]);
      expect([h1.style.scale, h1.style.translate]).toEqual(["1.25 1", "25px 0px"]);
      e.down(e.$("#intro"));
      e.down(h1);
      pull("-1 -1", [400, 250], [350, 200]);
      // Width 250 → 300 to the left, height 100 → 150 upwards: the bottom-right stays put.
      expect([h1.style.scale, h1.style.translate]).toEqual(["1.5", "0px -25px"]);
    });

    it("keeps the aspect ratio with Shift", () => {
      const { h1, pull } = withHeading();
      pull("1 1", [600, 350], [700, 360], { shiftKey: true });
      expect([h1.style.scale, h1.style.translate]).toEqual(["1.5", "50px 25px"]);
      // Back to the original width, and so to the original height: no inline scale left.
      pull("1 0", [600, 300], [500, 300], { shiftKey: true });
      expect(h1.style.scale).toBe("");
    });

    it("scales from the center with Alt", () => {
      const { h1, pull } = withHeading();
      pull("1 1", [600, 350], [650, 360], { altKey: true });
      expect(h1.style.scale).toBe("1.5 1.2");
      expect(h1.style.translate).toBe("");
      pull("1 0", [600, 300], [650, 300], { altKey: true, shiftKey: true });
      expect(h1.style.scale).toBe("2 1.6");
    });

    it("stretches along a turned element's own axes", () => {
      const { h1, pull } = withHeading();
      h1.style.rotate = "90deg";
      // Turned a quarter, the right edge faces down.
      pull("1 0", [500, 400], [500, 450]);
      expect([h1.style.scale, h1.style.translate]).toEqual(["1.25 1", "0px 25px"]);
    });

    it("never scales down to nothing", () => {
      const { h1, pull } = withHeading();
      pull("1 0", [600, 300], [300, 300]);
      expect(h1.style.scale).toBe("0.1 1");
    });

    it("rotates the selection around its center, snapping to 15° with Shift", () => {
      const { e, h1, ui, pull } = withHeading();
      pull("rotate", [500, 200], [600, 300]);
      expect(h1.style.rotate).toBe("90deg");
      expect(ui.style.transform).toBe("rotate(90deg)");
      // From straight up, a pointer at about 21° to the right snaps to 15°.
      pull("rotate", [500, 200], [538, 200], { shiftKey: true });
      expect(h1.style.rotate).toBe("105deg");
      expect(e.commits().map((c) => c.markup.match(/rotate: [^;]+/)?.[0])).toEqual(["rotate: 90deg", "rotate: 105deg"]);
    });

    it("drops the inline transform and the moved mark when turned or scaled back", () => {
      const { h1, pull } = withHeading();
      pull("rotate", [500, 200], [600, 300]);
      pull("rotate", [600, 300], [500, 200]);
      expect(h1.hasAttribute("style")).toBe(false);
      expect(h1.hasAttribute("data-moved")).toBe(false);
    });

    it("keeps the move and other styles when rotating", () => {
      const { e, h1, pull } = withHeading();
      e.down(e.$("#intro")); // so the drag is not a double-click
      e.drag(h1, 40, 0);
      pull("rotate", [500, 200], [600, 300]);
      expect(h1.getAttribute("style")).toBe("translate: 40px 0px; rotate: 90deg;");
    });

    it("resets rotation or scale when a handle is double-clicked", () => {
      const { e, h1, handle, pull } = withHeading();
      pull("1 1", [600, 350], [700, 400], { altKey: true });
      pull("rotate", [500, 200], [600, 300]);
      handle("rotate").dispatchEvent(new e.window.MouseEvent("dblclick", { bubbles: true }));
      expect(h1.getAttribute("style")).toBe("scale: 2;");
      handle("1 1").dispatchEvent(new e.window.MouseEvent("dblclick", { bubbles: true }));
      expect(h1.hasAttribute("style")).toBe(false);
      expect(h1.hasAttribute("data-moved")).toBe(false);
      expect(h1.hasAttribute("contenteditable")).toBe(false);
      expect(e.commits()).toHaveLength(4);
    });

    it("pressing a handle keeps the selection instead of picking what is under it", () => {
      const { e, h1, handle } = withHeading();
      handle("rotate").dispatchEvent(new e.window.PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }));
      expect(e.selected()).toEqual([h1]);
    });

    it("starts from a rotation the stylesheet already gives, and returns to it without inline styles", () => {
      const { e, h1, pull } = withHeading();
      const sheet = e.doc.createElement("style");
      sheet.textContent = ".title { rotate: 10deg; }";
      e.doc.head.appendChild(sheet);
      pull("rotate", [500, 200], [600, 300]);
      expect(h1.style.rotate).toBe("100deg");
      pull("rotate", [600, 300], [500, 200]);
      expect(h1.hasAttribute("style")).toBe(false);
      expect(h1.hasAttribute("data-moved")).toBe(false);
    });

    it("keeps the handles just outside the frame, so small text stays double-clickable", () => {
      const { e, h1, handle } = withHeading();
      const margin = (kind: string) => handle(kind).style.margin;
      expect(margin("-1 -1")).toBe("-18px 0px 0px -18px");
      expect(margin("1 1")).toBe("2px 0px 0px 2px");
      expect(margin("0 -1")).toBe("-18px 0px 0px -12px");
      expect(margin("1 0")).toBe("-12px 0px 0px 2px");
      // A double-click inside the selection edits its text.
      e.down(h1);
      expect(h1.getAttribute("contenteditable")).toBe("true");
    });

    it("hides edge handles on boxes too small on screen for them", () => {
      const { e, h1, ui } = withHeading();
      expect(ui.hasAttribute("data-narrow") || ui.hasAttribute("data-flat")).toBe(false);
      Object.defineProperty(h1, "offsetHeight", { value: 30, configurable: true });
      e.window.dispatchEvent(new e.window.Event("resize"));
      expect([ui.hasAttribute("data-narrow"), ui.hasAttribute("data-flat")]).toEqual([false, true]);
    });

    it("hides the handles while editing text", () => {
      const { e, ui } = withHeading();
      e.key("Enter");
      expect(ui.style.display).toBe("none");
      e.key("Escape");
      expect(ui.style.display).toBe("");
    });
  });

  describe("pasteboard around the slide", () => {
    const views = (e: ReturnType<typeof editor>) =>
      e.posted().filter((m) => (m as { type: string }).type === "slop:view") as { slide: string; x: number; y: number; k: number }[];
    // Wheel events carry their time so tests can say which belong to one gesture; by default
    // each call starts a new one.
    let clock = 0;
    const wheel = (e: ReturnType<typeof editor>, init: WheelEventInit, extra: { wheelDeltaY?: number; sameGesture?: boolean } = {}) => {
      clock += extra.sameGesture ? 16 : 1000;
      const event = new e.window.WheelEvent("wheel", { cancelable: true, bubbles: true, ...init });
      Object.defineProperty(event, "timeStamp", { value: clock });
      if (extra.wheelDeltaY !== undefined) Object.defineProperty(event, "wheelDeltaY", { value: extra.wheelDeltaY });
      e.doc.body.dispatchEvent(event);
      return event;
    };
    /** A mouse wheel turned by whole notches (up is negative), as WebKit and Chromium report it. */
    const notch = (e: ReturnType<typeof editor>, notches: number, at: { clientX?: number; clientY?: number } = {}) =>
      wheel(e, { deltaY: notches * 40, ...at }, { wheelDeltaY: -notches * 120 });
    const resize = (e: ReturnType<typeof editor>, width: number, height: number) => {
      Object.defineProperty(e.window, "innerWidth", { value: width, configurable: true });
      Object.defineProperty(e.window, "innerHeight", { value: height, configurable: true });
      e.window.dispatchEvent(new e.window.Event("resize"));
    };

    it("centers the slide at full size in a larger preview and stops it clipping", () => {
      const e = editor();
      const deck = e.$(".deck");
      expect(deck.style.transform).toBe("translate(0px,0px) scale(1)");
      resize(e, 2560, 1440);
      expect(deck.style.transform).toBe("translate(320px,180px) scale(1)");
      const frame = e.$("[data-slop-frame]");
      expect(frame.style.cssText).toContain("left: 320px");
      expect(frame.style.cssText).toContain("width: 1920px");
      const css = [...e.doc.querySelectorAll("style")].map((s) => s.textContent).join("");
      expect(css).toMatch(/\.deck, \.deck > \.slide\.active \{ overflow: visible !important/);
      expect(css).toMatch(/html, body \{ background: transparent !important/);
    });

    it("dims what lies outside the slide in the panel's color, and rings it in the app's accent", () => {
      const e = editor();
      e.fromParent({ type: "slop:canvas", color: "rgb(1, 2, 3)", accent: "rgb(4, 5, 6)" });
      expect(e.doc.documentElement.style.getPropertyValue("--slop-canvas")).toBe("rgb(1, 2, 3)");
      expect(e.doc.documentElement.style.getPropertyValue("--slop-accent")).toBe("rgb(4, 5, 6)");
      const css = [...e.doc.querySelectorAll("style")].map((s) => s.textContent).join("");
      expect(css).toMatch(/\[data-slop-frame\] \{ outline: 2px solid var\(--slop-accent[^}]*outline-offset: 4px[^}]*var\(--slop-canvas/);
      // One frame, which the pasteboard moves with the slide.
      expect(e.doc.querySelectorAll("[data-slop-frame]")).toHaveLength(1);
      e.fromParent({ type: "slop:camera", x: 30, y: 40, k: 0.5 });
      expect(e.$("[data-slop-frame]").style.cssText).toContain("left: 30px");
      expect(e.$("[data-slop-frame]").style.cssText).toContain("width: 960px");
    });

    it("does nothing without the pasteboard", () => {
      const dom = new JSDOM(DECK, { url: "https://example.test/deck.html?embed&slide=intro&static&edit=0", runScripts: "outside-only" });
      doms.push(dom);
      Object.defineProperty(dom.window, "parent", { value: { postMessage() {} }, configurable: true });
      dom.window.eval(RUNTIME);
      dom.window.eval(EDITOR);
      expect(dom.window.document.querySelector("[data-slop-ui]")).toBeNull();
    });

    it("lets an element that sits outside the slide be picked and dragged back in", () => {
      const e = editor();
      const h1 = e.$("h1");
      e.drag(h1, -300, 0);
      expect(h1.style.translate).toBe("-300px 0px");
      e.drag(h1, 300, 0);
      expect(h1.hasAttribute("data-moved")).toBe(false);
    });

    it("zooms with the mouse wheel around the pointer, keeping the slide's markup out of it", () => {
      const e = editor();
      const event = notch(e, -1, { clientX: 0, clientY: 0 });
      expect(event.defaultPrevented).toBe(true);
      expect(views(e).at(-1)!.k).toBeCloseTo(Math.exp(0.2), 5);
      // Zooming at the slide's corner leaves that corner where it was.
      expect(e.$(".deck").style.transform).toContain("translate(0px,0px)");
      notch(e, 1, { clientX: 0, clientY: 0 });
      expect(views(e).at(-1)!.k).toBeCloseTo(1, 5);
      expect(views(e).at(-1)!.x).toBeCloseTo(0, 5);
      expect(e.commits()).toEqual([]);
    });

    it("zooms with a line-based mouse wheel (Firefox)", () => {
      const e = editor();
      wheel(e, { deltaY: -3, deltaMode: 1 });
      expect(views(e).at(-1)!.k).toBeGreaterThan(1);
    });

    it("zooms with a mouse wheel in WebKit, which reports notches as fractions of a line", () => {
      const e = editor();
      // A slow notch is a tenth of a 40px line; a fast spin, several tenths.
      wheel(e, { deltaY: -4.000244140625, clientX: 0, clientY: 0 }, { wheelDeltaY: 12 });
      expect(views(e).at(-1)!.k).toBeCloseTo(Math.exp(4.000244140625 * 0.005), 5);
      wheel(e, { deltaY: 12.000732421875, clientX: 0, clientY: 0 }, { wheelDeltaY: -36 });
      expect(views(e).at(-1)!.k).toBeCloseTo(Math.exp(-8.00048828125 * 0.005), 5);
      expect(views(e).at(-1)!.x).toBeCloseTo(0, 5);
      expect(e.$(".deck").style.transform).toContain("translate(0px,0px)");
    });

    it("pans when swiping on a trackpad, without limit", () => {
      const e = editor();
      const event = wheel(e, { deltaX: 30, deltaY: 100 });
      expect(event.defaultPrevented).toBe(true);
      expect(e.$(".deck").style.transform).toBe("translate(-30px,-100px) scale(1)");
      expect(views(e).at(-1)).toEqual({ type: "slop:view", slide: "intro", x: -30, y: -100, k: 1 });
      // Purely vertical swipes pan too; Chromium reports their wheelDelta as 3× the pixels.
      wheel(e, { deltaY: 7 }, { wheelDeltaY: -21 });
      expect(e.$(".deck").style.transform).toBe("translate(-30px,-107px) scale(1)");
      for (let i = 0; i < 50; i++) wheel(e, { deltaY: -400 });
      expect(e.$(".deck").style.transform).toBe("translate(-30px,19893px) scale(1)");
      expect(e.commits()).toEqual([]);
    });

    it("keeps a trackpad swipe a pan even when one of its events looks like a mouse notch", () => {
      const e = editor();
      wheel(e, { deltaY: 5 }, { wheelDeltaY: -15 });
      wheel(e, { deltaY: 40 }, { wheelDeltaY: -120, sameGesture: true });
      expect(e.$(".deck").style.transform).toBe("translate(0px,-45px) scale(1)");
      // A new gesture is judged afresh.
      notch(e, -1);
      expect(views(e).at(-1)!.k).toBeCloseTo(Math.exp(0.2), 5);
    });

    it("zooms when pinching on a trackpad (Ctrl+wheel), or with ⌘/Ctrl+scroll", () => {
      const e = editor();
      wheel(e, { ctrlKey: true, deltaY: -60, clientX: 0, clientY: 0 });
      expect(views(e).at(-1)!.k).toBeCloseTo(Math.exp(0.3), 5);
      wheel(e, { metaKey: true, deltaY: 60, clientX: 0, clientY: 0 });
      expect(views(e).at(-1)!.k).toBeCloseTo(1, 5);
    });

    it("keeps the point under the pointer fixed while zooming", () => {
      const e = editor();
      notch(e, -1, { clientX: 1000, clientY: 500 });
      const { x, y, k } = views(e).at(-1)!;
      // The slide point that was under the pointer at 1000,500 still is.
      expect(x + 1000 * k).toBeCloseTo(1000, 5);
      expect(y + 500 * k).toBeCloseTo(500, 5);
    });

    it("limits how far it zooms", () => {
      const e = editor();
      for (let i = 0; i < 40; i++) notch(e, -2);
      expect(views(e).at(-1)!.k).toBe(8);
      for (let i = 0; i < 80; i++) notch(e, 2);
      expect(views(e).at(-1)!.k).toBe(0.1);
    });

    it("moves elements by slide pixels however far the view is zoomed", () => {
      const e = editor();
      const h1 = e.$("h1");
      e.$("#intro").getBoundingClientRect = () => ({ width: 960 }) as DOMRect;
      Object.defineProperty(e.$("#intro"), "offsetWidth", { value: 1920, configurable: true });
      e.drag(h1, 100, -50);
      expect(h1.style.translate).toBe("200px -100px");
    });

    it("pans by dragging empty space, and deselects", () => {
      const e = editor();
      e.down(e.$("h1"));
      e.up(e.$("h1"));
      expect(e.selected()).toHaveLength(1);
      e.down(e.doc.body, 10, 10);
      e.move(e.doc.body, 60, 40);
      expect(e.selected()).toEqual([]);
      expect(e.$(".deck").style.transform).toBe("translate(50px,30px) scale(1)");
      e.up(e.doc.body, 60, 40);
      e.move(e.doc.body, 200, 200);
      expect(e.$(".deck").style.transform).toBe("translate(50px,30px) scale(1)");
      expect(e.commits()).toEqual([]);
    });

    it("pans with the middle button or with Space held, without moving the element under the pointer", () => {
      const e = editor();
      const h1 = e.$("h1");
      h1.dispatchEvent(new e.window.PointerEvent("pointerdown", { clientX: 10, clientY: 10, button: 1, bubbles: true, cancelable: true }));
      e.move(h1, 30, 10);
      e.up(h1, 30, 10);
      expect(e.$(".deck").style.transform).toBe("translate(20px,0px) scale(1)");
      expect(h1.style.translate).toBe("");
      const space = e.key(" ");
      expect(space.defaultPrevented).toBe(true);
      expect(e.doc.documentElement.style.cursor).toBe("grab");
      e.down(h1, 0, 0);
      e.move(h1, 5, 5);
      e.up(h1, 5, 5);
      expect(e.$(".deck").style.transform).toBe("translate(25px,5px) scale(1)");
      expect(h1.style.translate).toBe("");
      e.doc.defaultView!.dispatchEvent(new e.window.KeyboardEvent("keyup", { key: " ", bubbles: true }));
      expect(e.doc.documentElement.style.cursor).toBe("");
    });

    it("pans with the middle button even while typing, and keeps the text being edited", () => {
      const e = editor();
      const h1 = e.$("h1");
      e.down(h1);
      e.up(h1);
      e.key("Enter");
      h1.dispatchEvent(new e.window.PointerEvent("pointerdown", { clientX: 0, clientY: 0, button: 1, bubbles: true, cancelable: true }));
      e.move(h1, 40, 20);
      e.up(h1, 40, 20);
      expect(e.$(".deck").style.transform).toBe("translate(40px,20px) scale(1)");
      expect(h1.getAttribute("contenteditable")).toBe("true");
      const click = new e.window.MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
      h1.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
    });

    it("does not treat Space or 0 as commands while typing", () => {
      const e = editor();
      const h1 = e.$("h1");
      e.down(h1);
      e.up(h1);
      e.key("Enter");
      expect(h1.getAttribute("contenteditable")).toBe("true");
      wheel(e, { deltaY: 50 });
      e.key("0");
      e.key(" ");
      expect(e.$(".deck").style.transform).toBe("translate(0px,-50px) scale(1)");
      expect(e.doc.documentElement.style.cursor).toBe("");
    });

    it("returns to the slide with 0 or when the app asks", () => {
      const e = editor();
      wheel(e, { deltaY: 100 });
      notch(e, -1);
      const zero = e.key("0");
      expect(zero.defaultPrevented).toBe(true);
      expect(e.$(".deck").style.transform).toBe("translate(0px,0px) scale(1)");
      expect(views(e).at(-1)).toEqual({ type: "slop:view", slide: "intro", x: 0, y: 0, k: 1 });
      wheel(e, { deltaX: 100 });
      e.fromParent({ type: "slop:camera", home: true });
      expect(e.$(".deck").style.transform).toBe("translate(0px,0px) scale(1)");
    });

    it("restores a view the app sends back after a reload, ignoring nonsense", () => {
      const e = editor();
      e.fromParent({ type: "slop:camera", x: -200, y: 50, k: 0.5 });
      expect(e.$(".deck").style.transform).toBe("translate(-200px,50px) scale(0.5)");
      expect(e.$("[data-slop-frame]").style.cssText).toContain("width: 960px");
      e.fromParent({ type: "slop:camera", x: "a", y: 0, k: 1 });
      expect(e.$(".deck").style.transform).toBe("translate(-200px,50px) scale(0.5)");
    });

    it("keeps the slide centered when the preview resizes, relative to the pan", () => {
      const e = editor();
      wheel(e, { deltaX: -40 });
      resize(e, 2560, 1440);
      expect(e.$(".deck").style.transform).toBe("translate(360px,180px) scale(1)");
    });

    it("reports overflow in slide pixels whatever the zoom", async () => {
      const e = editor();
      e.fromParent({ type: "slop:camera", x: 0, y: 0, k: 0.5 });
      e.$("#intro").getBoundingClientRect = () => ({ left: 0, top: 0, right: 960, bottom: 540, width: 960, height: 540 }) as DOMRect;
      Object.defineProperty(e.$("#intro"), "offsetWidth", { value: 1920, configurable: true });
      e.$("h1").getBoundingClientRect = () => ({ left: 50, top: 500, right: 300, bottom: 640, width: 250, height: 140 }) as DOMRect;
      e.key("Tab");
      await new Promise((resolve) => setTimeout(resolve, 40));
      const report = e.posted().filter((m) => (m as { type: string }).type === "slop:edit-overflow").at(-1) as { items: string[] };
      expect(report.items[0]).toContain("runs past the bottom edge by 200px");
    });
  });

  describe("overflow", () => {
    const rect = (left: number, top: number, right: number, bottom: number) =>
      ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
    const overflows = (e: ReturnType<typeof editor>) =>
      e.posted().filter((m) => (m as { type: string }).type === "slop:edit-overflow") as { slide: string; items: string[] }[];

    function laidOut(e: ReturnType<typeof editor>, boxes: Record<string, DOMRect>) {
      e.$("#intro").getBoundingClientRect = () => rect(0, 0, 1920, 1080);
      for (const [selector, box] of Object.entries(boxes)) e.$(selector).getBoundingClientRect = () => box;
    }

    it("reports nothing for a slide that fits", async () => {
      const e = editor();
      laidOut(e, { h1: rect(100, 100, 600, 200), ".card": rect(100, 300, 600, 500) });
      e.key("Tab");
      await frame();
      expect(overflows(e).at(-1)).toEqual({ type: "slop:edit-overflow", slide: "intro", items: [] });
      expect(e.doc.querySelector("[data-slop-overflow]")!.children).toHaveLength(0);
    });

    it("outlines text running past the slide's edge and reports it", async () => {
      const e = editor();
      laidOut(e, { h1: rect(100, 1000, 600, 1200) });
      e.down(e.$("h1"));
      await frame();
      const [report] = overflows(e).slice(-1);
      expect(report!.slide).toBe("intro");
      expect(report!.items).toEqual(['<h1> "Hello there" runs past the bottom edge by 120px']);
      const layer = e.doc.querySelector("[data-slop-overflow]")!;
      expect(layer.querySelectorAll("[data-wire]")).toHaveLength(1);
    });

    it("reports only the innermost element and only when the list changes", async () => {
      const e = editor();
      laidOut(e, { ".card": rect(100, 900, 600, 1300), ".card p": rect(100, 1000, 600, 1300) });
      e.down(e.$("h1"));
      await frame();
      const first = overflows(e);
      expect(first.at(-1)!.items).toEqual(['<p> "One" runs past the bottom edge by 220px']);
      e.down(e.$("h1"));
      await frame();
      expect(overflows(e)).toHaveLength(first.length);
    });

    it("ignores decoration that bleeds off the edge on purpose", async () => {
      const e = editor();
      laidOut(e, { ".shape": rect(1700, -200, 2300, 400), ".overlay": rect(0, 0, 3000, 1080) });
      e.$(".overlay").setAttribute("aria-hidden", "true");
      e.down(e.$("h1"));
      await frame();
      expect(overflows(e).at(-1)!.items).toEqual([]);
    });

    it("reports text cut off by its own box", async () => {
      const e = editor();
      laidOut(e, { h1: rect(100, 100, 600, 200) });
      const h1 = e.$("h1");
      h1.style.overflowX = "hidden";
      h1.style.overflowY = "hidden";
      Object.defineProperty(h1, "clientHeight", { value: 100, configurable: true });
      Object.defineProperty(h1, "scrollHeight", { value: 260, configurable: true });
      e.down(h1);
      await frame();
      expect(overflows(e).at(-1)!.items).toEqual(['<h1> "Hello there" is cut off by its own box']);
    });

    it("re-checks while typing, and hides the wires for a screenshot until the next click", async () => {
      const e = editor();
      laidOut(e, { h1: rect(100, 100, 600, 200) });
      e.down(e.$("h1"));
      await frame();
      expect(overflows(e).at(-1)!.items).toEqual([]);
      e.$("h1").getBoundingClientRect = () => rect(100, 100, 600, 1300);
      e.$("h1").dispatchEvent(new e.window.Event("input", { bubbles: true }));
      await frame();
      expect(overflows(e).at(-1)!.items).toHaveLength(1);
      e.fromParent({ type: "slop:edit-select", path: null, quiet: true });
      expect(e.doc.querySelector("[data-slop-overflow]")!.hasAttribute("data-quiet")).toBe(true);
      e.down(e.$("h1"));
      expect(e.doc.querySelector("[data-slop-overflow]")!.hasAttribute("data-quiet")).toBe(false);
    });
  });

  describe("toolbar tools", () => {
    const SHAPE_STYLE = { color: "#ffffff", fontSize: 40, align: "center", valign: "middle", fill: "#3b82f6", stroke: null, strokeWidth: 0 };
    const TEXT_STYLE = { color: "#111111", fontSize: 48, align: "left", valign: "top", fill: null, stroke: null, strokeWidth: 0 };
    const DRAW_STYLE = { fill: null, stroke: "#ef4444", strokeWidth: 6 };
    const at = (e: ReturnType<typeof editor>, type: string, x: number, y: number, init: PointerEventInit = {}) =>
      e.$("#intro").dispatchEvent(new e.window.PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, ...init }));
    const dragOut = (e: ReturnType<typeof editor>, from: [number, number], to: [number, number], init: PointerEventInit = {}) => {
      at(e, "pointerdown", ...from);
      at(e, "pointermove", ...to, init);
      at(e, "pointerup", ...to);
    };
    const toolTold = (e: ReturnType<typeof editor>) =>
      e.posted().filter((m) => (m as { type: string }).type === "slop:edit-tool") as { slide: string; tool: string }[];
    const reports = (e: ReturnType<typeof editor>) =>
      e.posted().filter((m) => (m as { type: string }).type === "slop:edit-selection") as { slide: string; selection: Record<string, unknown> | null }[];
    const added = (e: ReturnType<typeof editor>) => [...e.doc.querySelectorAll<HTMLElement>("#intro [data-added]")];

    it("drags out a shape with the app's style, then selects it and goes back to the select tool", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "rect", style: SHAPE_STYLE });
      expect(e.doc.documentElement.getAttribute("data-slop-tool")).toBe("rect");
      dragOut(e, [400, 300], [100, 100]);
      const [shape] = added(e);
      expect(shape!.getAttribute("data-added")).toBe("shape");
      expect(shape!.style).toMatchObject({ position: "absolute", left: "100px", top: "100px", width: "300px", height: "200px", borderRadius: "0px" });
      expect(shape!.style.display).toBe("flex");
      expect(shape!.style.justifyContent).toBe("center");
      expect(shape!.style.textAlign).toBe("center");
      expect(shape!.style.fontSize).toBe("40px");
      expect(e.selected()).toEqual([shape]);
      expect(e.doc.documentElement.hasAttribute("data-slop-tool")).toBe(false);
      expect(toolTold(e)).toEqual([{ type: "slop:edit-tool", slide: "intro", tool: "select" }]);
      const [commit] = e.commits();
      expect(commit!.select).toEqual([5]);
      expect(commit!.markup).toMatch(/<div data-added="shape" style="position: absolute; left: 100px; top: 100px; width: 300px; height: 200px;[^"]*background-color: #3b82f6;[^"]*"><\/div><\/section>$/);
      expect(commit!.markup).not.toMatch(/data-slop/);
    });

    it("adds a default-sized shape on a click, and keeps it even with Shift", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "ellipse", style: SHAPE_STYLE });
      dragOut(e, [50, 60], [50, 60]);
      expect(added(e)[0]!.style).toMatchObject({ left: "50px", top: "60px", width: "320px", height: "200px", borderRadius: "50%" });
      e.fromParent({ type: "slop:edit-tool", tool: "rounded", style: SHAPE_STYLE });
      dragOut(e, [100, 100], [300, 150], { shiftKey: true });
      expect(added(e)[1]!.style).toMatchObject({ width: "200px", height: "200px", borderRadius: "24px" });
    });

    it("adds a text box that starts out typing, and drops it if left empty", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "text", style: { ...TEXT_STYLE, bold: true } });
      dragOut(e, [200, 120], [200, 120]);
      const [box] = added(e);
      expect(box!.getAttribute("data-added")).toBe("text");
      expect(box!.textContent).toBe("Text");
      expect(box!.getAttribute("contenteditable")).toBe("true");
      expect(box!.style).toMatchObject({ left: "200px", top: "120px", fontSize: "48px", fontWeight: "700", justifyContent: "flex-start" });
      expect(box!.style.width).toBe("");
      expect(e.commits()).toEqual([]);
      box!.textContent = "Note to self";
      e.key("Enter");
      expect(e.commits()[0]!.markup).toContain(">Note to self</div></section>");
      // A dragged-out text box wraps at the width it was given; one left empty goes away unsaved.
      e.fromParent({ type: "slop:edit-tool", tool: "text", style: TEXT_STYLE });
      dragOut(e, [300, 400], [700, 420]);
      const wide = added(e)[1]!;
      expect(wide.style.width).toBe("400px");
      wide.textContent = "";
      e.key("Escape");
      expect(wide.isConnected).toBe(false);
      expect(e.selected()).toEqual([]);
      expect(e.commits()).toHaveLength(1);
    });

    it("types into a text box or shape already there with the text tool", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "rect", style: SHAPE_STYLE });
      dragOut(e, [100, 100], [400, 300]);
      const shape = added(e)[0]!;
      e.fromParent({ type: "slop:edit-tool", tool: "text", style: TEXT_STYLE });
      shape.dispatchEvent(new e.window.PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }));
      expect(shape.getAttribute("contenteditable")).toBe("true");
      expect(added(e)).toHaveLength(1);
      expect(toolTold(e).at(-1)!.tool).toBe("select");
      shape.textContent = "Inside";
      e.key("Enter");
      expect(e.commits().at(-1)!.markup).toContain(">Inside</div></section>");
      // An empty shape can be typed into too.
      const other = added(e)[0]!;
      other.textContent = "";
      e.down(other);
      e.key("Enter");
      expect(other.getAttribute("contenteditable")).toBe("true");
    });

    it("draws freehand, fitting the drawing's box around its line, and keeps drawing", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "draw", style: DRAW_STYLE });
      at(e, "pointerdown", 10, 20);
      at(e, "pointermove", 50, 40);
      at(e, "pointermove", 51, 40);
      at(e, "pointermove", 90, 20);
      at(e, "pointerup", 90, 20);
      const [svg] = added(e);
      expect(svg!.tagName.toLowerCase()).toBe("svg");
      expect(svg!.getAttribute("data-added")).toBe("drawing");
      expect(svg!.style).toMatchObject({ left: "7px", top: "17px", width: "86px", height: "26px" });
      expect(svg!.getAttribute("viewBox")).toBe("0 0 86 26");
      const path = svg!.querySelector("path")!;
      // Points closer than a couple of pixels are skipped.
      expect(path.getAttribute("d")).toBe("M3 3 L43 23 L83 3");
      expect(path.getAttribute("stroke")).toBe("#ef4444");
      expect(path.getAttribute("stroke-width")).toBe("6");
      expect(e.commits()[0]!.markup).toContain(`<path fill="none" stroke="#ef4444" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" d="M3 3 L43 23 L83 3"></path></svg></section>`);
      expect(e.selected()).toEqual([]);
      expect(e.doc.documentElement.getAttribute("data-slop-tool")).toBe("draw");
      // A tap draws a dot.
      at(e, "pointerdown", 200, 200);
      at(e, "pointerup", 200, 200);
      expect(added(e)[1]!.querySelector("path")!.getAttribute("d")).toBe("M3 3 L3 3");
    });

    it("puts the tool away with Escape, dropping a shape being dragged out", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "rect", style: SHAPE_STYLE });
      at(e, "pointerdown", 100, 100);
      at(e, "pointermove", 300, 300);
      expect(added(e)).toHaveLength(1);
      expect(e.key("Escape").defaultPrevented).toBe(true);
      expect(added(e)).toEqual([]);
      at(e, "pointerup", 300, 300);
      expect(e.commits()).toEqual([]);
      expect(e.keys()).toEqual([]);
      expect(toolTold(e)).toEqual([{ type: "slop:edit-tool", slide: "intro", tool: "select" }]);
      // The select tool selects again.
      e.down(e.$("h1"));
      expect(e.selected()).toEqual([e.$("h1")]);
    });

    it("does not select, hover or start typing while a tool is out", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "draw", style: DRAW_STYLE });
      e.move(e.$("h1"), 10, 10);
      expect(e.doc.querySelector("[data-slop-hover]")).toBeNull();
      e.$("h1").dispatchEvent(new e.window.MouseEvent("dblclick", { bubbles: true }));
      expect(e.$("h1").hasAttribute("contenteditable")).toBe(false);
      expect(e.selected()).toEqual([]);
    });

    it("selects added elements even when they show nothing", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "rect", style: { ...SHAPE_STYLE, fill: null } });
      dragOut(e, [100, 100], [400, 300]);
      const shape = added(e)[0]!;
      e.down(e.$("h1"));
      e.down(shape);
      expect(e.selected()).toEqual([shape]);
    });

    it("reports the selection for the toolbar", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "rect", style: { ...SHAPE_STYLE, stroke: "#ff0000", strokeWidth: 8, bold: true } });
      dragOut(e, [100, 100], [400, 300]);
      expect(reports(e).at(-1)).toEqual({
        type: "slop:edit-selection",
        slide: "intro",
        selection: {
          kind: "shape",
          text: true,
          vector: false,
          color: "#ffffff",
          fontSize: 40,
          bold: true,
          italic: false,
          align: "center",
          valign: "middle",
          fill: "#3b82f6",
          stroke: "#ff0000",
          strokeWidth: 8,
        },
      });
      e.down(e.$("svg"));
      expect(reports(e).at(-1)!.selection).toMatchObject({ kind: "media", text: false, vector: false, valign: null });
      e.down(e.$(".card p:nth-child(2)"));
      expect(reports(e).at(-1)!.selection).toMatchObject({ kind: "element", text: true, color: "#ff0000", fill: null, stroke: null, strokeWidth: 0 });
      e.down(e.$("#intro"));
      expect(reports(e).at(-1)!.selection).toBeNull();
    });

    it("restyles the selected text and saves it", () => {
      const e = editor();
      const h1 = e.$("h1");
      e.down(h1);
      e.fromParent({ type: "slop:edit-style", style: { color: "#ff0000", fontSize: 72, bold: true, italic: true, align: "center" } });
      expect(h1.style).toMatchObject({ fontSize: "72px", fontWeight: "700", fontStyle: "italic", textAlign: "center" });
      expect(h1.style.color).toMatch(/#ff0000|rgb\(255, 0, 0\)/);
      expect(e.commits()).toHaveLength(1);
      expect(reports(e).at(-1)!.selection).toMatchObject({ color: "#ff0000", fontSize: 72, bold: true, italic: true, align: "center" });
      // Text alignment is only vertical in a flex box.
      e.fromParent({ type: "slop:edit-style", style: { valign: "bottom" } });
      expect(h1.style.justifyContent).toBe("");
      expect(e.commits()).toHaveLength(1);
      e.fromParent({ type: "slop:edit-style", style: { bold: false, italic: false, color: null } });
      expect(h1.style).toMatchObject({ fontWeight: "400", fontStyle: "normal", color: "" });
    });

    it("aligns a shape's text vertically", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "rect", style: SHAPE_STYLE });
      dragOut(e, [100, 100], [400, 300]);
      e.fromParent({ type: "slop:edit-style", style: { valign: "bottom", align: "right" } });
      expect(added(e)[0]!.style).toMatchObject({ justifyContent: "flex-end", textAlign: "right" });
      expect(reports(e).at(-1)!.selection).toMatchObject({ valign: "bottom", align: "right" });
    });

    it("fills and borders boxes, turning a border on and off", () => {
      const e = editor();
      const card = e.$(".card");
      e.down(card);
      e.fromParent({ type: "slop:edit-style", style: { fill: "#00ff00" } });
      expect(reports(e).at(-1)!.selection).toMatchObject({ fill: "#00ff00" });
      // A border color alone gets a width, a width alone a color.
      e.fromParent({ type: "slop:edit-style", style: { stroke: "#0000ff" } });
      expect(reports(e).at(-1)!.selection).toMatchObject({ stroke: "#0000ff", strokeWidth: 4 });
      e.fromParent({ type: "slop:edit-style", style: { strokeWidth: 0 } });
      expect(card.style.borderStyle).toBe("none");
      expect(reports(e).at(-1)!.selection).toMatchObject({ stroke: null, strokeWidth: 0 });
      e.fromParent({ type: "slop:edit-style", style: { strokeWidth: 2 } });
      expect(reports(e).at(-1)!.selection).toMatchObject({ stroke: "#111111", strokeWidth: 2 });
      e.fromParent({ type: "slop:edit-style", style: { fill: null } });
      expect(reports(e).at(-1)!.selection).toMatchObject({ fill: null });
      expect(e.commits()).toHaveLength(5);
    });

    it("restyles a drawing's line", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "draw", style: DRAW_STYLE });
      dragOut(e, [10, 10], [80, 80]);
      e.fromParent({ type: "slop:edit-tool", tool: "select" });
      const svg = added(e)[0]!;
      e.down(svg);
      expect(reports(e).at(-1)!.selection).toMatchObject({ kind: "drawing", text: false, vector: true, stroke: "#ef4444", strokeWidth: 6, fill: null });
      e.fromParent({ type: "slop:edit-style", style: { stroke: "#00ff00", strokeWidth: 12, fill: "#0000ff" } });
      const path = svg.querySelector("path")!;
      expect([path.getAttribute("stroke"), path.getAttribute("stroke-width"), path.getAttribute("fill")]).toEqual(["#00ff00", "12", "#0000ff"]);
      expect(svg.hasAttribute("style") && svg.style.backgroundColor).toBe("");
    });

    describe("stretching what was added", () => {
      const pullRight = (e: ReturnType<typeof editor>, by: number) => {
        const handle = e.$(`[data-slop-ui] [data-dir="1 0"]`);
        const pointer = (type: string, x: number) =>
          handle.dispatchEvent(new e.window.PointerEvent(type, { clientX: x, clientY: 100, button: 0, bubbles: true, cancelable: true }));
        pointer("pointerdown", 100);
        pointer("pointermove", 100 + by);
        pointer("pointerup", 100 + by);
      };

      it("resizes a shape instead of scaling it, so its border keeps its width", () => {
        const e = editor();
        e.fromParent({ type: "slop:edit-tool", tool: "rect", style: { ...SHAPE_STYLE, stroke: "#ffffff", strokeWidth: 8 } });
        dragOut(e, [100, 100], [400, 300]);
        const shape = added(e)[0]!;
        pullRight(e, 100);
        // The left edge stays put.
        expect(shape.style).toMatchObject({ left: "100px", width: "400px", height: "200px", scale: "", translate: "" });
        expect(shape.hasAttribute("data-moved")).toBe(false);
        expect(e.commits().at(-1)!.markup).toContain("width: 400px; height: 200px;");
      });

      it("spreads a drawing's points instead of scaling it, so its line keeps its width", () => {
        const e = editor();
        e.fromParent({ type: "slop:edit-tool", tool: "draw", style: DRAW_STYLE });
        at(e, "pointerdown", 10, 20);
        at(e, "pointermove", 50, 40);
        at(e, "pointermove", 90, 20);
        at(e, "pointerup", 90, 20);
        e.fromParent({ type: "slop:edit-tool", tool: "select" });
        const svg = added(e)[0]!;
        e.down(svg);
        e.up(svg);
        pullRight(e, 80);
        expect(svg.style).toMatchObject({ left: "7px", width: "166px", height: "26px", scale: "", translate: "" });
        expect(svg.getAttribute("viewBox")).toBe("0 0 166 26");
        const path = svg.querySelector("path")!;
        // Around the line's half-width padding: 3 stays, the rest twice as far from it.
        expect(path.getAttribute("d")).toBe("M3 3 L83 23 L163 3");
        expect(path.getAttribute("stroke-width")).toBe("6");
      });

      it("spreads any path, relative steps and arcs included", () => {
        const e = editor();
        e.$("#intro").insertAdjacentHTML(
          "beforeend",
          `<svg data-added="drawing" viewBox="0 0 86 26" style="position: absolute; left: 0px; top: 0px; width: 86px; height: 26px">` +
            `<path d="m3 3 l40 20 h10 v-5 A5 5 0 0 1 83 3 z" stroke="#111111" stroke-width="6" fill="none"></path></svg>`,
        );
        const svg = added(e)[0]!;
        e.down(svg);
        e.up(svg);
        pullRight(e, 80);
        expect(svg.querySelector("path")!.getAttribute("d")).toBe("m3 3 l80 20 h20 v-5 A10 5 0 0 1 163 3 z");
      });

      it("still scales the deck's own elements and text boxes", () => {
        const e = editor();
        e.fromParent({ type: "slop:edit-tool", tool: "text", style: TEXT_STYLE });
        dragOut(e, [100, 100], [400, 100]);
        e.key("Escape");
        const box = added(e)[0]!;
        e.down(box);
        e.up(box);
        pullRight(e, 150);
        expect(box.style.scale).toBe("1.5 1");
        expect(box.style.width).toBe("300px");
      });
    });

    it("deletes the selection when the toolbar asks", () => {
      const e = editor();
      e.down(e.$("h1"));
      e.fromParent({ type: "slop:edit-delete" });
      expect(e.doc.querySelector("h1")).toBeNull();
      expect(e.commits()).toHaveLength(1);
      e.fromParent({ type: "slop:edit-delete" });
      expect(e.commits()).toHaveLength(1);
    });

    describe("stacking order", () => {
      it("moves an element above or below the others with a z-index, keeping the layout", () => {
        const e = editor();
        const h1 = e.$("h1");
        e.$(".card").setAttribute("style", "position: absolute; z-index: 3");
        e.down(h1);
        e.fromParent({ type: "slop:edit-order", to: "front" });
        expect(h1.style).toMatchObject({ position: "relative", zIndex: "4" });
        // Already on top.
        e.fromParent({ type: "slop:edit-order", to: "forward" });
        expect(h1.style.zIndex).toBe("4");
        // Just below the card, which comes later in the document, but above the rest.
        e.fromParent({ type: "slop:edit-order", to: "backward" });
        expect(h1.style.zIndex).toBe("3");
        e.fromParent({ type: "slop:edit-order", to: "back" });
        expect(h1.style.zIndex).toBe("-1");
        expect(e.commits()).toHaveLength(3);
        expect(e.commits()[0]!.markup).toContain(`<h1 class="title" style="position: relative; z-index: 4;">`);
        // DOM order (and so the path to select) stays.
        expect(e.commits()[0]!.select).toEqual([0]);
      });

      it("steps forward only past elements it overlaps", () => {
        const e = editor();
        const boxes = { h1: [0, 0, 100, 100], ".card": [500, 500, 100, 100], svg: [50, 50, 100, 100] } as const;
        for (const [sel, [x, y, w, h]] of Object.entries(boxes)) e.$(sel).getBoundingClientRect = () => new e.window.DOMRect(x, y, w, h);
        e.$(".overlay").getBoundingClientRect = () => new e.window.DOMRect(900, 900, 10, 10);
        e.$(".shape").getBoundingClientRect = () => new e.window.DOMRect(900, 900, 10, 10);
        e.$(".card").setAttribute("style", "position: absolute; z-index: 5");
        e.$("svg").setAttribute("style", "position: absolute; z-index: 2");
        e.down(e.$("h1"));
        e.fromParent({ type: "slop:edit-order", to: "forward" });
        // Past the drawing it overlaps (z-index 2, later in the document), not the card far away.
        expect(e.$("h1").style.zIndex).toBe("3");
      });

      it("keeps an element sent behind its siblings inside its parent", () => {
        const e = editor();
        // The first paragraph is at the back already.
        e.down(e.$(".card p"));
        e.fromParent({ type: "slop:edit-order", to: "back" });
        expect(e.commits()).toEqual([]);
        const second = e.$(".card p:nth-child(2)");
        e.down(second);
        e.fromParent({ type: "slop:edit-order", to: "back" });
        e.fromParent({ type: "slop:edit-order", to: "back" });
        expect(second.style.zIndex).toBe("-1");
        expect(e.$(".card").style.isolation).toBe("isolate");
        expect(e.commits()).toHaveLength(1);
        e.down(e.$("h1"));
        e.fromParent({ type: "slop:edit-order", to: "back" });
        expect(e.$("#intro").style.isolation).toBe("");
      });
    });
  });
});
