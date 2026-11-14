// @vitest-environment node
/**
 * The pasteboard (src-tauri/assets/pasteboard.js) that the backend adds to the stage's slide
 * preview, in view mode on its own and in edit mode under the slide editor. It runs after the
 * player, in the slide's iframe. How it pans and zooms with the editor on top is covered in
 * slideEditor.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

import PASTEBOARD from "../../src-tauri/assets/pasteboard.js?raw";
import RUNTIME from "../../src-tauri/assets/runtime.js?raw";
import { openDeck } from "./deckDom";
import { placement } from "./placement";

const DECK = (bodyStyle = "") => `<!DOCTYPE html><html><head><style>${bodyStyle}</style></head><body>
<main class="deck">
  <section class="slide" id="intro"><h1>Hello</h1><a href="#x">Link</a></section>
  <section class="slide" id="outro"><p>Bye</p></section>
</main></body></html>`;

interface View {
  type: string;
  slide: string;
  x: number;
  y: number;
  k: number;
}

function pasteboard({
  framed = true,
  bodyStyle = "",
  show = false,
  stage,
}: {
  framed?: boolean;
  bodyStyle?: string;
  show?: boolean;
  stage?: [number, number];
} = {}) {
  const posted: unknown[] = [];
  const parent = { postMessage: (data: unknown) => posted.push(data) };
  const window = openDeck(DECK(bodyStyle), {
    url: show
      ? "https://example.test/deck.html?v=1&show#intro"
      : "https://example.test/deck.html?embed&slide=intro&pan",
    size: [2560, 1440],
    parent: framed ? parent : undefined,
    stage,
    visual: true,
    scripts: [RUNTIME, PASTEBOARD],
  });
  const doc = window.document;
  const $ = (selector: string) => doc.querySelector<HTMLElement>(selector)!;
  const pointer = (type: string, target: Element, x: number, y: number, button = 0) =>
    target.dispatchEvent(
      new window.PointerEvent(type, { clientX: x, clientY: y, button, bubbles: true, cancelable: true }),
    );
  return {
    window,
    doc,
    $,
    /** Where the deck lands on screen, as one translate-then-scale (zoomed in, scaled down). */
    transform: () => placement($(".deck")),
    views: () => posted.filter((m) => (m as View).type === "slop:view") as View[],
    zooms: () => posted.filter((m) => (m as View).type === "slop:zoom") as View[],
    keys: () => posted.filter((m) => (m as View).type === "slop:key"),
    posted: (type: string) => posted.filter((m) => (m as View).type === type) as Record<string, never>[],
    focusRequests: () => posted.filter((m) => (m as View).type === "slop:focus").length,
    pointer,
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
    /** The next animation frame, by which a gesture's events have moved the slide. */
    frame: () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())),
    wheel: (init: WheelEventInit, timeStamp?: number) => {
      const event = new window.WheelEvent("wheel", { cancelable: true, bubbles: true, ...init });
      if (timeStamp !== undefined) Object.defineProperty(event, "timeStamp", { value: timeStamp });
      doc.body.dispatchEvent(event);
      return event;
    },
    click: (target: Element, x = 1500) =>
      target.dispatchEvent(
        new window.MouseEvent("click", { clientX: x, clientY: 100, bubbles: true, cancelable: true }),
      ),
    fromParent: (data: unknown) => {
      const event = new window.MessageEvent("message", { data });
      Object.defineProperty(event, "source", { value: parent });
      window.dispatchEvent(event);
    },
  };
}

