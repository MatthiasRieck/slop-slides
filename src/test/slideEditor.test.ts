/**
 * The slide editor (src-tauri/assets/editor.js) that the backend adds to the stage's slide
 * preview in edit mode. It runs after the player, in the slide's iframe.
 */
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import EDITOR from "../../src-tauri/assets/editor.js?raw";
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
    expect(e.keys()).toEqual([{ type: "slop:key", key: "ArrowRight", mod: false }]);
  });

  it("saves a pending nudge before passing undo to the app", () => {
    vi.useFakeTimers();
    const e = editor();
    e.down(e.$("h1"));
    e.key("ArrowLeft");
    e.key("z", { metaKey: true });
    expect(e.commits()).toHaveLength(1);
    expect(e.keys()).toEqual([{ type: "slop:key", key: "z", mod: true }]);
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
});