describe("comments", () => {
  const box = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;

  /** A preview laid out by hand, as jsdom lays nothing out. `under` is what lies under the pointer. */
  function commented() {
    const page = pasteboard();
    const { $, doc } = page;
    $("#intro").getBoundingClientRect = () => box(100, 100, 1000, 500);
    $("#intro h1").getBoundingClientRect = () => box(200, 200, 100, 50);
    const stack = { under: [$("#intro h1"), $("#intro")] as Element[] };
    (doc as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => stack.under;
    return { ...page, stack };
  }
  const h1 = { path: [0], tag: "h1", label: "Hello", at: [0.5, 0.5] };

  it("reports the element clicked, with the point on the slide and on it", () => {
    const { $, pointer, fromParent, posted } = commented();
    fromParent({ type: "slop:comment-tool", on: true });
    pointer("pointerdown", $("#intro h1"), 250, 225);
    expect(posted("slop:comment-pick")).toEqual([
      { type: "slop:comment-pick", slide: "intro", x: 0.15, y: 0.25, target: h1 },
    ]);
  });

  it("is about the slide itself on its background, and about nothing outside it", () => {
    const { $, doc, pointer, fromParent, posted, stack } = commented();
    fromParent({ type: "slop:comment-tool", on: true });
    stack.under = [$("#intro")];
    pointer("pointerdown", $("#intro"), 600, 350);
    expect(posted("slop:comment-pick")[0]).toMatchObject({ x: 0.5, y: 0.5, target: null });
    pointer("pointerdown", doc.body, 50, 50);
    expect(posted("slop:comment-pick")).toHaveLength(1);
  });

  it("picks what is at a point the app asks about, with no tool on, and takes a point off the slide as the nearest on it", () => {
    const { $, fromParent, posted, stack } = commented();
    fromParent({ type: "slop:comment-at", x: 250, y: 225 });
    expect(posted("slop:comment-pick")).toEqual([
      { type: "slop:comment-pick", slide: "intro", x: 0.15, y: 0.25, target: h1 },
    ]);
    stack.under = [$("#intro")];
    fromParent({ type: "slop:comment-at", x: 20, y: 9000 });
    expect(posted("slop:comment-pick")[1]).toMatchObject({ x: 0, y: 1, target: null });
    fromParent({ type: "slop:comment-at", x: "left", y: 10 });
    expect(posted("slop:comment-pick")).toHaveLength(2);
  });

  it("asks for the editor on a double-click on the slide, unless a comment is being placed or a control was hit", () => {
    const { $, doc, window, fromParent, posted } = commented();
    const twice = (target: Element) =>
      target.dispatchEvent(new window.MouseEvent("dblclick", { button: 0, bubbles: true, cancelable: true }));
    twice($("#intro h1"));
    expect(posted("slop:edit-ask")).toEqual([{ type: "slop:edit-ask", slide: "intro" }]);
    const link = doc.createElement("a");
    $("#intro").appendChild(link);
    twice(link);
    fromParent({ type: "slop:comment-tool", on: true });
    twice($("#intro h1"));
    expect(posted("slop:edit-ask")).toHaveLength(1);
  });

  it("looks through an invisible layer to what shows", () => {
    const { $, doc, pointer, fromParent, posted, stack } = commented();
    const cover = doc.createElement("div");
    $("#intro").appendChild(cover);
    stack.under = [cover, $("#intro h1"), $("#intro")];
    fromParent({ type: "slop:comment-tool", on: true });
    pointer("pointerdown", cover, 250, 225);
    expect(posted("slop:comment-pick")[0]).toMatchObject({ target: { tag: "h1" } });
  });

  it("outlines what a click would comment on", () => {
    const { $, doc, pointer, fromParent, stack } = commented();
    fromParent({ type: "slop:comment-tool", on: true });
    pointer("pointermove", $("#intro h1"), 250, 225);
    const hover = doc.querySelector<HTMLElement>("[data-slop-comment-hover]")!;
    expect([hover.style.display, hover.style.left, hover.style.width]).toEqual(["block", "200px", "100px"]);
    stack.under = [$("#intro")];
    pointer("pointermove", $("#intro"), 600, 350);
    expect(hover.style.display).toBe("none");
  });

  it("takes the click from links, and pans again once off", () => {
    const { $, doc, pointer, click, fromParent, posted, views, drag } = commented();
    fromParent({ type: "slop:comment-tool", on: true });
    expect(doc.documentElement.hasAttribute("data-slop-commenting")).toBe(true);
    const clicked = new (doc.defaultView as unknown as typeof window).MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    $("#intro a").dispatchEvent(clicked);
    expect(clicked.defaultPrevented).toBe(true);
    fromParent({ type: "slop:comment-tool", on: false });
    expect(doc.documentElement.hasAttribute("data-slop-commenting")).toBe(false);
    pointer("pointerdown", $("#intro h1"), 250, 225);
    pointer("pointerup", $("#intro h1"), 250, 225);
    click($("#intro a"));
    expect(posted("slop:comment-pick")).toEqual([]);
    drag($("#intro"), 40, 0, 1);
    expect(views().length).toBeGreaterThan(0);
  });

  it("finds a comment's element where it was, and places the pin on it", () => {
    const { fromParent, posted } = commented();
    fromParent({ type: "slop:comment-locate", comments: [{ id: "a", x: 0, y: 0, target: h1 }] });
    expect(posted("slop:comment-spots")).toEqual([
      { type: "slop:comment-spots", slide: "intro", spots: [{ id: "a", x: 0.15, y: 0.25, found: true }] },
    ]);
  });

  it("follows an element that moved, by what it shows", () => {
    const { $, doc, fromParent, posted } = commented();
    const before = doc.createElement("p");
    before.textContent = "New";
    $("#intro").prepend(before);
    fromParent({ type: "slop:comment-locate", comments: [{ id: "a", x: 0, y: 0, target: h1 }] });
    expect(posted("slop:comment-spots")[0]).toMatchObject({ spots: [{ x: 0.15, found: true }] });
  });

  it("keeps the pin where it was when the element is gone, and says so", () => {
    const { $, fromParent, posted } = commented();
    $("#intro h1").textContent = "Changed";
    fromParent({ type: "slop:comment-locate", comments: [{ id: "a", x: 0.3, y: 0.4, target: h1 }] });
    expect(posted("slop:comment-spots")[0]).toMatchObject({ spots: [{ x: 0.3, y: 0.4, found: false }] });
  });

  it("finds a comment on the slide itself at its own place", () => {
    const { fromParent, posted } = commented();
    fromParent({ type: "slop:comment-locate", comments: [{ id: "a", x: 0.3, y: 0.4 }] });
    expect(posted("slop:comment-spots")[0]).toMatchObject({ spots: [{ x: 0.3, y: 0.4, found: true }] });
  });

  it("looks again when an animation ends", () => {
    const { $, window, fromParent, posted } = commented();
    fromParent({ type: "slop:comment-locate", comments: [{ id: "a", x: 0, y: 0, target: h1 }] });
    $("#intro h1").getBoundingClientRect = () => box(300, 200, 100, 50);
    $("#intro h1").dispatchEvent(new window.Event("animationend", { bubbles: true }));
    expect(posted("slop:comment-spots")[1]).toMatchObject({ spots: [{ x: 0.25 }] });
  });
});

describe("search marks", () => {
  // jsdom has no CSS highlights.
  function marked(html: string) {
    const page = pasteboard();
    const { window, doc, $ } = page;
    const sets = new Map<string, Set<Range>>();
    const registered: string[] = [];
    const win = window as unknown as Record<string, unknown>;
    win.Highlight = Set;
    win.CSS = {
      highlights: {
        set: (name: string, ranges: Set<Range>) => {
          registered.push(name);
          sets.set(name, ranges);
        },
      },
    };
    $("#intro").innerHTML = html;
    return {
      doc,
      search: (query: string, more: object = {}) =>
        page.fromParent({ type: "slop:search", query, matchCase: false, wholeWord: false, active: 0, ...more }),
      registered,
      all: () => [...(sets.get("slop-search") ?? [])].map(String),
      strong: () => [...(sets.get("slop-search-active") ?? [])].map(String),
    };
  }

  it("marks every hit in the slide, the active one stronger, as the toolbar steps", () => {
    const { search, all, strong } = marked("<h1>Plan</h1><p>the plan, planning</p>");
    search("plan");
    expect(strong()).toEqual(["Plan"]);
    expect(all()).toEqual(["plan", "plan"]);
    search("plan", { active: 2 });
    expect(strong()).toEqual(["plan"]);
    expect(all()).toEqual(["Plan", "plan"]);
    search("");
    expect([...all(), ...strong()]).toEqual([]);
  });

  it("reads text as find.rs does", () => {
    const { search, all, strong } = marked(
      `<p>R&amp;D next
         quarter</p><p>Hello <em>there</em></p><style>.plan {}</style><div data-delete-placeholder>plan</div>`,
    );
    search("r&d next quarter");
    expect(strong()).toEqual(["R&D next\n         quarter"]);
    search("hello there");
    expect(strong()).toEqual([]);
    search("plan");
    expect([...all(), ...strong()]).toEqual([]);
  });

  it("honors match case and whole words", () => {
    const { search, all, strong } = marked("<p>Plan plan planning</p>");
    search("plan", { matchCase: true, active: -1 });
    expect(all()).toEqual(["plan", "plan"]);
    expect(strong()).toEqual([]);
    search("plan", { wholeWord: true, active: -1 });
    expect(all()).toEqual(["Plan", "plan"]);
  });

  it("refills its highlights rather than replacing them, which WebKit would leave painted", () => {
    const { search, registered, all, strong } = marked("<p>hat hit</p>");
    search("h");
    search("hi");
    expect(registered).toEqual(["slop-search", "slop-search-active"]);
    expect(strong()).toEqual(["hi"]);
    expect(all()).toEqual([]);
  });

  it("leaves the slide's markup alone", () => {
    const { search, doc } = marked("<p>plan</p>");
    const before = doc.body.innerHTML;
    search("plan");
    expect(doc.body.innerHTML).toBe(before);
  });
});

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
    // A screen pixel wide, however far the app scales the preview (see slop:fit).
    expect(css).toMatch(
      /\[data-slop-frame\] \{[^}]*box-shadow:[^}]*outline: calc\(1px \* var\(--slop-ui, 1\)\) solid var\(--slop-border/,
    );
    // Only the editor lets the slide show what runs past its edge.
    expect(css).not.toContain("overflow: visible");
  });

  // Under a `scale()`, WebKit stretches what a slide paints on layers of its own (backdrop
  // filters, filters, animations) from the size it was first painted, blurring text when zoomed in.
  it("zooms the slide with `zoom` rather than a scale, so it is painted sharp when zoomed in", () => {
    const p = pasteboard();
    const deck = p.$(".deck");
    expect(deck.style.zoom).toBe("1");
    p.fromParent({ type: "slop:camera", x: 30, y: -60, k: 4 });
    expect(deck.style.zoom).toBe("4");
    expect(deck.style.transform).not.toContain("scale");
    // The pan is zoomed along with the deck, so it is given in unzoomed px: (320 + 30) / 4.
    expect(deck.style.transform).toBe("translate(87.5px,30px)");
    expect(p.transform()).toBe("translate(350px,120px) scale(4)");
    // The frame is not zoomed; it sits where the zoomed slide does.
    expect(p.$("[data-slop-frame]").style.cssText).toContain("left: 350px");
    expect(p.$("[data-slop-frame]").style.cssText).toContain("width: 7680px");
  });

  it("zooms with `zoom` in a show too, over the player's fit to the window", () => {
    const p = pasteboard({ show: true });
    const deck = p.$(".deck");
    expect(deck.style.zoom).toBe(String(4 / 3));
    expect(deck.style.transform).toBe("translate(0px,0px)");
    // A resize runs the player's fit (a scale) first; the pasteboard puts its zoom back.
    p.window.dispatchEvent(new p.window.Event("resize"));
    expect(deck.style.transform).not.toContain("scale");
    expect(p.transform()).toBe(`translate(0px,0px) scale(${4 / 3})`);
  });

  // Laid out at a fraction of its size, text no longer measures in proportion (WebKit holds tiny
  // fonts at a minimum size), so lines wrap differently and the slide overflows when zoomed out.
  it("shrinks the slide with a scale, laying it out at full size, when zoomed out", () => {
    const p = pasteboard();
    const deck = p.$(".deck");
    p.fromParent({ type: "slop:camera", x: 30, y: -60, k: 0.25 });
    expect(deck.style.zoom).toBe("1");
    expect(deck.style.transform).toBe("translate(350px,120px) scale(0.25)");
    expect(p.transform()).toBe("translate(350px,120px) scale(0.25)");
    expect(p.$("[data-slop-frame]").style.cssText).toContain("width: 480px");
    // Back past full size, it zooms again and drops the scale.
    p.fromParent({ type: "slop:camera", x: 0, y: 0, k: 2 });
    expect(deck.style.zoom).toBe("2");
    expect(deck.style.transform).toBe("translate(160px,90px)");
  });

  it("shrinks with a scale in a show fit to a window smaller than the slide", () => {
    const p = pasteboard({ show: true });
    Object.defineProperty(p.window, "innerWidth", { value: 960, configurable: true });
    Object.defineProperty(p.window, "innerHeight", { value: 540, configurable: true });
    p.window.dispatchEvent(new p.window.Event("resize"));
    const deck = p.$(".deck");
    expect(deck.style.zoom).toBe("1");
    expect(deck.style.transform).toBe("translate(0px,0px) scale(0.5)");
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
    expect(pasteboard({ bodyStyle: "body { background: rgb(10, 20, 30) }" }).$(".deck").style.backgroundColor).toBe(
      "rgb(10, 20, 30)",
    );
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
    // The middle button pans too, even from links.
    p.drag(p.$("a"), 50, 0, 1);
    expect(p.transform()).toBe("translate(420px,150px) scale(1)");
  });

  it("keeps what it draws and how far a press may wander at their size on screen, as the app scales the preview", () => {
    const p = pasteboard();
    const api = (p.window as unknown as { slopPasteboard: { ui: () => number; onChange: (fn: () => void) => void } })
      .slopPasteboard;
    const changed = vi.fn();
    api.onChange(changed);
    expect(api.ui()).toBe(1);
    // Shown at half its size, a screen pixel is two of the preview's.
    p.fromParent({ type: "slop:fit", scale: 0.5 });
    expect(api.ui()).toBe(2);
    expect(p.doc.documentElement.style.getPropertyValue("--slop-ui")).toBe("2");
    expect(changed).toHaveBeenCalledTimes(1);
    // The same again changes nothing; what is no scale is ignored.
    p.fromParent({ type: "slop:fit", scale: 0.5 });
    p.fromParent({ type: "slop:fit", scale: 0 });
    p.fromParent({ type: "slop:fit", scale: "big" });
    expect(changed).toHaveBeenCalledTimes(1);
    // 5 of its pixels are under 3 on screen: a click, not a pan.
    p.drag(p.$("h1"), 5, 0);
    expect(p.transform()).toBe("translate(320px,180px) scale(1)");
    p.drag(p.$("h1"), 8, 0);
    expect(p.transform()).toBe("translate(328px,180px) scale(1)");
  });

  it("asks the app for keyboard focus on a press while it has none, since panning cancels the press", () => {
    const p = pasteboard();
    let focused = false;
    p.doc.hasFocus = () => focused;
    p.pointer("pointerdown", p.$("h1"), 100, 100);
    p.pointer("pointerdown", p.$("a"), 100, 100);
    expect(p.focusRequests()).toBe(2);
    focused = true;
    p.pointer("pointerdown", p.$("h1"), 100, 100);
    expect(p.focusRequests()).toBe(2);
    // The presenter focuses its show itself.
    const show = pasteboard({ show: true });
    show.doc.hasFocus = () => false;
    show.pointer("pointerdown", show.$("h1"), 100, 100);
    expect(show.focusRequests()).toBe(0);
  });

  it("tells the app of every press, so what is open there closes, in the show too", () => {
    const p = pasteboard();
    p.doc.hasFocus = () => true;
    p.pointer("pointerdown", p.$("h1"), 100, 100);
    p.pointer("pointerdown", p.$("a"), 100, 100, 1);
    expect(p.posted("slop:press")).toEqual([{ type: "slop:press" }, { type: "slop:press" }]);
    const show = pasteboard({ show: true });
    show.pointer("pointerdown", show.$("h1"), 100, 100);
    expect(show.posted("slop:press")).toHaveLength(1);
  });

  it("hands Escape to the app while something is open there, and keeps it otherwise", () => {
    const p = pasteboard();
    p.fromParent({ type: "slop:layer", open: true });
    const handed = p.key("Escape");
    expect(p.posted("slop:dismiss")).toEqual([{ type: "slop:dismiss" }]);
    expect(handed.defaultPrevented).toBe(true);
    // The player never saw it, so it is not also forwarded as a key.
    expect(p.keys()).toEqual([]);
    // Other keys go on as ever.
    p.key("ArrowRight");
    expect(p.keys()).toEqual([{ type: "slop:key", key: "ArrowRight", mod: false, shift: false }]);
    p.fromParent({ type: "slop:layer", open: false });
    p.key("Escape");
    expect(p.posted("slop:dismiss")).toHaveLength(1);
    expect(p.keys()).toContainEqual({ type: "slop:key", key: "Escape", mod: false, shift: false });
  });

  it("leaves links and other controls on the slide to be clicked", () => {
    const p = pasteboard();
    p.drag(p.$("a"), 50, 0);
    expect(p.transform()).toBe("translate(320px,180px) scale(1)");
    p.drag(p.$("a"), 50, 0, 1);
    expect(p.transform()).toBe("translate(370px,180px) scale(1)");
  });

  /**
   * Lays out the h1's "Hello" for the caret lookups jsdom lacks: at (100, 100), 10px a character,
   * 20px tall, in a box from (80, 80) to (400, 140). A `cover` given lies over the whole slide and
   * hides the text from hit testing unless it is out of it (pointer-events: none).
   */
  function layOut(p: ReturnType<typeof pasteboard>, cover?: HTMLElement) {
    const h1 = p.$("h1");
    const text = h1.firstChild as Text;
    const covering = () => cover && cover.style.pointerEvents !== "none";
    const inBox = (x: number, y: number) => x >= 80 && x <= 400 && y >= 80 && y <= 140;
    Object.assign(p.doc, {
      elementFromPoint: (x: number, y: number) => (covering() ? cover : inBox(x, y) ? h1 : p.$("#intro")),
      caretPositionFromPoint: (x: number, y: number) => {
        if (covering()) return { offsetNode: cover, offset: 0 };
        if (y < 90 || y > 130) return { offsetNode: p.doc.body, offset: 0 };
        return { offsetNode: text, offset: Math.max(0, Math.min(5, Math.round((x - 100) / 10))) };
      },
    });
    p.window.Range.prototype.getClientRects = function (this: Range) {
      const i = this.startOffset;
      return [{ left: 100 + i * 10, right: 110 + i * 10, top: 100, bottom: 120 }] as unknown as DOMRectList;
    };
    const fire = (type: string, x: number, y: number, button = 0) => {
      const event = new p.window.PointerEvent(type, {
        clientX: x,
        clientY: y,
        button,
        bubbles: true,
        cancelable: true,
      });
      (cover && covering() ? cover : h1).dispatchEvent(event);
      return event;
    };
    return {
      text,
      fire,
      /** Drags 50px to the right from (x, y), returning the press. */
      press(x: number, y: number, button = 0) {
        const down = fire("pointerdown", x, y, button);
        fire("pointermove", x + 50, y);
        fire("pointerup", x + 50, y);
        return down;
      },
    };
  }

  it("selects text when a drag starts on it, and pans from anywhere else in its box", () => {
    const p = pasteboard();
    const { press } = layOut(p);
    // On a character: the browser gets the press, to start a selection.
    expect(press(125, 110).defaultPrevented).toBe(false);
    expect(press(149, 119).defaultPrevented).toBe(false);
    expect(p.transform()).toBe("translate(320px,180px) scale(1)");
    // Past the line's end, below it, or off the text: the drag pans.
    expect(press(170, 110).defaultPrevented).toBe(true);
    expect(p.transform()).toBe("translate(370px,180px) scale(1)");
    press(125, 125);
    expect(p.transform()).toBe("translate(420px,180px) scale(1)");
    press(125, 200);
    expect(p.transform()).toBe("translate(470px,180px) scale(1)");
    // The middle button pans even from text.
    press(125, 110, 1);
    expect(p.transform()).toBe("translate(520px,180px) scale(1)");
  });

  it("selects text under an invisible layer the deck spread over the slide, and keeps the layer", () => {
    const p = pasteboard();
    const cover = p.doc.createElement("div");
    cover.className = "aim-zones";
    p.$("#intro").appendChild(cover);
    const { text, fire } = layOut(p, cover);
    const down = fire("pointerdown", 102, 110);
    expect(down.defaultPrevented).toBe(true);
    // The layer is out of the way while selecting, so the text under it can be found.
    expect(cover.style.getPropertyValue("pointer-events")).toBe("none");
    fire("pointermove", 135, 110);
    const selection = p.window.getSelection()!;
    expect([selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset]).toEqual([
      text,
      0,
      text,
      4,
    ]);
    expect(selection.toString()).toBe("Hell");
    expect(p.transform()).toBe("translate(320px,180px) scale(1)");
    fire("pointerup", 135, 110);
    expect(cover.getAttribute("style")).toBe("");
    // A press beside the text pans, deselects, and leaves the layer as the deck had it.
    cover.style.setProperty("pointer-events", "auto", "important");
    fire("pointerdown", 300, 110);
    fire("pointermove", 350, 110);
    fire("pointerup", 350, 110);
    expect(p.transform()).toBe("translate(370px,180px) scale(1)");
    expect(selection.rangeCount).toBe(0);
    expect(cover.style.getPropertyValue("pointer-events")).toBe("auto");
    expect(cover.style.getPropertyPriority("pointer-events")).toBe("important");
  });

  it("leaves the secondary button to the slide", () => {
    const p = pasteboard();
    p.drag(p.$("h1"), 50, 0, 2);
    expect(p.transform()).toBe("translate(320px,180px) scale(1)");
  });

  it("pans with a trackpad swipe and zooms with a pinch around the pointer", async () => {
    const p = pasteboard();
    p.wheel({ deltaX: 30, deltaY: 100 });
    await p.frame();
    expect(p.views().at(-1)).toMatchObject({ x: -30, y: -100, k: 1 });
    p.fromParent({ type: "slop:camera", home: true });
    const event = p.wheel({ ctrlKey: true, deltaY: -60, clientX: 320, clientY: 180 });
    expect(event.defaultPrevented).toBe(true);
    await p.frame();
    const { x, y, k } = p.views().at(-1)!;
    expect(k).toBeCloseTo(Math.exp(0.3), 5);
    // The slide's corner under the pointer stays put.
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(0, 5);
    expect(p.$("[data-slop-frame]").style.cssText).toContain(`width: ${1920 * k}px`);
  });

  it("scrolls with the mouse wheel in view mode too, only as far as the zoomed-in slide reaches, in Chromium and in WebKit", async () => {
    const p = pasteboard();
    const notch = async (deltaY: number, wheelDeltaY: number, shiftKey = false) => {
      const event = new p.window.WheelEvent("wheel", { deltaY, shiftKey, cancelable: true, bubbles: true });
      Object.defineProperty(event, "timeStamp", { value: (p.views().length + 1) * 1000 });
      Object.defineProperty(event, "wheelDeltaY", { value: wheelDeltaY });
      p.doc.body.dispatchEvent(event);
      await p.frame();
      return event;
    };
    // The whole slide is in view: a notch moves nothing, and zooms nothing.
    expect((await notch(40, -120)).defaultPrevented).toBe(true);
    expect(p.views()).toEqual([]);
    expect(p.transform()).toBe("translate(320px,180px) scale(1)");
    // Zoomed in to twice its size (3840 × 2160 in a 2560 × 1440 view), the slide scrolls.
    p.fromParent({ type: "slop:camera", x: -960, y: -540, k: 2 });
    await notch(40, -120);
    expect(p.views().at(-1)).toMatchObject({ x: -960, y: -580, k: 2 });
    // WebKit's notch is a fraction of a line; it scrolls a line.
    await notch(4.000244140625, -12);
    expect(p.views().at(-1)!.y).toBeCloseTo(-620.0024, 3);
    // With Shift, sideways; never past the slide's edge and a margin.
    await notch(40, -120, true);
    expect(p.views().at(-1)!.x).toBe(-1000);
    for (let i = 0; i < 40; i++) await notch(-400, 1200, true);
    expect(p.views().at(-1)!.x).toBe(48 - 320);
    expect(p.views().at(-1)!.k).toBe(2);
  });

  it("shows the slide at its real size with ⇧0 or when the app asks, and zooms to a box of it", () => {
    const p = pasteboard();
    // The app shows the preview at half its size: 100% is twice the slide's size here.
    p.fromParent({ type: "slop:fit", scale: 0.5 });
    const shifted = (key: string, code: string) => {
      const event = new p.window.KeyboardEvent("keydown", {
        key,
        code,
        shiftKey: true,
        cancelable: true,
        bubbles: true,
      });
      p.doc.body.dispatchEvent(event);
      return event;
    };
    expect(shifted(")", "Digit0").defaultPrevented).toBe(true);
    expect(p.views().at(-1)).toMatchObject({ x: -960, y: -540, k: 2 });
    expect(p.keys()).toEqual([]);
    p.fromParent({ type: "slop:camera", home: true });
    p.fromParent({ type: "slop:camera", actual: true });
    expect(p.views().at(-1)).toMatchObject({ k: 2 });
    // Where Shift types the 0 itself (AZERTY), it is the 0: back to the whole slide.
    shifted("0", "Digit0");
    expect(p.views().at(-1)).toMatchObject({ x: 0, y: 0, k: 1 });
    // A box of the slide fills the view, with room around it, centered.
    p.fromParent({ type: "slop:camera", box: { x: 100, y: 100, w: 400, h: 100 } });
    const room = 2 * 48 * 2;
    const k = Math.min((2560 - room) / 400, (1440 - room) / 100);
    const view = p.views().at(-1)!;
    expect(view.k).toBeCloseTo(k, 5);
    // The box's middle (300, 150) is the view's middle.
    expect(320 + view.x + 300 * view.k).toBeCloseTo(1280, 5);
    expect(180 + view.y + 150 * view.k).toBeCloseTo(720, 5);
    // A box that says nothing is no zoom.
    const before = p.views().length;
    p.fromParent({ type: "slop:camera", box: { x: "a", y: 0, w: 1, h: 1 } });
    expect(p.views()).toHaveLength(before);
  });

  /** The slide's box on screen, as a browser lays the deck out from its `zoom` and transform. */
  function onScreen(p: ReturnType<typeof pasteboard>, [w, h] = [1920, 1080]) {
    const deck = p.$(".deck");
    // Lengths on a zoomed element are zoomed, the pan among them; a scale comes on top.
    const z = Number(deck.style.zoom);
    const [, x, y, scaled] = /^translate\((.+)px,(.+)px\)(?: scale\((.+)\))?$/.exec(deck.style.transform)!;
    const k = z * Number(scaled ?? 1);
    return { left: Number(x) * z, top: Number(y) * z, width: w! * k, height: h! * k };
  }
  const board = (p: ReturnType<typeof pasteboard>) =>
    p.window.slopPasteboard as unknown as {
      scale: () => number;
      origin: () => { x: number; y: number };
      onChange: (fn: () => void) => void;
    };
  /** Counts how often the deck's transform is written. */
  function transformWrites(deck: HTMLElement) {
    const writes: string[] = [];
    let value = deck.style.transform;
    Object.defineProperty(deck.style, "transform", {
      configurable: true,
      get: () => value,
      set: (next: string) => {
        value = next;
        writes.push(next);
      },
    });
    return writes;
  }
  /** Long enough without a wheel event for the gesture to have ended (WHEEL_GESTURE_MS). */
  const rest = () => new Promise((resolve) => setTimeout(resolve, 200));
  /** The scale in the deck's transform, which a slide at rest has only when shrunk. */
  const scaled = (deck: HTMLElement) => Number(/ scale\((.+)\)$/.exec(deck.style.transform)?.[1]);

  it("applies the camera at most once per frame, however many wheel events it brings", async () => {
    const p = pasteboard();
    const writes = transformWrites(p.$(".deck"));
    let changes = 0;
    board(p).onChange(() => changes++);
    const views = p.views().length;
    for (let i = 0; i < 10; i++) p.wheel({ deltaX: 3, deltaY: 10 }, 1000 + i);
    // Nothing yet: the events only moved the view.
    expect([writes.length, changes, p.views().length - views]).toEqual([0, 0, 0]);
    await p.frame();
    expect([writes.length, changes, p.views().length - views]).toEqual([1, 1, 1]);
    // The one report is where the last event left the view.
    expect(p.views().at(-1)).toEqual({ type: "slop:view", slide: "intro", x: -30, y: -100, k: 1 });
    expect(p.transform()).toBe("translate(290px,80px) scale(1)");
    // Pinching and dragging are no different.
    for (let i = 0; i < 10; i++) p.wheel({ ctrlKey: true, deltaY: -6, clientX: 0, clientY: 0 }, 1010 + i);
    p.pointer("pointerdown", p.$("h1"), 100, 100, 1);
    for (let i = 1; i <= 10; i++) p.pointer("pointermove", p.$("h1"), 100 + i * 5, 100, 1);
    await p.frame();
    expect([writes.length, changes, p.views().length - views]).toEqual([2, 2, 2]);
    expect(p.views().at(-1)!.k).toBeCloseTo(Math.exp(0.3), 5);
  });

  it("moves at once for a key, a button of the app and a restored view, ahead of a waiting frame", async () => {
    const p = pasteboard();
    const writes = transformWrites(p.$(".deck"));
    p.wheel({ deltaX: 30, deltaY: 100 });
    p.fromParent({ type: "slop:camera", zoomBy: 2 });
    expect(writes).toHaveLength(1);
    expect(p.views().at(-1)).toMatchObject({ k: 2 });
    p.key("0");
    expect(p.transform()).toBe("translate(320px,180px) scale(1)");
    // The frame the wheel asked for has nothing left to do.
    await p.frame();
    expect(writes).toHaveLength(2);
  });

  it("zooms with a scale during a pinch and lays the slide out at the new zoom once it ends", async () => {
    const p = pasteboard();
    const deck = p.$(".deck");
    p.fromParent({ type: "slop:camera", x: 0, y: 0, k: 2 });
    expect([deck.style.zoom, deck.style.transform, deck.style.willChange]).toEqual(["2", "translate(160px,90px)", ""]);
    p.wheel({ ctrlKey: true, deltaY: -60, clientX: 700, clientY: 400 }, 1000);
    await p.frame();
    p.wheel({ ctrlKey: true, deltaY: -60, clientX: 700, clientY: 400 }, 1016);
    await p.frame();
    // Still laid out at the zoom the pinch began with: the rest of the way is a scale.
    const k = 2 * Math.exp(0.6);
    expect(deck.style.zoom).toBe("2");
    expect(scaled(deck)).toBeCloseTo(k / 2, 10);
    expect(deck.style.willChange).toBe("transform");
    expect(p.views().at(-1)!.k).toBeCloseTo(k, 10);
    const during = { at: onScreen(p), views: p.views().length, frame: p.$("[data-slop-frame]").style.cssText };
    expect(during.at.width).toBeCloseTo(1920 * k, 6);
    expect(Number.parseFloat(p.$("[data-slop-frame]").style.width)).toBeCloseTo(1920 * k, 6);
    await rest();
    // Laid out at the zoom it reached, and not a pixel elsewhere.
    expect(deck.style.zoom).toBe(String(p.views().at(-1)!.k));
    expect(deck.style.transform).not.toContain("scale");
    expect(deck.style.willChange).toBe("");
    const settled = onScreen(p);
    for (const side of ["left", "top", "width", "height"] as const)
      expect(settled[side]).toBeCloseTo(during.at[side], 6);
    expect(p.$("[data-slop-frame]").style.cssText).toBe(during.frame.replace(" will-change: transform;", ""));
    // The app heard of this view already.
    expect(p.views()).toHaveLength(during.views);
  });

  it("shrinks with a scale during a pinch as it does at rest, and settles a pinch a key cuts short", async () => {
    const p = pasteboard();
    const deck = p.$(".deck");
    p.fromParent({ type: "slop:camera", x: 0, y: 0, k: 4 });
    for (let i = 0; i < 40; i++) p.wheel({ ctrlKey: true, deltaY: 60, clientX: 0, clientY: 0 }, 1000 + i);
    await p.frame();
    const k = p.views().at(-1)!.k;
    expect(k).toBeLessThan(1);
    expect(deck.style.zoom).toBe("4");
    expect(scaled(deck)).toBeCloseTo(k / 4, 10);
    const during = onScreen(p);
    await rest();
    expect(deck.style.zoom).toBe("1");
    expect(scaled(deck)).toBe(k);
    expect(onScreen(p).left).toBeCloseTo(during.left, 6);
    expect(onScreen(p).width).toBeCloseTo(during.width, 6);
    // A zoom key ends the pinch there and then.
    p.wheel({ ctrlKey: true, deltaY: -60, clientX: 0, clientY: 0 }, 2000);
    p.fromParent({ type: "slop:camera", zoomTo: 3 });
    expect([deck.style.zoom, deck.style.willChange]).toEqual(["3", ""]);
    expect(deck.style.transform).not.toContain("scale");
  });

  it("a pan moves the slide's frame with a transform and leaves its box alone", async () => {
    const p = pasteboard();
    const frame = p.$("[data-slop-frame]");
    const box = () => [frame.style.left, frame.style.top, frame.style.width, frame.style.height];
    const resting = box();
    expect(resting).toEqual(["320px", "180px", "1920px", "1080px"]);
    p.pointer("pointerdown", p.$("h1"), 100, 100, 1);
    p.pointer("pointermove", p.$("h1"), 150, 70, 1);
    await p.frame();
    expect(box()).toEqual(resting);
    expect([frame.style.transform, frame.style.willChange]).toEqual(["translate(50px,-30px)", "transform"]);
    p.pointer("pointermove", p.$("h1"), 160, 70, 1);
    p.pointer("pointerup", p.$("h1"), 160, 70, 1);
    // At rest its box is where the slide is, written once for the whole drag.
    const dragged = ["380px", "150px", "1920px", "1080px"];
    expect(box()).toEqual(dragged);
    expect([frame.style.transform, frame.style.willChange]).toEqual(["", ""]);
    expect(p.transform()).toBe("translate(380px,150px) scale(1)");
    // A swipe is a pan too.
    p.wheel({ deltaX: 10, deltaY: 20 });
    await p.frame();
    expect(box()).toEqual(dragged);
    expect(frame.style.transform).toBe("translate(-10px,-20px)");
    // A new scale needs a new box, which is where the slide is.
    p.wheel({ ctrlKey: true, deltaY: -60, clientX: 370, clientY: 130 }, 5000);
    await p.frame();
    expect(box().map(Number.parseFloat)).toEqual(
      [370, 130, 1920, 1080].map((v, i) => (i < 2 ? v : v * p.views().at(-1)!.k)),
    );
    expect(p.views().at(-1)!.k).toBeCloseTo(Math.exp(0.3), 10);
    expect(frame.style.transform).toBe("");
  });

  it("tells the editor where the slide is and how large, in a gesture and at rest", async () => {
    for (const show of [false, true]) {
      const p = pasteboard({ show });
      const agrees = () => {
        const rect = onScreen(p);
        const { x, y } = board(p).origin();
        expect(x).toBeCloseTo(rect.left, 6);
        expect(y).toBeCloseTo(rect.top, 6);
        // What everything else derives from layout: the slide's width on screen over its own.
        expect(board(p).scale()).toBeCloseTo(rect.width / 1920, 9);
      };
      agrees();
      expect(board(p).scale()).toBe(show ? 4 / 3 : 1);
      p.fromParent({ type: "slop:camera", x: 30, y: -60, k: 2.5 });
      agrees();
      expect(board(p).scale()).toBe((show ? 4 / 3 : 1) * 2.5);
      p.wheel({ ctrlKey: true, deltaY: 60, clientX: 900, clientY: 300 }, 1000);
      // Until the frame comes the slide has not moved, and they say so.
      agrees();
      expect(board(p).scale()).toBe((show ? 4 / 3 : 1) * 2.5);
      await p.frame();
      agrees();
      expect(board(p).scale()).toBeCloseTo((show ? 4 / 3 : 1) * 2.5 * Math.exp(-0.3), 10);
      p.pointer("pointerdown", p.$("h1"), 100, 100, 1);
      p.pointer("pointermove", p.$("h1"), 140, 180, 1);
      await p.frame();
      agrees();
      p.pointer("pointerup", p.$("h1"), 140, 180, 1);
      await rest();
      agrees();
      p.fromParent({ type: "slop:camera", x: 5, y: 5, k: 0.3 });
      agrees();
    }
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

  it("zooms by a factor or to a level around the middle of the view, as the app's zoom buttons ask", () => {
    const p = pasteboard();
    p.fromParent({ type: "slop:camera", zoomBy: 1.25 });
    // The slide's middle is the view's: it stays there.
    expect(p.views().at(-1)).toMatchObject({ x: -240, y: -135, k: 1.25 });
    p.fromParent({ type: "slop:camera", zoomTo: 2 });
    expect(p.views().at(-1)).toMatchObject({ x: -960, y: -540, k: 2 });
    // Panned, what is in the middle of the view stays in the middle.
    p.fromParent({ type: "slop:camera", x: 100, y: 0, k: 1 });
    p.fromParent({ type: "slop:camera", zoomTo: 0.5 });
    expect(p.views().at(-1)).toMatchObject({ x: 530, y: 270, k: 0.5 });
    // Never past the limits, and nothing for what is no zoom.
    p.fromParent({ type: "slop:camera", zoomTo: 100 });
    expect(p.views().at(-1)!.k).toBe(8);
    const before = p.views().length;
    p.fromParent({ type: "slop:camera", zoomBy: 0 });
    p.fromParent({ type: "slop:camera", zoomTo: -1 });
    p.fromParent({ type: "slop:camera", zoomBy: "2" });
    expect(p.views()).toHaveLength(before);
    p.fromParent({ type: "slop:camera", home: true });
    expect(p.views().at(-1)).toMatchObject({ x: 0, y: 0, k: 1 });
  });

  it("zooms in, out and back with Ctrl or ⌘ and + - 0, keeping the keys from the app and the webview", () => {
    const p = pasteboard();
    const mod = (key: string, init: KeyboardEventInit = { ctrlKey: true }) => {
      const event = new p.window.KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...init });
      p.doc.body.dispatchEvent(event);
      return event;
    };
    expect(mod("=").defaultPrevented).toBe(true);
    expect(p.views().at(-1)).toMatchObject({ x: -240, y: -135, k: 1.25 });
    mod("+", { metaKey: true, shiftKey: true });
    expect(p.views().at(-1)!.k).toBeCloseTo(1.5625, 5);
    mod("-");
    mod("-");
    expect(p.views().at(-1)!.k).toBeCloseTo(1, 5);
    mod("-");
    expect(p.views().at(-1)!.k).toBeCloseTo(0.8, 5);
    expect(mod("0", { metaKey: true }).defaultPrevented).toBe(true);
    expect(p.transform()).toBe("translate(320px,180px) scale(1)");
    expect(p.keys()).toEqual([]);
    // With Alt too, or another key, they are not the pasteboard's.
    const views = p.views().length;
    expect(mod("=", { ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    expect(p.views()).toHaveLength(views);
  });

  it("restores the view and takes the app's colors", () => {
    const p = pasteboard();
    p.fromParent({ type: "slop:camera", x: -200, y: 50, k: 0.5 });
    expect(p.transform()).toBe("translate(120px,230px) scale(0.5)");
    p.fromParent({ type: "slop:camera", x: "a", y: 0, k: 1 });
    expect(p.transform()).toBe("translate(120px,230px) scale(0.5)");
    p.fromParent({ type: "slop:canvas", color: "rgb(1, 2, 3)", accent: "rgb(4, 5, 6)", border: "rgb(7, 8, 9)" });
    const style = p.doc.documentElement.style;
    expect([
      style.getPropertyValue("--slop-canvas"),
      style.getPropertyValue("--slop-accent"),
      style.getPropertyValue("--slop-border"),
    ]).toEqual(["rgb(1, 2, 3)", "rgb(4, 5, 6)", "rgb(7, 8, 9)"]);
  });

  it("sets every palette color the app sends, and has its own until then", () => {
    const p = pasteboard();
    const css = [...p.doc.querySelectorAll("style")].map((s) => s.textContent).join("");
    const palette: Record<string, string> = {
      danger: "--slop-danger",
      guide: "--slop-guide",
      handle: "--slop-handle",
      handleForeground: "--slop-handle-foreground",
      overlay: "--slop-overlay",
      overlayForeground: "--slop-overlay-foreground",
      scrim: "--slop-scrim",
      search: "--slop-search",
      searchActive: "--slop-search-active",
    };
    p.fromParent({
      type: "slop:canvas",
      ...Object.fromEntries(Object.keys(palette).map((key) => [key, "rgb(1, 2, 3)"])),
    });
    for (const variable of Object.values(palette)) {
      expect(css).toContain(`${variable}: `);
      expect(p.doc.documentElement.style.getPropertyValue(variable)).toBe("rgb(1, 2, 3)");
    }
    p.fromParent({ type: "slop:canvas", danger: 3 });
    expect(p.doc.documentElement.style.getPropertyValue("--slop-danger")).toBe("rgb(1, 2, 3)");
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

    it("zooms with the mouse wheel around the pointer and reports where ink belongs", async () => {
      const p = pasteboard({ show: true });
      const event = new p.window.WheelEvent("wheel", {
        deltaY: -4.000244140625,
        clientX: 1000,
        clientY: 500,
        cancelable: true,
        bubbles: true,
      });
      Object.defineProperty(event, "wheelDeltaY", { value: 12 });
      p.doc.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      await p.frame();
      const { x, y, k } = p.zooms().at(-1)!;
      expect(k).toBeCloseTo(Math.exp(4.000244140625 * 0.005), 5);
      // What lay under the pointer still does, so ink drawn there moves along with the slide.
      expect(x + 1000 * k).toBeCloseTo(1000, 5);
      expect(y + 500 * k).toBeCloseTo(500, 5);
    });

    it("leaves 0 to the player while the slide is fitted, as a digit of a slide number", async () => {
      const p = pasteboard({ show: true });
      const reached: string[] = [];
      p.doc.addEventListener("keydown", (event) => reached.push((event as KeyboardEvent).key));
      p.key("0");
      p.key("Enter");
      expect(reached).toEqual(["0", "Enter"]);
      p.wheel({ ctrlKey: true, deltaY: -60, clientX: 0, clientY: 0 }, 1000);
      await p.frame();
      // Zoomed in, with no number being typed, it fits the slide again and goes no further.
      expect(p.key("0").defaultPrevented).toBe(true);
      expect(reached).toEqual(["0", "Enter"]);
      expect(p.zooms().at(-1)).toEqual({ type: "slop:zoom", x: 0, y: 0, k: 1 });
    });

    it("takes 0 as a digit too while the player says a slide number is being typed", async () => {
      const p = pasteboard({ show: true });
      const reached: string[] = [];
      p.doc.addEventListener("keydown", (event) => reached.push((event as KeyboardEvent).key));
      p.wheel({ ctrlKey: true, deltaY: -60, clientX: 0, clientY: 0 }, 1000);
      await p.frame();
      // "10", then Enter: the slide stays zoomed and the show goes to the slide numbered so.
      p.key("1");
      expect(p.key("0").defaultPrevented).toBe(true);
      expect(reached).toEqual(["1", "0"]);
      expect(p.zooms().at(-1)!.k).toBeCloseTo(Math.exp(0.3), 5);
      expect(p.posted("slop:typed").at(-1)).toEqual({ type: "slop:typed", typed: "10" });
    });

    it("zooms with a mouse notch and a pinch, pans with a swipe, and follows the window's size", async () => {
      const p = pasteboard({ show: true });
      p.wheel({ ctrlKey: true, deltaY: -60, clientX: 0, clientY: 0 }, 1000);
      await p.frame();
      expect(p.zooms().at(-1)).toMatchObject({ x: 0, y: 0 });
      expect(p.zooms().at(-1)!.k).toBeCloseTo(Math.exp(0.3), 5);
      p.wheel({ deltaY: -3, deltaMode: 1, clientX: 0, clientY: 0 }, 2000);
      await p.frame();
      expect(p.zooms().at(-1)!.k).toBeGreaterThan(Math.exp(0.3));
      p.fromParent({ type: "slop:camera", x: 0, y: 0, k: 2 });
      p.wheel({ deltaX: 30, deltaY: 100 }, 3000);
      await p.frame();
      expect(p.transform()).toBe(`translate(-30px,-100px) scale(${8 / 3})`);
      expect(p.zooms().at(-1)).toEqual({ type: "slop:zoom", x: -30, y: -100, k: 2 });
      Object.defineProperty(p.window, "innerWidth", { value: 1920, configurable: true });
      p.window.dispatchEvent(new p.window.Event("resize"));
      // Now letterboxed, 180px down, and still panned.
      expect(p.transform()).toBe("translate(-30px,80px) scale(2)");
    });

    it("moves and shrinks nothing while the slide is fit to the window", async () => {
      const p = pasteboard({ show: true });
      const fit = `translate(0px,0px) scale(${4 / 3})`;
      // A hand resting on the trackpad, a wheel notch down, a pinch together, a middle drag.
      p.wheel({ deltaX: 30, deltaY: 100 }, 1000);
      await p.frame();
      expect(p.transform()).toBe(fit);
      p.wheel({ deltaY: 3, deltaMode: 1, clientX: 500, clientY: 500 }, 2000);
      await p.frame();
      expect(p.transform()).toBe(fit);
      p.wheel({ ctrlKey: true, deltaY: 60, clientX: 500, clientY: 500 }, 3000);
      await p.frame();
      expect(p.transform()).toBe(fit);
      p.drag(p.$("h1"), 50, 20, 1);
      expect(p.transform()).toBe(fit);
      p.fromParent({ type: "slop:camera", x: 40, y: 40, k: 0.5 });
      expect(p.transform()).toBe(fit);
      expect(p.zooms()).toEqual([]);
    });

    it("pans a zoomed slide only as far as its edges, so it always covers its place", async () => {
      const p = pasteboard({ show: true });
      p.fromParent({ type: "slop:camera", x: 0, y: 0, k: 2 });
      // The fitted slide is 2560×1440: at twice that there is one window's width and height to go.
      p.wheel({ deltaX: -500, deltaY: -500 }, 1000);
      await p.frame();
      expect(p.zooms().at(-1)).toEqual({ type: "slop:zoom", x: 0, y: 0, k: 2 });
      p.wheel({ deltaX: 9000, deltaY: 9000 }, 2000);
      await p.frame();
      expect(p.zooms().at(-1)).toEqual({ type: "slop:zoom", x: -2560, y: -1440, k: 2 });
      // Zooming out again brings the slide back into its place.
      p.wheel({ ctrlKey: true, deltaY: 600, clientX: 0, clientY: 0 }, 3000);
      p.wheel({ ctrlKey: true, deltaY: 600, clientX: 0, clientY: 0 }, 3010);
      p.wheel({ ctrlKey: true, deltaY: 600, clientX: 0, clientY: 0 }, 3020);
      await p.frame();
      expect(p.zooms().at(-1)).toEqual({ type: "slop:zoom", x: 0, y: 0, k: 1 });
    });

    it("leaves clicks and Space to the player, and pans a zoomed slide with the middle button", () => {
      const p = pasteboard({ show: true });
      p.drag(p.$("h1"), 50, 0);
      expect(p.transform()).toBe(`translate(0px,0px) scale(${4 / 3})`);
      p.fromParent({ type: "slop:camera", x: -100, y: -100, k: 2 });
      p.drag(p.$("h1"), 50, 20, 1);
      expect(p.zooms().at(-1)).toEqual({ type: "slop:zoom", x: -50, y: -80, k: 2 });
      p.key(" ");
      expect(p.$("#outro").classList.contains("active")).toBe(true);
      expect(p.doc.documentElement.style.cursor).toBe("");
    });

    it("fits each slide the show moves to, and when the app asks", async () => {
      const p = pasteboard({ show: true });
      p.wheel({ ctrlKey: true, deltaY: -60 }, 1000);
      await p.frame();
      p.fromParent({ type: "slop:camera", home: true });
      expect(p.transform()).toBe(`translate(0px,0px) scale(${4 / 3})`);
      p.wheel({ ctrlKey: true, deltaY: -60 }, 2000);
      await p.frame();
      p.click(p.doc.body);
      expect(p.$("#outro").classList.contains("active")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(p.transform()).toBe(`translate(0px,0px) scale(${4 / 3})`);
      expect(p.zooms().at(-1)).toEqual({ type: "slop:zoom", x: 0, y: 0, k: 1 });
    });
  });
});
