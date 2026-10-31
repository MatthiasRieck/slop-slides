/**
 * The slide editor (src-tauri/assets/editor.js) that the backend adds to the stage's slide
 * preview in edit mode. It runs after the player and the pasteboard, in the slide's iframe.
 */
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import EDITOR from "../../src-tauri/assets/editor.js?raw";
import PASTEBOARD from "../../src-tauri/assets/pasteboard.js?raw";
import RUNTIME from "../../src-tauri/assets/runtime.js?raw";
import { placement } from "./placement";

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
  for (const d of doms) d.window.close();
  doms = [];
  vi.useRealTimers();
});

interface Commit {
  type: string;
  slide: string;
  markup: string;
  select: number[] | null;
}

function editor({ slide = "intro", framed = true, markup = DECK } = {}) {
  const posted: unknown[] = [];
  const parent = { postMessage: (data: unknown) => posted.push(data) };
  const dom = new JSDOM(markup, {
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

  it("removes the selection with Delete, leaving an invisible slot so the layout stays put", () => {
    const e = editor();
    e.$(".card p").id = "first";
    e.down(e.$(".card p"));
    e.key("Delete");
    expect(e.doc.querySelector("#first")).toBeNull();
    const [slot, kept] = [...e.doc.querySelectorAll<HTMLElement>(".card p")] as [HTMLElement, HTMLElement];
    expect(kept.textContent).toBe("Two");
    expect(slot.hasAttribute("data-delete-placeholder")).toBe(true);
    expect(slot.hasAttribute("inert")).toBe(true);
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    expect(slot.id).toBe("");
    expect(slot.style).toMatchObject({ visibility: "hidden", flex: "0 0 auto", boxSizing: "border-box" });
    expect(slot.style.width).toMatch(/px$/);
    expect(slot.style.height).toMatch(/px$/);
    const markup = e.commits()[0]!.markup;
    expect(markup).toContain("data-delete-placeholder");
    expect(markup).toContain(`<p style="color: red">Two</p></div>`);
    expect(markup).not.toContain("data-slop-selected");
  });

  it("does not leave a slot for an element outside the layout, or select a slot", () => {
    const e = editor();
    e.$(".shape").style.position = "absolute";
    e.down(e.$(".shape"));
    e.key("Delete");
    expect(e.doc.querySelector(".shape")).toBeNull();
    expect(e.doc.querySelector("[data-delete-placeholder]")).toBeNull();
    e.down(e.$("h1"));
    e.key("Delete");
    const slot = e.$("[data-delete-placeholder]");
    e.down(slot.querySelector("em")!);
    e.up(slot.querySelector("em")!);
    expect(e.selected()).toEqual([]);
  });

  it("removes the selection with Backspace too, and ignores Delete with nothing selected", () => {
    const e = editor();
    e.key("Delete");
    expect(e.commits()).toEqual([]);
    e.down(e.$(".shape"));
    e.key("Backspace");
    expect(e.doc.querySelector(".shape:not([data-delete-placeholder])")).toBeNull();
    expect(e.commits()).toHaveLength(1);
    expect(e.selected()).toEqual([]);
  });

  it("removes the selection when the app asks, ending any text editing first", () => {
    const e = editor();
    e.fromParent({ type: "slop:edit-delete" });
    expect(e.commits()).toEqual([]);
    e.down(e.$(".card p"));
    e.key("Enter");
    expect(e.$(".card p").hasAttribute("contenteditable")).toBe(true);
    e.fromParent({ type: "slop:edit-delete" });
    expect(e.doc.querySelectorAll(".card p:not([data-delete-placeholder])")).toHaveLength(1);
    const last = e.commits().at(-1)!;
    expect(last.markup).toContain(`<p style="color: red">Two</p></div>`);
    expect(last.markup).not.toContain("contenteditable");
  });

  describe("spell-check", () => {
    it("is on only for the text being edited", () => {
      const e = editor();
      const title = e.$("h1");
      e.down(title);
      e.up(title);
      e.key("Enter");
      expect(title.getAttribute("spellcheck")).toBe("true");
      title.textContent = "Helo";
      e.key("Escape");
      expect(title.hasAttribute("spellcheck")).toBe(false);
      expect(e.commits().at(-1)!.markup).toContain("Helo");
      expect(e.commits().at(-1)!.markup).not.toContain("spellcheck");
    });

    it("never lands in the saved markup", () => {
      const e = editor();
      e.$(".card p").setAttribute("spellcheck", "true");
      e.drag(e.$("h1"), 20, 0);
      expect(e.commits()).toHaveLength(1);
      expect(e.commits()[0]!.markup).not.toContain("spellcheck");
    });
  });

  describe("context menu", () => {
    const menus = (e: ReturnType<typeof editor>) =>
      e.posted().filter((m) => (m as { type: string }).type === "slop:edit-menu") as {
        slide: string;
        x: number;
        y: number;
        element: { path: string; markup: string; name: string; added: boolean } | null;
      }[];
    const rightClick = (e: ReturnType<typeof editor>, target: Element, init: MouseEventInit = {}) => {
      const event = new e.window.MouseEvent("contextmenu", {
        clientX: 120,
        clientY: 80,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      target.dispatchEvent(event);
      return event;
    };

    it("selects what is under it and tells the app about it", () => {
      const e = editor();
      const second = e.$(".card p:nth-child(2)");
      const event = rightClick(e, second);
      expect(event.defaultPrevented).toBe(true);
      expect(e.selected()).toEqual([second]);
      expect(menus(e)).toHaveLength(1);
      const menu = menus(e)[0]!;
      expect(menu).toMatchObject({ slide: "intro", x: 120, y: 80 });
      expect(menu.element).toEqual({
        path: "#intro > div:nth-child(2) > p:nth-child(2)",
        markup: `<p style="color: red">Two</p>`,
        name: `<p> "Two"`,
        added: false,
      });
      expect(e.$("#intro").querySelector(menu.element!.path.replace("#intro > ", ":scope > "))).toBe(second);
    });

    it("keeps a selected parent when the click lands inside it", () => {
      const e = editor();
      const card = e.$(".card");
      const first = e.$(".card p");
      e.down(first);
      e.up(first);
      e.key("Escape");
      expect(e.selected()).toEqual([card]);
      rightClick(e, first);
      expect(e.selected()).toEqual([card]);
    });

    it("reports nothing selected on an empty spot, for pasting", () => {
      const e = editor();
      e.down(e.$("h1"));
      e.up(e.$("h1"));
      rightClick(e, e.$("#intro"));
      expect(e.selected()).toEqual([]);
      expect(menus(e)[0]!.element).toBeNull();
    });

    it("says when the element was added by hand", () => {
      const e = editor();
      const dropped = e.$(".shape");
      dropped.setAttribute("data-dropped", "");
      rightClick(e, dropped);
      expect(menus(e)[0]!.element?.added).toBe(true);
      const added = e.$("h1");
      added.setAttribute("data-added", "text");
      rightClick(e, added);
      expect(menus(e)[1]!.element?.added).toBe(true);
    });

    it("leaves the webview's own menu in the text being typed, and finishes typing elsewhere", () => {
      const e = editor();
      const title = e.$("h1");
      e.down(title);
      e.up(title);
      e.key("Enter");
      expect(rightClick(e, title).defaultPrevented).toBe(false);
      expect(menus(e)).toEqual([]);
      expect(rightClick(e, e.$(".shape")).defaultPrevented).toBe(true);
      expect(title.hasAttribute("contenteditable")).toBe(false);
      expect(menus(e)).toHaveLength(1);
    });

    it("stays out of the way of a drawing tool", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "rect" });
      expect(rightClick(e, e.$("h1")).defaultPrevented).toBe(true);
      expect(menus(e)).toEqual([]);
    });

    it("drops the drag a Control-click started", () => {
      const e = editor();
      const title = e.$("h1");
      e.down(title);
      rightClick(e, title, { ctrlKey: true });
      e.move(title, 160, 160);
      e.up(title, 160, 160);
      expect(title.getAttribute("style") ?? "").not.toContain("translate");
      expect(e.commits()).toEqual([]);
    });

    it("saves a nudge first, so the screenshot and the markup agree", () => {
      const e = editor();
      const title = e.$("h1");
      e.down(title);
      e.up(title);
      e.key("ArrowRight");
      expect(e.commits()).toEqual([]);
      rightClick(e, title);
      expect(e.commits()).toHaveLength(1);
      expect(menus(e)[0]!.element?.markup).toContain("translate");
    });
  });

  describe("dropped images", () => {
    const drop = (e: ReturnType<typeof editor>, images: unknown, x = 960, y = 540) =>
      e.fromParent({ type: "slop:edit-insert-images", images, x, y });

    it("puts them on top of the slide, centered where they landed and fit to it, and saves once", () => {
      const e = editor();
      drop(e, [{ src: "assets/wide.png", w: 1280, h: 720 }, { src: "assets/icon.svg" }]);
      const [wide, icon] = [...e.doc.querySelectorAll<HTMLImageElement>("#intro > img")] as [
        HTMLImageElement,
        HTMLImageElement,
      ];
      // Fit to a third of the slide's width: 640×360, centered on (960, 540).
      expect(wide.getAttribute("src")).toBe("assets/wide.png");
      expect(wide.getAttribute("alt")).toBe("");
      expect(wide.hasAttribute("data-dropped")).toBe(true);
      expect(wide.hasAttribute("data-moved")).toBe(true);
      expect(wide.style.position).toBe("absolute");
      expect([wide.style.left, wide.style.top, wide.style.width]).toEqual(["0px", "0px", "640px"]);
      expect(wide.style.translate).toBe("640px 360px");
      // Without a known size it gets the default width, its top at the drop point, fanned out.
      expect(icon.style.width).toBe("640px");
      expect(icon.style.translate).toBe("680px 580px");
      expect(e.$("#intro").lastElementChild).toBe(icon);
      expect(e.selected()).toEqual([icon]);
      expect(e.commits()).toHaveLength(1);
      const commit = e.commits()[0]!;
      expect(commit.select).toEqual([e.$("#intro").children.length - 1]);
      expect(commit.markup).toContain('src="assets/wide.png" alt="" data-dropped=""');
      expect(commit.markup).not.toContain("data-slop-selected");
    });

    it("keeps small images at their own size", () => {
      const e = editor();
      drop(e, [{ src: "assets/logo.png", w: 200, h: 100 }], 300, 200);
      const img = e.$("#intro > img");
      expect(img.style.width).toBe("200px");
      expect(img.style.translate).toBe("200px 150px");
    });

    it("can be moved like any hand-moved element", () => {
      const e = editor();
      drop(e, [{ src: "assets/logo.png", w: 200, h: 100 }], 300, 200);
      e.drag(e.$("#intro > img"), 10, 20);
      expect(e.$("#intro > img").style.translate).toBe("210px 170px");
      expect(e.commits()).toHaveLength(2);
    });

    it("ends text editing first", () => {
      const e = editor();
      e.down(e.$(".card p"));
      e.key("Enter");
      drop(e, [{ src: "assets/logo.png", w: 200, h: 100 }]);
      expect(e.$(".card p").hasAttribute("contenteditable")).toBe(false);
      expect(e.commits().at(-1)!.markup).not.toContain("contenteditable");
    });

    it("tells the app about a press, so what is open there closes", () => {
      const e = editor();
      e.down(e.$(".card p"));
      expect(e.posted()).toContainEqual({ type: "slop:edit-press" });
    });

    it("reports the dropped image to the edit toolbar as media", () => {
      const e = editor();
      drop(e, [{ src: "assets/logo.png", w: 200, h: 100 }]);
      const reports = e.posted().filter((m) => (m as { type: string }).type === "slop:edit-selection");
      expect(reports.at(-1)).toMatchObject({
        slide: "intro",
        selected: true,
        selection: { kind: "media", text: false, vector: false },
      });
    });

    it("only takes files from the deck's assets", () => {
      const e = editor();
      drop(e, [{ src: "https://example.com/x.png" }, { src: "javascript:alert(1)" }, null, { src: 3 }]);
      drop(e, "assets/a.png");
      e.fromParent({ type: "slop:edit-insert-images", images: [{ src: "assets/a.png" }], x: "left", y: 0 });
      expect(e.doc.querySelector("#intro > img")).toBeNull();
      expect(e.commits()).toEqual([]);
    });
  });

  describe("copy and paste", () => {
    interface Copied {
      type: string;
      slide: string;
      html: string;
      text: string;
    }
    const copied = (e: ReturnType<typeof editor>) =>
      e.posted().filter((m) => (m as Copied).type === "slop:edit-copied") as Copied[];
    const header = (html: string) => JSON.parse(/^<!--slopslides:(.*?)-->/.exec(html)![1]!);
    const FREE = DECK.replace(
      '<div class="shape"',
      '<div class="note" style="position: absolute; left: 100px; top: 50px">Note</div><div class="shape"',
    );

    it("copies the selection with ⌘C / Ctrl+C, with where it came from, without saving", () => {
      const e = editor();
      e.down(e.$("h1"));
      const event = e.key("c", { metaKey: true });
      expect(event.defaultPrevented).toBe(true);
      const [copy] = copied(e);
      expect(copy).toMatchObject({ slide: "intro", text: "Hello there" });
      expect(copy!.html).toMatch(/^<!--slopslides:\{.*\}--><h1 class="title">Hello <em>there<\/em><\/h1>$/);
      expect(header(copy!.html)).toMatchObject({ slide: "intro", path: [0], free: false });
      expect(header(copy!.html).look).toBeTypeOf("object");
      // The editor copies by itself; the key does not go on to the app.
      expect(e.keys()).toEqual([]);
      expect(e.commits()).toEqual([]);
      e.key("c", { ctrlKey: true });
      expect(copied(e)).toHaveLength(2);
    });

    it("keeps `-->` in a copied element's styles from ending the header early", () => {
      const e = editor({ markup: DECK.replace('class="title"', 'class="title" style="font-family: \'a-->b\'"') });
      e.down(e.$("h1"));
      e.key("c", { metaKey: true });
      const html = copied(e)[0]!.html;
      expect(header(html).look.fontFamily).toContain("a-->b");
    });

    it("copies nothing without a selection, and leaves ⌘V to the app", () => {
      const e = editor();
      e.key("c", { metaKey: true });
      expect(copied(e)).toEqual([]);
      const paste = e.key("v", { metaKey: true });
      expect(paste.defaultPrevented).toBe(true);
      expect(e.keys()).toContainEqual(expect.objectContaining({ key: "v", mod: true }));
    });

    it("cuts with ⌘X, or copies or cuts when the app asks", () => {
      const e = editor();
      e.down(e.$("h1"));
      e.fromParent({ type: "slop:edit-copy", cut: false });
      expect(copied(e)).toHaveLength(1);
      expect(e.doc.querySelector("h1")).not.toBeNull();
      e.key("x", { metaKey: true });
      expect(copied(e)).toHaveLength(2);
      // Like a deletion, a cut leaves an invisible slot so the layout stays put.
      expect(e.doc.querySelector("h1:not([data-delete-placeholder])")).toBeNull();
      expect(e.doc.querySelector("h1[data-delete-placeholder]")).not.toBeNull();
      expect(e.commits()).toHaveLength(1);
      expect(e.selected()).toEqual([]);
      e.down(e.$(".card p"));
      e.fromParent({ type: "slop:edit-copy", cut: true });
      expect(e.$(".card").querySelectorAll(":scope > :not([data-delete-placeholder])")).toHaveLength(1);
    });

    // A copied element's markup with a header, as copySelected writes it.
    const clip = (box: object, element: string, rest: object = {}) =>
      `<!--slopslides:${JSON.stringify({ slide: "intro", path: [0], free: false, box, look: {}, ...rest })}-->${element}`;
    // jsdom has no layout: put the slide at the top left of the window, at full size.
    const onScreen = (e: ReturnType<typeof editor>, id = "intro") => {
      const rect = { left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080, x: 0, y: 0 };
      e.$(`#${id}`).getBoundingClientRect = () => ({ ...rect, toJSON: () => rect }) as DOMRect;
    };

    it("pastes a copy on top of the slide in the middle of the view, leaving the layout as it was", () => {
      const e = editor();
      onScreen(e);
      const card = e.$(".card").outerHTML;
      const html = clip({ x: 10, y: 20, w: 200, h: 100 }, '<p style="translate: 5px 5px">One</p>');
      e.fromParent({ type: "slop:edit-paste", html });
      const copy = e.$("#intro").lastElementChild as HTMLElement;
      expect(copy.textContent).toBe("One");
      // Nothing in the layout moved.
      expect(e.$(".card").outerHTML).toBe(card);
      expect(copy.style.position).toBe("absolute");
      // Centered on (960, 540); its place is all in left and top.
      expect([copy.style.left, copy.style.top, copy.style.width]).toEqual(["860px", "490px", "200px"]);
      expect(copy.style.translate).toBe("");
      expect(e.selected()).toEqual([copy]);
      expect(e.commits()).toHaveLength(1);
      expect(e.commits()[0]!.select).toEqual([e.$("#intro").children.length - 1]);
    });

    it("pastes where the pointer is when it is over the slide", () => {
      const e = editor();
      onScreen(e);
      const html = clip({ x: 0, y: 0, w: 200, h: 100 }, '<div data-added="shape"></div>');
      e.move(e.$(".shape"), 300, 400);
      e.fromParent({ type: "slop:edit-paste", html });
      const shape = e.$("#intro").lastElementChild as HTMLElement;
      expect([shape.style.left, shape.style.top, shape.style.width, shape.style.height]).toEqual([
        "200px",
        "350px",
        "200px",
        "100px",
      ]);
    });

    it("pastes in the middle of the view once the pointer is off the slide or out of the window", () => {
      const e = editor();
      onScreen(e);
      const html = clip({ x: 0, y: 0, w: 200, h: 100 }, '<div data-added="shape"></div>');
      e.move(e.doc.body, 1950, 400);
      e.fromParent({ type: "slop:edit-paste", html });
      expect((e.$("#intro").lastElementChild as HTMLElement).style.left).toBe("860px");
      e.move(e.doc.body, 300, 400);
      e.doc.documentElement.dispatchEvent(new e.window.PointerEvent("pointerleave"));
      e.fromParent({ type: "slop:edit-paste", html });
      const second = e.$("#intro").lastElementChild as HTMLElement;
      expect([second.style.left, second.style.translate]).toEqual(["860px", "40px 40px"]);
    });

    it("offsets copies pasted at the same spot, further for each copy", () => {
      const e = editor({ markup: FREE });
      onScreen(e);
      e.down(e.$(".note"));
      e.key("c", { metaKey: true });
      const html = copied(e)[0]!.html;
      e.fromParent({ type: "slop:edit-paste", html });
      e.fromParent({ type: "slop:edit-paste", html });
      const notes = [...e.doc.querySelectorAll<HTMLElement>(".note")];
      expect(notes.map((n) => n.style.translate)).toEqual(["", "", "40px 40px"]);
      expect(notes[1]!.style.left).toBe(notes[2]!.style.left);
      expect(notes[0]!.style.left).toBe("100px");
      expect(e.commits()).toHaveLength(2);
    });

    it("pastes a cut element on top, keeping the slot the cut left so the layout stays put", () => {
      const e = editor();
      onScreen(e);
      e.down(e.$(".card p"));
      e.key("x", { metaKey: true });
      const card = e.$(".card");
      expect(card.firstElementChild!.hasAttribute("data-delete-placeholder")).toBe(true);
      e.fromParent({ type: "slop:edit-paste", html: copied(e)[0]!.html });
      expect(card.children).toHaveLength(2);
      expect(card.firstElementChild!.hasAttribute("data-delete-placeholder")).toBe(true);
      const pasted = e.$("#intro").lastElementChild as HTMLElement;
      expect(pasted.textContent).toBe("One");
      expect(pasted.style.position).toBe("absolute");
    });

    it("pastes onto another slide looking as it did", () => {
      const e = editor({ slide: "outro" });
      onScreen(e, "outro");
      const html = clip(
        { x: 100, y: 200, w: 300, h: 50 },
        '<p class="tag" id="intro" style="translate: 5px 5px; color: blue">Tag</p>',
        { path: [1, 0], look: { color: "rgb(1, 2, 3)", fontSize: "40px" } },
      );
      e.fromParent({ type: "slop:edit-paste", html });
      const p = e.$("#outro > p.tag");
      expect(e.$("#outro").lastElementChild).toBe(p);
      expect(p.style.position).toBe("absolute");
      // Text may wrap differently here, so it keeps its width but not its height.
      expect([p.style.left, p.style.top, p.style.width, p.style.height]).toEqual(["810px", "515px", "300px", ""]);
      expect(p.style.translate).toBe("");
      // Its own inline styles win over how it looked.
      expect([p.style.color, p.style.fontSize]).toEqual(["blue", "40px"]);
      // The slide's id is taken.
      expect(p.hasAttribute("id")).toBe(false);
      expect(e.selected()).toEqual([p]);
      expect(e.commits()).toHaveLength(1);
    });

    it("pastes images where the pointer is, as dropped ones", () => {
      const e = editor();
      onScreen(e);
      e.move(e.$(".shape"), 400, 300);
      e.fromParent({ type: "slop:edit-paste-images", images: [{ src: "assets/pasted.png", w: 200, h: 100 }] });
      const img = e.$("#intro > img");
      expect(img.hasAttribute("data-dropped")).toBe(true);
      expect(img.style.translate).toBe("300px 250px");
      expect(e.commits()).toHaveLength(1);
    });

    it("pastes only what the editor copied", () => {
      const e = editor();
      for (const html of ["<p>Plain</p>", "<!--slopslides:not json--><p>X</p>", "<!--slopslides:{}-->", 3, null]) {
        e.fromParent({ type: "slop:edit-paste", html });
      }
      expect(e.commits()).toEqual([]);
    });

    it("pastes text where the pointer is when it is over the slide", () => {
      const e = editor();
      onScreen(e);
      e.move(e.$(".shape"), 300, 400);
      e.fromParent({ type: "slop:edit-paste-text", text: "Here" });
      const box = e.$("[data-added=text]");
      expect([box.style.left, box.style.top]).toEqual(["300px", "400px"]);
    });

    it("pastes text as a new text box in the middle of the view, styled like new ones", () => {
      const e = editor();
      e.fromParent({
        type: "slop:edit-paste-text",
        text: "First line\r\nSecond <b>line</b>\n\n",
        style: { fontSize: 64, color: "#ff0000" },
      });
      const box = e.$("[data-added=text]");
      expect(box.innerHTML).toBe("First line<br>Second &lt;b&gt;line&lt;/b&gt;");
      expect(box.style.fontSize).toBe("64px");
      expect(box.style.color).toBe("rgb(255, 0, 0)");
      expect(box.style.position).toBe("absolute");
      expect([box.style.left, box.style.top]).toEqual(["960px", "540px"]);
      expect(e.selected()).toEqual([box]);
      expect(e.commits()).toHaveLength(1);
      // Blank text adds nothing.
      e.fromParent({ type: "slop:edit-paste-text", text: "  \n " });
      expect(e.doc.querySelectorAll("[data-added=text]")).toHaveLength(1);
    });
  });

  it("tells the app whether anything is selected, whenever the selection changes", () => {
    const e = editor();
    const reports = () =>
      e.posted().filter((m) => (m as { type: string }).type === "slop:edit-selection") as {
        slide: string;
        selected: boolean;
        selection: unknown;
      }[];
    e.down(e.$("h1"));
    e.down(e.$("h1"));
    e.down(e.$(".card p"));
    // Selecting, starting and ending text editing (the toolbar shows the text's styles), selecting.
    expect(reports().map((r) => [r.slide, r.selected, (r.selection as { editing: boolean }).editing])).toEqual([
      ["intro", true, false],
      ["intro", true, true],
      ["intro", true, false],
      ["intro", true, false],
    ]);
    e.key("Delete");
    expect(reports().at(-1)).toEqual({ type: "slop:edit-selection", slide: "intro", selected: false, selection: null });
    expect(reports()).toHaveLength(5);
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
    const second = new e.window.PointerEvent("pointerdown", {
      clientX: 100,
      clientY: 100,
      button: 0,
      bubbles: true,
      cancelable: true,
    });
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
    function withHeading(mode: "resize" | "stretch" = "stretch") {
      const e = editor();
      if (mode === "stretch") e.fromParent({ type: "slop:edit-size-mode", mode });
      const h1 = e.$("h1");
      Object.defineProperty(h1, "offsetWidth", { value: 200, configurable: true });
      Object.defineProperty(h1, "offsetHeight", { value: 100, configurable: true });
      h1.getBoundingClientRect = () => new e.window.DOMRect(400, 250, 200, 100);
      e.down(h1);
      e.up(h1);
      const ui = e.$("[data-slop-ui]");
      /** "rotate", "tilt", or a stretch handle by direction from the center, like "1 1" (bottom right). */
      const handle = (kind: string) =>
        ui.querySelector<HTMLElement>(/^[a-z]+$/.test(kind) ? `[data-handle="${kind}"]` : `[data-dir="${kind}"]`)!;
      const pointer = (type: string, target: Element, x: number, y: number, init: PointerEventInit = {}) =>
        target.dispatchEvent(
          new e.window.PointerEvent(type, {
            clientX: x,
            clientY: y,
            button: 0,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
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
      expect([ui.style.left, ui.style.top, ui.style.width, ui.style.height]).toEqual([
        "400px",
        "250px",
        "200px",
        "100px",
      ]);
      expect(ui.querySelectorAll('[data-handle="scale"]')).toHaveLength(8);
      expect(ui.querySelectorAll("[data-axis]")).toHaveLength(4);
      expect(handle("rotate")).toBeTruthy();
      expect(e.$("#intro").contains(ui)).toBe(false);
      e.down(e.$("#intro"));
      expect(ui.style.display).toBe("none");
    });

    it("resizes the text box by default without stretching the glyphs", () => {
      const { h1, pull, e } = withHeading("resize");
      h1.style.fontSize = "48px";
      h1.style.whiteSpace = "nowrap";
      pull("1 1", [600, 350], [650, 400]);
      expect(h1.style).toMatchObject({
        width: "250px",
        height: "150px",
        scale: "",
        translate: "",
        fontSize: "48px",
        whiteSpace: "normal",
      });
      expect(e.commits()[0]!.markup).toContain("width: 250px");
      expect(h1.hasAttribute("viewBox")).toBe(false);
    });

    it("reserves the original footprint once, saves it, and keeps it when reselecting", () => {
      const { h1, pull, e } = withHeading("resize");
      h1.id = "unique-heading";
      h1.style.fontSize = "48px";
      h1.style.flex = "1 1 200px";
      pull("1 0", [600, 300], [650, 300]);
      const slot = h1.nextElementSibling as HTMLElement;
      expect(slot.hasAttribute("data-resize-placeholder")).toBe(true);
      expect(slot.style).toMatchObject({ width: "200px", height: "100px", flex: "0 0 auto", visibility: "hidden" });
      expect(slot.hasAttribute("inert")).toBe(true);
      expect(slot.getAttribute("aria-hidden")).toBe("true");
      expect(slot.querySelector("[id], [data-slop-selected]")).toBeNull();
      expect(slot.id).toBe("");
      expect(h1.style.position).toBe("absolute");
      expect(e.doc.querySelectorAll("#unique-heading")).toHaveLength(1);
      expect(e.commits().at(-1)!.markup).toContain("data-resize-placeholder");
      expect(e.commits().at(-1)!.markup).not.toContain("data-slop-selected");
      e.fromParent({ type: "slop:edit-select", path: e.commits().at(-1)!.select });
      expect(e.selected()).toEqual([h1]);
      pull("1 0", [650, 300], [700, 300]);
      expect(e.doc.querySelectorAll("[data-resize-placeholder]")).toHaveLength(1);
      expect(slot.style.width).toBe("200px");
      e.fromParent({ type: "slop:edit-delete" });
      expect(e.doc.querySelectorAll("[data-resize-placeholder]")).toHaveLength(0);
      expect(e.doc.querySelector("#unique-heading")).toBeNull();
      // Its slot stays, now marking the deletion, with the original footprint.
      expect([...e.doc.querySelectorAll("[data-delete-placeholder]")]).toEqual([slot]);
      expect(slot.style.width).toBe("200px");
    });

    it("restores the layout slot after reload and moves the visible element independently", () => {
      const { e, pull } = withHeading("resize");
      pull("1 0", [600, 300], [650, 300]);
      const saved = e.commits().at(-1)!;
      const reloaded = editor({ markup: `<main class="deck">${saved.markup}</main>` });
      reloaded.fromParent({ type: "slop:edit-select", path: saved.select });
      const heading = reloaded.$("h1");
      const slot = heading.nextElementSibling as HTMLElement;
      const frozen = slot.getAttribute("style");
      expect(reloaded.selected()).toEqual([heading]);
      reloaded.drag(heading, 30, 20);
      expect(heading.style.translate).toBe("30px 20px");
      reloaded.drag(reloaded.$('[data-dir="1 0"]'), 50, 0);
      expect(heading.style.width).toBe("300px");
      expect(slot.getAttribute("style")).toBe(frozen);
      expect(reloaded.doc.querySelectorAll("[data-resize-placeholder]")).toHaveLength(1);
      reloaded.fromParent({ type: "slop:edit-delete" });
      expect(reloaded.doc.querySelector("[data-resize-placeholder]")).toBeNull();
      expect(reloaded.doc.querySelectorAll("[data-delete-placeholder]")).toHaveLength(1);
    });

    it("does not reserve space on a handle click, a stretch, or an already free element", () => {
      const { e, h1, handle, pull } = withHeading("resize");
      e.down(handle("1 0"));
      e.up(handle("1 0"));
      expect(e.doc.querySelector("[data-resize-placeholder]")).toBeNull();
      h1.style.position = "absolute";
      pull("1 0", [600, 300], [650, 300]);
      expect(e.doc.querySelector("[data-resize-placeholder]")).toBeNull();
      const stretched = withHeading("stretch");
      stretched.pull("1 0", [600, 300], [650, 300]);
      expect(stretched.e.doc.querySelector("[data-resize-placeholder]")).toBeNull();
    });

    it("does not select a placeholder or its descendants", () => {
      const { e, h1, pull } = withHeading("resize");
      pull("1 0", [600, 300], [650, 300]);
      e.down(e.$("#intro"));
      const slot = h1.nextElementSibling!;
      e.down(slot.querySelector("em")!);
      e.up(slot.querySelector("em")!);
      expect(e.selected()).toEqual([]);
    });

    it("accounts for padding and borders in a content box", () => {
      const { h1, pull } = withHeading("resize");
      h1.style.cssText = "box-sizing: content-box; padding: 10px; border: 2px solid red";
      pull("1 0", [600, 300], [650, 300]);
      expect(h1.style).toMatchObject({ width: "226px", height: "76px", borderWidth: "2px", scale: "" });
    });

    it("preserves an existing stretch when resizing the box", () => {
      const { h1, pull } = withHeading("resize");
      h1.style.scale = "2 1";
      pull("-1 0", [300, 300], [200, 300]);
      expect(h1.style).toMatchObject({ width: "250px", height: "100px", scale: "2 1", translate: "-75px 0px" });
    });

    it("keeps the opposite edge fixed when resizing a rotated box", () => {
      const { h1, pull } = withHeading("resize");
      h1.style.rotate = "90deg";
      pull("1 0", [500, 400], [500, 450]);
      expect(h1.style).toMatchObject({ width: "250px", height: "100px", scale: "", translate: "-25px 25px" });
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
      handle("rotate").dispatchEvent(
        new e.window.PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }),
      );
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

    it("tilts the selection in 3D with perspective, the side pulled towards turning away", () => {
      const { e, h1, ui, pull } = withHeading();
      // Right by 60px and up by 20px: around the vertical axis by 30°, the horizontal by 10°.
      pull("tilt", [520, 200], [580, 180]);
      expect(h1.style.transform).toBe("perspective(1000px) rotateX(10deg) rotateY(30deg)");
      expect(h1.style.getPropertyPriority("transform")).toBe("important");
      expect(h1.hasAttribute("data-moved")).toBe(true);
      // The frame and stretch handles tilt along; the rotate and tilt handles stay flat.
      const plane = ui.querySelector<HTMLElement>("[data-plane]")!;
      expect(plane.style.transform).toBe("perspective(1000px) rotateX(10deg) rotateY(30deg)");
      expect(plane.querySelectorAll('[data-handle="scale"]')).toHaveLength(8);
      expect(plane.querySelector('[data-handle="rotate"], [data-handle="tilt"]')).toBeNull();
      expect(ui.style.transform).toBe("rotate(0deg)");
      const [commit] = e.commits();
      expect(commit!.markup).toContain(
        `style="transform: perspective(1000px) rotateX(10deg) rotateY(30deg) !important;" data-moved="">Hello`,
      );
      // Further from where it was, snapping each axis to 15° with Shift.
      pull("tilt", [520, 200], [520, 160], { shiftKey: true });
      expect(h1.style.transform).toBe("perspective(1000px) rotateX(30deg) rotateY(30deg)");
      expect(e.commits()).toHaveLength(2);
    });

    it("tilts along a rotated element's own axes, and keeps its rotation", () => {
      const { h1, pull } = withHeading();
      h1.style.rotate = "90deg";
      // Turned a quarter, dragging down pulls towards the element's right side.
      pull("tilt", [520, 200], [520, 240]);
      expect(h1.getAttribute("style")).toBe(
        "rotate: 90deg; transform: perspective(1000px) rotateX(0deg) rotateY(20deg) !important;",
      );
    });

    it("drops the tilt when turned back or the tilt handle is double-clicked", () => {
      const { e, h1, handle, pull } = withHeading();
      pull("tilt", [520, 200], [580, 200]);
      pull("tilt", [580, 200], [520, 200]);
      expect(h1.hasAttribute("style")).toBe(false);
      expect(h1.hasAttribute("data-moved")).toBe(false);
      pull("tilt", [520, 200], [520, 300]);
      pull("rotate", [500, 200], [600, 300]);
      handle("tilt").dispatchEvent(new e.window.MouseEvent("dblclick", { bubbles: true }));
      expect(h1.getAttribute("style")).toBe("rotate: 90deg;");
      expect(e.$("[data-plane]").style.transform).toBe("");
    });

    it("keeps a transform the element already had, behind the tilt", () => {
      const { e, h1, pull } = withHeading();
      const sheet = e.doc.createElement("style");
      sheet.textContent = ".title { transform: translateX(-50%); }";
      e.doc.head.appendChild(sheet);
      pull("tilt", [520, 200], [550, 200]);
      expect(h1.style.transform).toBe("perspective(1000px) rotateX(0deg) rotateY(15deg) translateX(-50%)");
      pull("tilt", [550, 200], [520, 200]);
      expect(h1.hasAttribute("style")).toBe(false);
      // Nothing to keep from the identity matrix a finished entrance animation leaves.
      sheet.textContent = ".title { transform: matrix(1, 0, 0, 1, 0, 0); }";
      pull("tilt", [520, 200], [550, 200]);
      expect(h1.style.transform).toBe("perspective(1000px) rotateX(0deg) rotateY(15deg)");
      pull("tilt", [550, 200], [520, 200]);
      expect(h1.hasAttribute("style")).toBe(false);
      // A transform set inline by the deck stays inline.
      h1.setAttribute("style", "transform: scaleX(-1)");
      pull("tilt", [520, 200], [550, 200]);
      expect(h1.style.transform).toBe("perspective(1000px) rotateX(0deg) rotateY(15deg) scaleX(-1)");
      pull("tilt", [550, 200], [520, 200]);
      expect(h1.getAttribute("style")).toBe("transform: scaleX(-1);");
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
      e.posted().filter((m) => (m as { type: string }).type === "slop:view") as {
        slide: string;
        x: number;
        y: number;
        k: number;
      }[];
    // Wheel events carry their time so tests can say which belong to one gesture; by default
    // each call starts a new one.
    let clock = 0;
    const wheel = (
      e: ReturnType<typeof editor>,
      init: WheelEventInit,
      extra: { wheelDeltaY?: number; sameGesture?: boolean } = {},
    ) => {
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
      expect(placement(deck)).toBe("translate(0px,0px) scale(1)");
      resize(e, 2560, 1440);
      expect(placement(deck)).toBe("translate(320px,180px) scale(1)");
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
      expect(css).toMatch(
        /\[data-slop-frame\] \{ outline: 2px solid var\(--slop-accent[^}]*outline-offset: 4px[^}]*var\(--slop-canvas/,
      );
      // One frame, which the pasteboard moves with the slide.
      expect(e.doc.querySelectorAll("[data-slop-frame]")).toHaveLength(1);
      e.fromParent({ type: "slop:camera", x: 30, y: 40, k: 0.5 });
      expect(e.$("[data-slop-frame]").style.cssText).toContain("left: 30px");
      expect(e.$("[data-slop-frame]").style.cssText).toContain("width: 960px");
    });

    it("does nothing without the pasteboard", () => {
      const dom = new JSDOM(DECK, {
        url: "https://example.test/deck.html?embed&slide=intro&static&edit=0",
        runScripts: "outside-only",
      });
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
      expect(placement(e.$(".deck"))).toContain("translate(0px,0px)");
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
      expect(placement(e.$(".deck"))).toContain("translate(0px,0px)");
    });

    it("pans when swiping on a trackpad, without limit", () => {
      const e = editor();
      const event = wheel(e, { deltaX: 30, deltaY: 100 });
      expect(event.defaultPrevented).toBe(true);
      expect(placement(e.$(".deck"))).toBe("translate(-30px,-100px) scale(1)");
      expect(views(e).at(-1)).toEqual({ type: "slop:view", slide: "intro", x: -30, y: -100, k: 1 });
      // Purely vertical swipes pan too; Chromium reports their wheelDelta as 3× the pixels.
      wheel(e, { deltaY: 7 }, { wheelDeltaY: -21 });
      expect(placement(e.$(".deck"))).toBe("translate(-30px,-107px) scale(1)");
      for (let i = 0; i < 50; i++) wheel(e, { deltaY: -400 });
      expect(placement(e.$(".deck"))).toBe("translate(-30px,19893px) scale(1)");
      expect(e.commits()).toEqual([]);
    });

    it("keeps a trackpad swipe a pan even when one of its events looks like a mouse notch", () => {
      const e = editor();
      wheel(e, { deltaY: 5 }, { wheelDeltaY: -15 });
      wheel(e, { deltaY: 40 }, { wheelDeltaY: -120, sameGesture: true });
      expect(placement(e.$(".deck"))).toBe("translate(0px,-45px) scale(1)");
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
      expect(placement(e.$(".deck"))).toBe("translate(50px,30px) scale(1)");
      e.up(e.doc.body, 60, 40);
      e.move(e.doc.body, 200, 200);
      expect(placement(e.$(".deck"))).toBe("translate(50px,30px) scale(1)");
      expect(e.commits()).toEqual([]);
    });

    it("pans with the middle button or with Space held, without moving the element under the pointer", () => {
      const e = editor();
      const h1 = e.$("h1");
      h1.dispatchEvent(
        new e.window.PointerEvent("pointerdown", {
          clientX: 10,
          clientY: 10,
          button: 1,
          bubbles: true,
          cancelable: true,
        }),
      );
      e.move(h1, 30, 10);
      e.up(h1, 30, 10);
      expect(placement(e.$(".deck"))).toBe("translate(20px,0px) scale(1)");
      expect(h1.style.translate).toBe("");
      const space = e.key(" ");
      expect(space.defaultPrevented).toBe(true);
      expect(e.doc.documentElement.style.cursor).toBe("grab");
      e.down(h1, 0, 0);
      e.move(h1, 5, 5);
      e.up(h1, 5, 5);
      expect(placement(e.$(".deck"))).toBe("translate(25px,5px) scale(1)");
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
      h1.dispatchEvent(
        new e.window.PointerEvent("pointerdown", {
          clientX: 0,
          clientY: 0,
          button: 1,
          bubbles: true,
          cancelable: true,
        }),
      );
      e.move(h1, 40, 20);
      e.up(h1, 40, 20);
      expect(placement(e.$(".deck"))).toBe("translate(40px,20px) scale(1)");
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
      expect(placement(e.$(".deck"))).toBe("translate(0px,-50px) scale(1)");
      expect(e.doc.documentElement.style.cursor).toBe("");
    });

    it("returns to the slide with 0 or when the app asks", () => {
      const e = editor();
      wheel(e, { deltaY: 100 });
      notch(e, -1);
      const zero = e.key("0");
      expect(zero.defaultPrevented).toBe(true);
      expect(placement(e.$(".deck"))).toBe("translate(0px,0px) scale(1)");
      expect(views(e).at(-1)).toEqual({ type: "slop:view", slide: "intro", x: 0, y: 0, k: 1 });
      wheel(e, { deltaX: 100 });
      e.fromParent({ type: "slop:camera", home: true });
      expect(placement(e.$(".deck"))).toBe("translate(0px,0px) scale(1)");
    });

    it("restores a view the app sends back after a reload, ignoring nonsense", () => {
      const e = editor();
      e.fromParent({ type: "slop:camera", x: -200, y: 50, k: 0.5 });
      expect(placement(e.$(".deck"))).toBe("translate(-200px,50px) scale(0.5)");
      expect(e.$("[data-slop-frame]").style.cssText).toContain("width: 960px");
      e.fromParent({ type: "slop:camera", x: "a", y: 0, k: 1 });
      expect(placement(e.$(".deck"))).toBe("translate(-200px,50px) scale(0.5)");
    });

    it("keeps the slide centered when the preview resizes, relative to the pan", () => {
      const e = editor();
      wheel(e, { deltaX: -40 });
      resize(e, 2560, 1440);
      expect(placement(e.$(".deck"))).toBe("translate(360px,180px) scale(1)");
    });

    it("reports overflow in slide pixels whatever the zoom", async () => {
      const e = editor();
      e.fromParent({ type: "slop:camera", x: 0, y: 0, k: 0.5 });
      e.$("#intro").getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 960, bottom: 540, width: 960, height: 540 }) as DOMRect;
      Object.defineProperty(e.$("#intro"), "offsetWidth", { value: 1920, configurable: true });
      e.$("h1").getBoundingClientRect = () =>
        ({ left: 50, top: 500, right: 300, bottom: 640, width: 250, height: 140 }) as DOMRect;
      e.key("Tab");
      await new Promise((resolve) => setTimeout(resolve, 40));
      const report = e
        .posted()
        .filter((m) => (m as { type: string }).type === "slop:edit-overflow")
        .at(-1) as { items: string[] };
      expect(report.items[0]).toContain("runs past the bottom edge by 200px");
    });
  });

  describe("overflow", () => {
    const rect = (left: number, top: number, right: number, bottom: number) =>
      ({
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
        x: left,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
    const overflows = (e: ReturnType<typeof editor>) =>
      e.posted().filter((m) => (m as { type: string }).type === "slop:edit-overflow") as {
        slide: string;
        items: string[];
      }[];

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
    const SHAPE_STYLE = {
      color: "#ffffff",
      fontSize: 40,
      align: "center",
      valign: "middle",
      fill: "#3b82f6",
      stroke: null,
      strokeWidth: 0,
    };
    const TEXT_STYLE = {
      color: "#111111",
      fontSize: 48,
      align: "left",
      valign: "top",
      fill: null,
      stroke: null,
      strokeWidth: 0,
    };
    const DRAW_STYLE = { fill: null, stroke: "#ef4444", strokeWidth: 6 };
    const at = (e: ReturnType<typeof editor>, type: string, x: number, y: number, init: PointerEventInit = {}) =>
      e.$("#intro").dispatchEvent(
        new e.window.PointerEvent(type, {
          clientX: x,
          clientY: y,
          button: 0,
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    const dragOut = (
      e: ReturnType<typeof editor>,
      from: [number, number],
      to: [number, number],
      init: PointerEventInit = {},
    ) => {
      at(e, "pointerdown", ...from);
      at(e, "pointermove", ...to, init);
      at(e, "pointerup", ...to);
    };
    const toolTold = (e: ReturnType<typeof editor>) =>
      e.posted().filter((m) => (m as { type: string }).type === "slop:edit-tool") as { slide: string; tool: string }[];
    const reports = (e: ReturnType<typeof editor>) =>
      e.posted().filter((m) => (m as { type: string }).type === "slop:edit-selection") as {
        slide: string;
        selection: Record<string, unknown> | null;
      }[];
    const added = (e: ReturnType<typeof editor>) => [...e.doc.querySelectorAll<HTMLElement>("#intro [data-added]")];

    it("drags out a shape with the app's style, then selects it and goes back to the select tool", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "rect", style: SHAPE_STYLE });
      expect(e.doc.documentElement.getAttribute("data-slop-tool")).toBe("rect");
      dragOut(e, [400, 300], [100, 100]);
      const [shape] = added(e);
      expect(shape!.getAttribute("data-added")).toBe("shape");
      expect(shape!.style).toMatchObject({
        position: "absolute",
        left: "100px",
        top: "100px",
        width: "300px",
        height: "200px",
        borderRadius: "0px",
      });
      expect(shape!.style.display).toBe("flex");
      expect(shape!.style.justifyContent).toBe("center");
      expect(shape!.style.textAlign).toBe("center");
      expect(shape!.style.fontSize).toBe("40px");
      expect(e.selected()).toEqual([shape]);
      expect(e.doc.documentElement.hasAttribute("data-slop-tool")).toBe(false);
      expect(toolTold(e)).toEqual([{ type: "slop:edit-tool", slide: "intro", tool: "select" }]);
      const [commit] = e.commits();
      expect(commit!.select).toEqual([5]);
      expect(commit!.markup).toMatch(
        /<div data-added="shape" style="position: absolute; left: 100px; top: 100px; width: 300px; height: 200px;[^"]*background-color: #3b82f6;[^"]*"><\/div><\/section>$/,
      );
      expect(commit!.markup).not.toMatch(/data-slop/);
    });

    it("adds a default-sized shape on a click, and keeps it even with Shift", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "ellipse", style: SHAPE_STYLE });
      dragOut(e, [50, 60], [50, 60]);
      expect(added(e)[0]!.style).toMatchObject({
        left: "50px",
        top: "60px",
        width: "320px",
        height: "200px",
        borderRadius: "50%",
      });
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
      expect(box!.style).toMatchObject({
        left: "200px",
        top: "120px",
        fontSize: "48px",
        fontWeight: "700",
        justifyContent: "flex-start",
      });
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
      expect(e.commits()[0]!.markup).toContain(
        `<path fill="none" stroke="#ef4444" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" d="M3 3 L43 23 L83 3"></path></svg></section>`,
      );
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
      e.fromParent({
        type: "slop:edit-tool",
        tool: "rect",
        style: { ...SHAPE_STYLE, stroke: "#ff0000", strokeWidth: 8, bold: true },
      });
      dragOut(e, [100, 100], [400, 300]);
      expect(reports(e).at(-1)).toEqual({
        type: "slop:edit-selection",
        slide: "intro",
        selected: true,
        selection: {
          kind: "shape",
          text: true,
          vector: false,
          color: "#ffffff",
          fontSize: 40,
          // jsdom has no fonts of its own.
          fontFamily: expect.any(String),
          bold: true,
          italic: false,
          underline: false,
          strike: false,
          script: null,
          letterSpacing: 0,
          lineHeight: null,
          align: "center",
          valign: "middle",
          list: null,
          link: null,
          autofit: null,
          editing: false,
          range: false,
          fill: "#3b82f6",
          stroke: "#ff0000",
          strokeWidth: 8,
          opacity: 1,
          shadow: 0,
          radius: 0,
          clipped: false,
          image: false,
          fit: null,
          fitPosition: null,
          alt: null,
          flipX: false,
          flipY: false,
        },
      });
      e.down(e.$("svg"));
      expect(reports(e).at(-1)!.selection).toMatchObject({ kind: "media", text: false, vector: false, valign: null });
      e.down(e.$(".card p:nth-child(2)"));
      expect(reports(e).at(-1)!.selection).toMatchObject({
        kind: "element",
        text: true,
        color: "#ff0000",
        fill: null,
        stroke: null,
        strokeWidth: 0,
      });
      e.down(e.$("#intro"));
      expect(reports(e).at(-1)!.selection).toBeNull();
    });

    it("restyles the selected text and saves it", () => {
      const e = editor();
      const h1 = e.$("h1");
      e.down(h1);
      e.fromParent({
        type: "slop:edit-style",
        style: { color: "#ff0000", fontSize: 72, bold: true, italic: true, align: "center" },
      });
      expect(h1.style).toMatchObject({ fontSize: "72px", fontWeight: "700", fontStyle: "italic", textAlign: "center" });
      expect(h1.style.color).toMatch(/#ff0000|rgb\(255, 0, 0\)/);
      expect(e.commits()).toHaveLength(1);
      expect(reports(e).at(-1)!.selection).toMatchObject({
        color: "#ff0000",
        fontSize: 72,
        bold: true,
        italic: true,
        align: "center",
      });
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
      expect(reports(e).at(-1)!.selection).toMatchObject({
        kind: "drawing",
        text: false,
        vector: true,
        stroke: "#ef4444",
        strokeWidth: 6,
        fill: null,
      });
      e.fromParent({ type: "slop:edit-style", style: { stroke: "#00ff00", strokeWidth: 12, fill: "#0000ff" } });
      const path = svg.querySelector("path")!;
      expect([path.getAttribute("stroke"), path.getAttribute("stroke-width"), path.getAttribute("fill")]).toEqual([
        "#00ff00",
        "12",
        "#0000ff",
      ]);
      expect(svg.hasAttribute("style") && svg.style.backgroundColor).toBe("");
    });

    describe("stretching what was added", () => {
      const pullRight = (e: ReturnType<typeof editor>, by: number) => {
        const handle = e.$(`[data-slop-ui] [data-dir="1 0"]`);
        const pointer = (type: string, x: number) =>
          handle.dispatchEvent(
            new e.window.PointerEvent(type, { clientX: x, clientY: 100, button: 0, bubbles: true, cancelable: true }),
          );
        pointer("pointerdown", 100);
        pointer("pointermove", 100 + by);
        pointer("pointerup", 100 + by);
      };

      it("resizes a shape instead of scaling it, so its border keeps its width", () => {
        const e = editor();
        e.fromParent({
          type: "slop:edit-tool",
          tool: "rect",
          style: { ...SHAPE_STYLE, stroke: "#ffffff", strokeWidth: 8 },
        });
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

      it("resizes added text boxes without scaling the text", () => {
        const e = editor();
        e.fromParent({ type: "slop:edit-tool", tool: "text", style: TEXT_STYLE });
        dragOut(e, [100, 100], [400, 100]);
        e.key("Escape");
        const box = added(e)[0]!;
        e.down(box);
        e.up(box);
        pullRight(e, 150);
        expect(box.style.scale).toBe("");
        expect(box.style.width).toBe("450px");
        e.fromParent({ type: "slop:edit-size-mode", mode: "stretch" });
        pullRight(e, 150);
        expect(box.style.scale).toBe("1.333 1");
        expect(box.style.width).toBe("450px");
      });
    });

    it("deletes the selection when the toolbar asks", () => {
      const e = editor();
      e.down(e.$("h1"));
      e.fromParent({ type: "slop:edit-delete" });
      expect(e.doc.querySelector("h1:not([data-delete-placeholder])")).toBeNull();
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
        for (const [sel, [x, y, w, h]] of Object.entries(boxes))
          e.$(sel).getBoundingClientRect = () => new e.window.DOMRect(x, y, w, h);
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

  describe("rich text", () => {
    const TEXT_DECK = `<!DOCTYPE html><html><head><style>.title { font-family: "Playfair Display", Georgia, serif; }</style></head><body>
<main class="deck">
  <section class="slide" id="intro">
    <p id="p">Hello brave world</p>
    <p id="b"><b>Hello</b></p>
    <div id="lines">One<br>Two<br>Three</div>
    <h2 class="title" id="t">Title</h2>
    <img id="img" src="assets/a.png" alt="">
  </section>
  <section class="slide" id="outro"><p>Bye</p></section>
</main></body></html>`;

    const editText = (selector: string) => {
      const e = editor({ markup: TEXT_DECK });
      const el = e.$(selector);
      e.down(el);
      e.key("Enter");
      expect(el.getAttribute("contenteditable")).toBe("true");
      return { e, el };
    };
    /** Selects characters `start` to `end` of `el`'s text. */
    const selectText = (e: ReturnType<typeof editor>, el: Element, start: number, end = start) => {
      const walker = e.doc.createTreeWalker(el, e.window.NodeFilter.SHOW_TEXT);
      const range = e.doc.createRange();
      let seen = 0;
      let started = false;
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        if (!started && start <= seen + node.data.length) {
          range.setStart(node, start - seen);
          started = true;
        }
        if (started && end <= seen + node.data.length) {
          range.setEnd(node, end - seen);
          break;
        }
        seen += node.data.length;
      }
      const selection = e.window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const selectedText = (e: ReturnType<typeof editor>) => e.window.getSelection()!.toString();
    const lastReport = (e: ReturnType<typeof editor>) =>
      (
        e
          .posted()
          .filter((m) => (m as { type: string }).type === "slop:edit-selection")
          .at(-1) as {
          selection: Record<string, unknown>;
        }
      ).selection;
    const style = (e: ReturnType<typeof editor>, changes: Record<string, unknown>) =>
      e.fromParent({ type: "slop:edit-style", style: changes });

    it("styles only the selected text while typing, keeps it selected, and saves when done", () => {
      const { e, el } = editText("#p");
      selectText(e, el, 6, 11);
      style(e, { bold: true });
      expect(el.innerHTML).toBe(`Hello <span style="font-weight: 700;">brave</span> world`);
      expect(selectedText(e)).toBe("brave");
      expect(lastReport(e)).toMatchObject({ bold: true, editing: true, range: true });
      style(e, { color: "#ff0000", fontSize: 72 });
      expect(el.innerHTML).toBe(
        `Hello <span style="font-weight: 700; color: rgb(255, 0, 0); font-size: 72px;">brave</span> world`,
      );
      // Still typing: nothing is saved until the text is done.
      expect(el.getAttribute("contenteditable")).toBe("true");
      expect(e.commits()).toEqual([]);
      e.key("Escape");
      expect(e.commits()[0]!.markup).toContain(
        `<p id="p">Hello <span style="font-weight: 700; color: rgb(255, 0, 0); font-size: 72px;">brave</span> world</p>`,
      );
    });

    it("takes formatting off part of a formatted run, splitting it around the selection", () => {
      const { e, el } = editText("#b");
      selectText(e, el, 1, 4);
      expect(lastReport(e)).toMatchObject({ bold: true });
      style(e, { bold: false });
      expect(el.innerHTML).toBe("<b>H</b>ell<b>o</b>");
      expect(selectedText(e)).toBe("ell");
      // And back on: the neighbors merge again.
      style(e, { bold: true });
      expect(el.innerHTML).toBe(`<b>H</b><span style="font-weight: 700;">ell</span><b>o</b>`);
    });

    it("underlines, strikes through and raises the selected text", () => {
      const { e, el } = editText("#p");
      selectText(e, el, 0, 5);
      style(e, { underline: true });
      style(e, { strike: true });
      expect(el.innerHTML).toBe(`<span style="text-decoration-line: underline line-through;">Hello</span> brave world`);
      expect(lastReport(e)).toMatchObject({ underline: true, strike: true });
      style(e, { underline: false });
      expect(el.innerHTML).toBe(`<span style="text-decoration-line: line-through;">Hello</span> brave world`);
      selectText(e, el, 12, 17);
      style(e, { script: "sup" });
      expect(el.innerHTML).toContain("brave <sup>world</sup>");
      expect(lastReport(e)).toMatchObject({ script: "sup" });
      style(e, { script: "sub" });
      expect(el.innerHTML).toContain("brave <sub>world</sub>");
      style(e, { script: null });
      expect(el.innerHTML).toContain("brave world");
    });

    it("styles the whole element when there is only a caret, overriding its inner styles", () => {
      const { e, el } = editText("#p");
      selectText(e, el, 0, 5);
      style(e, { color: "#00ff00" });
      selectText(e, el, 3);
      style(e, { color: "#0000ff", letterSpacing: 2, lineHeight: 1.5, fontFamily: "Georgia, serif" });
      expect(el.innerHTML).toBe("Hello brave world");
      expect(el.style.color).toMatch(/#0000ff|rgb\(0, 0, 255\)/);
      expect(el.style).toMatchObject({ letterSpacing: "2px", lineHeight: "1.5", fontFamily: "Georgia, serif" });
      expect(el.getAttribute("contenteditable")).toBe("true");
      expect(e.commits()).toEqual([]);
      expect(lastReport(e)).toMatchObject({ letterSpacing: 2, lineHeight: 1.5, fontFamily: "Georgia" });
    });

    it("toggles bold, italic and underline with ⌘B / ⌘I / ⌘U, while typing or on the selection", () => {
      const { e, el } = editText("#p");
      selectText(e, el, 0, 5);
      expect(e.key("b", { metaKey: true }).defaultPrevented).toBe(true);
      e.key("i", { ctrlKey: true });
      e.key("u", { metaKey: true });
      expect(el.innerHTML).toBe(
        `<span style="font-weight: 700; font-style: italic; text-decoration-line: underline;">Hello</span> brave world`,
      );
      e.key("b", { metaKey: true });
      expect(el.innerHTML).not.toContain("font-weight");
      // The shortcuts never reach the app while typing.
      expect(e.keys()).toEqual([]);
      e.key("Escape");
      const lines = e.$("#lines");
      e.down(lines);
      e.key("b", { metaKey: true });
      expect(lines.style.fontWeight).toBe("700");
      expect(e.commits()).toHaveLength(2);
    });

    it("keeps typing when focus goes to the app's toolbar, and stops when the app says so", () => {
      const { e, el } = editText("#p");
      selectText(e, el, 6, 11);
      e.window.dispatchEvent(new e.window.Event("blur"));
      e.window.getSelection()!.removeAllRanges();
      expect(el.getAttribute("contenteditable")).toBe("true");
      // The selection it had is still the one the toolbar restyles.
      style(e, { italic: true });
      expect(el.innerHTML).toBe(`Hello <span style="font-style: italic;">brave</span> world`);
      e.fromParent({ type: "slop:edit-finish" });
      expect(el.hasAttribute("contenteditable")).toBe(false);
      expect(e.commits()).toHaveLength(1);
    });

    describe("lists", () => {
      it("turns lines into a bulleted list, switches it to numbers, and back into lines", () => {
        const e = editor({ markup: TEXT_DECK });
        const lines = e.$("#lines");
        e.down(lines);
        e.fromParent({ type: "slop:edit-list", list: "ul" });
        expect(lines.innerHTML).toBe(
          `<ul style="margin: 0px; padding-left: 1.2em; list-style-type: disc;"><li>One</li><li>Two</li><li>Three</li></ul>`,
        );
        expect(lastReport(e)).toMatchObject({ list: "ul" });
        e.fromParent({ type: "slop:edit-list", list: "ol" });
        expect(lines.innerHTML).toBe(
          `<ol style="margin: 0px; padding-left: 1.2em; list-style-type: decimal;"><li>One</li><li>Two</li><li>Three</li></ol>`,
        );
        e.fromParent({ type: "slop:edit-list", list: "ol" });
        expect(lines.innerHTML).toBe("One<br>Two<br>Three");
        expect(e.commits()).toHaveLength(3);
      });

      it("starts a new item with Enter, indents with Tab and outdents with Shift+Tab", () => {
        const e = editor({ markup: TEXT_DECK });
        const lines = e.$("#lines");
        e.down(lines);
        e.fromParent({ type: "slop:edit-list", list: "ul" });
        e.key("Enter");
        const items = () => [...lines.querySelectorAll("li")];
        selectText(e, lines, 5);
        // "One" + "Tw|o": the rest of the item goes into a new one.
        e.key("Enter");
        expect(lines.getAttribute("contenteditable")).toBe("true");
        expect(items().map((li) => li.innerHTML)).toEqual(["One", "Tw", "o", "Three"]);
        const caret = e.window.getSelection()!.getRangeAt(0);
        expect(items()[2]!.contains(caret.startContainer)).toBe(true);
        expect(e.key("Tab").defaultPrevented).toBe(true);
        expect(lines.querySelector("ul ul")!.outerHTML).toBe(
          `<ul style="margin: 0px; padding-left: 1.2em; list-style-type: circle;"><li>o</li></ul>`,
        );
        expect(lastReport(e)).toMatchObject({ list: "ul" });
        e.key("Tab", { shiftKey: true });
        expect(lines.querySelector("ul ul")).toBeNull();
        expect(items().map((li) => li.textContent)).toEqual(["One", "Tw", "o", "Three"]);
        expect(e.keys()).toEqual([]);
      });

      it("outdents an empty nested item with Enter, and ends the list on an empty last item", () => {
        const e = editor({ markup: TEXT_DECK });
        const lines = e.$("#lines");
        e.down(lines);
        e.fromParent({ type: "slop:edit-list", list: "ul" });
        e.key("Enter");
        selectText(e, lines, 11);
        e.key("Enter");
        expect(lines.querySelectorAll("li")).toHaveLength(4);
        e.key("Tab");
        expect(lines.querySelector("ul ul li")!.innerHTML).toBe("<br>");
        e.key("Enter");
        expect(lines.querySelector("ul ul")).toBeNull();
        expect(lines.getAttribute("contenteditable")).toBe("true");
        e.key("Enter");
        expect(lines.hasAttribute("contenteditable")).toBe(false);
        expect([...lines.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["One", "Two", "Three"]);
      });
    });

    describe("links", () => {
      it("links the selected text, to a web page in a new window or to another slide", () => {
        const { e, el } = editText("#p");
        selectText(e, el, 6, 11);
        e.fromParent({ type: "slop:edit-link", href: "https://example.com" });
        expect(el.innerHTML).toBe(`Hello <a href="https://example.com" target="_blank" rel="noopener">brave</a> world`);
        expect(lastReport(e)).toMatchObject({ link: "https://example.com" });
        // With the caret in it, the link changes or goes.
        selectText(e, el, 8);
        e.fromParent({ type: "slop:edit-link", href: "#outro" });
        expect(el.innerHTML).toBe(`Hello <a href="#outro">brave</a> world`);
        e.fromParent({ type: "slop:edit-link", href: null });
        expect(el.innerHTML).toBe("Hello brave world");
        // Only web, mail and slide links.
        selectText(e, el, 0, 5);
        e.fromParent({ type: "slop:edit-link", href: "javascript:alert(1)" });
        expect(el.innerHTML).toBe("Hello brave world");
      });

      it("links a selected element: its text, or an element without text in a link that keeps the layout", () => {
        const e = editor({ markup: TEXT_DECK });
        const p = e.$("#p");
        e.down(p);
        e.fromParent({ type: "slop:edit-link", href: "#outro" });
        expect(p.innerHTML).toBe(`<a href="#outro">Hello brave world</a>`);
        expect(lastReport(e)).toMatchObject({ link: "#outro" });
        const img = e.$("#img");
        e.down(img);
        e.fromParent({ type: "slop:edit-link", href: "https://example.com" });
        expect(img.parentElement!.outerHTML).toMatch(
          /^<a href="https:\/\/example.com" target="_blank" rel="noopener" style="display: contents;"><img/,
        );
        // Clicking it still selects the image.
        e.down(e.$("#p"));
        e.down(img);
        expect(e.selected()).toEqual([img]);
        e.fromParent({ type: "slop:edit-link", href: null });
        expect(img.parentElement!.id).toBe("intro");
        expect(e.commits()).toHaveLength(3);
      });

      it("does not follow links on the slide while editing", () => {
        const e = editor({ markup: TEXT_DECK });
        e.down(e.$("#p"));
        e.fromParent({ type: "slop:edit-link", href: "#outro" });
        const click = new e.window.MouseEvent("click", { bubbles: true, cancelable: true });
        e.$("#p a").dispatchEvent(click);
        expect(click.defaultPrevented).toBe(true);
      });
    });

    describe("fitting text", () => {
      it("grows a box with its text: its height becomes the least it is", () => {
        const e = editor();
        e.fromParent({ type: "slop:edit-tool", tool: "rect", style: {} });
        e.$("#intro").dispatchEvent(
          new e.window.PointerEvent("pointerdown", { clientX: 100, clientY: 100, button: 0, bubbles: true }),
        );
        e.$("#intro").dispatchEvent(
          new e.window.PointerEvent("pointermove", { clientX: 400, clientY: 300, button: 0, bubbles: true }),
        );
        e.$("#intro").dispatchEvent(
          new e.window.PointerEvent("pointerup", { clientX: 400, clientY: 300, button: 0, bubbles: true }),
        );
        const shape = e.doc.querySelector<HTMLElement>("[data-added]")!;
        style(e, { autofit: "grow" });
        expect(shape.getAttribute("data-autofit")).toBe("grow");
        expect(shape.style).toMatchObject({ height: "auto", minHeight: "200px" });
        expect(lastReport(e)).toMatchObject({ autofit: "grow" });
        style(e, { autofit: null });
        expect(shape.hasAttribute("data-autofit")).toBe(false);
        expect(shape.style.minHeight).toBe("");
        expect(e.commits().at(-1)!.markup).not.toContain("data-autofit");
      });

      it("shrinks text that overflows its box, but saves the sizes it was given", () => {
        const markup = TEXT_DECK.replace(`<p id="p">`, `<p id="p" style="height: 100px; font-size: 40px">`);
        const e = editor({ markup });
        const p = e.$("#p");
        // jsdom lays nothing out: the text is 5× its font size tall in a 100px box.
        Object.defineProperty(p, "clientHeight", { configurable: true, get: () => 100 });
        Object.defineProperty(p, "clientWidth", { configurable: true, get: () => 800 });
        Object.defineProperty(p, "scrollWidth", { configurable: true, get: () => 800 });
        Object.defineProperty(p, "scrollHeight", {
          configurable: true,
          get: () => Number.parseFloat(p.style.fontSize) * 5,
        });
        e.down(p);
        style(e, { autofit: "shrink" });
        expect(Number.parseFloat(p.style.fontSize)).toBeLessThanOrEqual(20.2);
        // The toolbar shows the size it was given.
        expect(lastReport(e)).toMatchObject({ autofit: "shrink", fontSize: 40 });
        const saved = e.commits().at(-1)!.markup;
        expect(saved).toContain(`<p id="p" style="height: 100px; font-size: 40px;" data-autofit="shrink">`);
      });
    });

    describe("pasting into text", () => {
      const paste = (e: ReturnType<typeof editor>, data: Record<string, string>) => {
        const event = new e.window.Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => data[type] ?? "" } });
        e.doc.activeElement!.dispatchEvent(event);
        return event;
      };

      it("keeps bold, italic, links and line breaks, and drops fonts, sizes and everything else", () => {
        const { e, el } = editText("#p");
        selectText(e, el, 6, 11);
        const event = paste(e, {
          "text/html": `<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid"><p><span style="font-size:11pt;font-family:Arial;font-weight:700">Bold</span> <i class="x">it</i></p><p><a href="https://example.com" onclick="x()">link</a><script>bad()</script><img src="x.png"></p></b>`,
          "text/plain": "Bold it\nlink",
        });
        expect(event.defaultPrevented).toBe(true);
        expect(el.innerHTML).toBe(
          `Hello <span style="font-weight: 700;">Bold</span> <span style="font-style: italic;">it</span><br><a href="https://example.com" target="_blank" rel="noopener">link</a> world`,
        );
      });

      it("pastes plain text with ⌘⇧V, which the app reads from the clipboard", () => {
        const { e, el } = editText("#p");
        selectText(e, el, 6, 11);
        expect(e.key("v", { metaKey: true, shiftKey: true }).defaultPrevented).toBe(true);
        expect(e.posted()).toContainEqual({ type: "slop:edit-paste-request", slide: "intro", plain: true });
        // The app's answer goes where the selection was, even after focus went to the app.
        e.window.getSelection()!.removeAllRanges();
        e.fromParent({ type: "slop:edit-insert-text", text: "big\nbold" });
        expect(el.innerHTML).toBe("Hello big<br>bold world");
      });
    });

    it("tells the app which fonts the deck uses", () => {
      const e = editor({ markup: TEXT_DECK });
      expect(e.posted()).toContainEqual({
        type: "slop:edit-fonts",
        slide: "intro",
        fonts: [{ name: "Playfair Display", stack: `"Playfair Display", Georgia, serif` }],
      });
    });
  });
});

describe("slide editor: shapes, styling and media", () => {
  const SHAPE_STYLE = { color: "#ffffff", fontSize: 40, align: "center", valign: "middle", fill: "#3b82f6" };
  const LINE_STYLE = { fill: null, stroke: "#ef4444", strokeWidth: 6 };
  const IMAGE = `<!DOCTYPE html><html><head><style>
    :root { --brand: #ff0000; --brand-dark: rgb(0, 0, 255); --ink: var(--brand); --gap: 8px; --slop-accent: #123456; }
    .deck { --panel: #00ff00; --panel-copy: #00FF00; }
  </style></head><body><main class="deck"><section class="slide" id="intro">
    <img id="photo" src="assets/a.png" alt="old" style="width: 400px; height: 200px">
    <p id="note">Note</p>
  </section></main></body></html>`;

  const at = (e: ReturnType<typeof editor>, type: string, x: number, y: number, init: PointerEventInit = {}) =>
    e.doc.body.dispatchEvent(
      new e.window.PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, ...init }),
    );
  const dragOut = (e: ReturnType<typeof editor>, from: number[], to: number[], init: PointerEventInit = {}) => {
    at(e, "pointerdown", from[0]!, from[1]!);
    at(e, "pointermove", to[0]!, to[1]!, init);
    at(e, "pointerup", to[0]!, to[1]!);
  };
  const toolTold = (e: ReturnType<typeof editor>) =>
    e.posted().filter((m) => (m as { type: string }).type === "slop:edit-tool");
  const lastSelection = (e: ReturnType<typeof editor>) =>
    (
      e.posted().filter((m) => (m as { type: string }).type === "slop:edit-selection") as {
        selection: Record<string, unknown>;
      }[]
    ).at(-1)!.selection;
  const added = (e: ReturnType<typeof editor>) => [...e.doc.querySelectorAll<HTMLElement>("#intro [data-added]")];
  const style = (e: ReturnType<typeof editor>, changes: unknown) =>
    e.fromParent({ type: "slop:edit-style", style: changes });

  describe("lines and arrows", () => {
    it("drags out a straight line as a drawing, then selects it and goes back to the select tool", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "line", style: LINE_STYLE });
      dragOut(e, [100, 100], [300, 200]);
      const [svg] = added(e);
      expect(svg!.getAttribute("data-added")).toBe("drawing");
      expect(svg!.style).toMatchObject({ left: "97px", top: "97px", width: "206px", height: "106px" });
      expect(svg!.getAttribute("viewBox")).toBe("0 0 206 106");
      const path = svg!.querySelector("path")!;
      expect(path.getAttribute("d")).toBe("M3 3 L203 103");
      expect(path.getAttribute("stroke")).toBe("#ef4444");
      expect(e.selected()).toEqual([svg]);
      expect(toolTold(e)).toEqual([{ type: "slop:edit-tool", slide: "intro", tool: "select" }]);
      expect(e.commits()).toHaveLength(1);
      expect(e.commits()[0]!.select).toEqual([5]);
      expect(lastSelection(e)).toMatchObject({ kind: "drawing", vector: true, stroke: "#ef4444", strokeWidth: 6 });
    });

    it("gives an arrow a head at the end it was dragged to, inside its box", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "arrow", style: LINE_STYLE });
      dragOut(e, [100, 100], [400, 100]);
      const svg = added(e)[0]!;
      // The shaft, then the head: two strokes in one path, so restyling and resizing treat them as one.
      expect(svg.querySelector("path")!.getAttribute("d")).toBe("M3 15 L303 15 M282 3 L303 15 L282 27");
      expect(svg.querySelectorAll("path")).toHaveLength(1);
      expect(svg.getAttribute("viewBox")).toBe("0 0 306 30");
    });

    it("snaps to 45° with Shift", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "line", style: LINE_STYLE });
      dragOut(e, [100, 100], [300, 120], { shiftKey: true });
      expect(added(e)[0]!.querySelector("path")!.getAttribute("d")).toBe("M3 3 L204 3");
      const f = editor();
      f.fromParent({ type: "slop:edit-tool", tool: "line", style: LINE_STYLE });
      dragOut(f, [100, 100], [300, 280], { shiftKey: true });
      expect(added(f)[0]!.querySelector("path")!.getAttribute("d")).toBe("M3 3 L193 193");
    });

    it("adds a line of the default length on a click", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "line", style: LINE_STYLE });
      at(e, "pointerdown", 100, 100);
      at(e, "pointerup", 100, 100);
      expect(added(e)[0]!.querySelector("path")!.getAttribute("d")).toBe("M3 3 L323 3");
    });

    it("drops the line being dragged out on Escape", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "arrow", style: LINE_STYLE });
      at(e, "pointerdown", 100, 100);
      at(e, "pointermove", 200, 200);
      e.key("Escape");
      expect(added(e)).toEqual([]);
      expect(e.commits()).toEqual([]);
    });

    it("restyles a line like a drawing", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "line", style: LINE_STYLE });
      dragOut(e, [100, 100], [300, 200]);
      style(e, { stroke: "#00ff00", strokeWidth: 2 });
      const path = e.$("[data-added] path");
      expect(path.getAttribute("stroke")).toBe("#00ff00");
      expect(path.getAttribute("stroke-width")).toBe("2");
    });
  });

  describe("a line's points", () => {
    const drawn = (tool: string, from: number[], to: number[]) => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool, style: LINE_STYLE });
      dragOut(e, from, to);
      const svg = added(e)[0]!;
      keepBox(e, svg);
      e.window.dispatchEvent(new e.window.Event("resize"));
      return { e, svg, path: svg.querySelector("path")! };
    };
    /** Lays `svg` out where its styles say, around its center however it is turned. */
    const keepBox = (e: ReturnType<typeof editor>, svg: HTMLElement) => {
      const px = (v: string) => Number.parseFloat(v) || 0;
      svg.getBoundingClientRect = () =>
        new e.window.DOMRect(px(svg.style.left), px(svg.style.top), px(svg.style.width), px(svg.style.height));
    };
    const handles = (e: ReturnType<typeof editor>, kind: string) => [
      ...e.doc.querySelectorAll<HTMLElement>(`[data-slop-points] [data-point=${kind}]`),
    ];
    const spot = (el: HTMLElement) => [Number.parseFloat(el.style.left), Number.parseFloat(el.style.top)];
    const pull = (e: ReturnType<typeof editor>, handle: HTMLElement, to: number[], init: PointerEventInit = {}) => {
      const [x, y] = spot(handle);
      handle.dispatchEvent(
        new e.window.PointerEvent("pointerdown", {
          clientX: x,
          clientY: y,
          button: 0,
          bubbles: true,
          cancelable: true,
        }),
      );
      at(e, "pointermove", to[0]!, to[1]!, init);
      at(e, "pointerup", to[0]!, to[1]!, init);
    };
    const press = (e: ReturnType<typeof editor>, handle: HTMLElement) => {
      const down = new e.window.PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true });
      handle.dispatchEvent(down);
      e.doc.body.dispatchEvent(new e.window.PointerEvent("pointerup", { button: 0, bubbles: true }));
    };

    it("shows its ends and where to bend it instead of a box", () => {
      const { e } = drawn("line", [100, 100], [300, 200]);
      expect(handles(e, "point").map(spot)).toEqual([
        [100, 100],
        [300, 200],
      ]);
      expect(handles(e, "add").map(spot)).toEqual([[200, 150]]);
      expect(e.$("[data-slop-ui]").style.display).toBe("none");
    });

    it("moves one end while the other stays put, keeping the line's width", () => {
      const { e, svg, path } = drawn("line", [100, 100], [300, 200]);
      const before = e.commits().length;
      pull(e, handles(e, "point")[1]!, [500, 50], { metaKey: true });
      expect(svg.style).toMatchObject({ left: "97px", top: "47px", width: "406px", height: "56px", scale: "" });
      expect(svg.getAttribute("viewBox")).toBe("0 0 406 56");
      expect(path.getAttribute("d")).toBe("M3 53 L403 3");
      expect(path.getAttribute("stroke-width")).toBe("6");
      expect(handles(e, "point").map(spot)).toEqual([
        [100, 100],
        [500, 50],
      ]);
      expect(e.commits()).toHaveLength(before + 1);
    });

    it("turns an arrow's head with the end it is on", () => {
      const { e, path } = drawn("arrow", [100, 100], [400, 100]);
      pull(e, handles(e, "point")[1]!, [100, 400], { metaKey: true });
      expect(path.getAttribute("d")).toMatch(/^M\S+ 3 L\S+ 303 M\S+ 282 L\S+ 303 L\S+ 282$/);
    });

    it("leaves a click on a handle alone", () => {
      const { e, path } = drawn("line", [100, 100], [300, 200]);
      const before = e.commits().length;
      press(e, handles(e, "add")[0]!);
      expect(path.getAttribute("d")).toBe("M3 3 L203 103");
      expect(e.commits()).toHaveLength(before);
    });

    it("curves through a point dragged out of the line, which then moves like its ends", () => {
      const { e, svg, path } = drawn("line", [100, 100], [300, 100]);
      pull(e, handles(e, "add")[0]!, [200, 300], { metaKey: true });
      expect(path.getAttribute("d")).toMatch(/^M\S+ \S+ C\S+ \S+ \S+ \S+ \S+ \S+ C\S+ \S+ \S+ \S+ \S+ \S+$/);
      expect(handles(e, "point").map(spot)).toEqual([
        [100, 100],
        [200, 300],
        [300, 100],
      ]);
      // A stretch of its own on each side of the new point.
      expect(handles(e, "add")).toHaveLength(2);
      expect(Number.parseFloat(svg.style.height)).toBeGreaterThanOrEqual(206);
      pull(e, handles(e, "point")[1]!, [200, 400], { metaKey: true });
      expect(handles(e, "point").map(spot)[1]).toEqual([200, 400]);
    });

    it("fits the box around a curve that bulges past its points", () => {
      const { e, svg } = drawn("line", [100, 100], [300, 100]);
      pull(e, handles(e, "add")[0]!, [140, 300], { metaKey: true });
      pull(e, handles(e, "add")[1]!, [290, 290], { metaKey: true });
      const right = Number.parseFloat(svg.style.left) + Number.parseFloat(svg.style.width);
      expect(right).toBeGreaterThan(303);
    });

    it("points an arrow's head along the curve as it ends", () => {
      const { e, path } = drawn("arrow", [100, 100], [300, 100]);
      pull(e, handles(e, "add")[0]!, [300, 300], { metaKey: true });
      // The line comes up to its end, so the barbs trail below the tip, either side of it.
      const head = /M(\S+) (\S+) L(\S+) (\S+) L(\S+) (\S+)$/.exec(path.getAttribute("d")!)!.slice(1).map(Number);
      const [x1, y1, tipX, tipY, x2, y2] = head as [number, number, number, number, number, number];
      expect(y1).toBeGreaterThan(tipY);
      expect(y2).toBeGreaterThan(tipY);
      expect(x1).toBeLessThan(tipX);
      expect(x2).toBeGreaterThan(tipX);
    });

    it("removes a point on a double-click, going back to straight, but keeps the ends", () => {
      const { e, path } = drawn("line", [100, 100], [300, 100]);
      pull(e, handles(e, "add")[0]!, [200, 300], { metaKey: true });
      press(e, handles(e, "point")[0]!);
      press(e, handles(e, "point")[0]!);
      expect(handles(e, "point")).toHaveLength(3);
      const before = e.commits().length;
      press(e, handles(e, "point")[1]!);
      press(e, handles(e, "point")[1]!);
      expect(handles(e, "point")).toHaveLength(2);
      expect(path.getAttribute("d")).toBe("M3 3 L203 3");
      expect(e.commits()).toHaveLength(before + 1);
    });

    it("snaps to 45° from the point before with Shift, and to the slide's center without", () => {
      const { e, path } = drawn("line", [100, 100], [300, 200]);
      pull(e, handles(e, "point")[1]!, [300, 120], { shiftKey: true });
      expect(path.getAttribute("d")).toBe("M3 3 L204 3");
      pull(e, handles(e, "point")[1]!, [957, 300]);
      expect(handles(e, "point").map(spot)[1]).toEqual([960, 300]);
    });

    it("never lets both ends land on one spot", () => {
      const { e, path } = drawn("line", [100, 100], [300, 200]);
      pull(e, handles(e, "point")[1]!, [100, 100], { metaKey: true });
      expect(path.getAttribute("d")).toBe("M3 3 L203 103");
    });

    it("works on lines already in a deck, and bakes in how they were turned and scaled", () => {
      const markup = DECK.replace(
        '<div class="shape"',
        '<svg id="old" data-added="drawing" viewBox="0 0 206 6" style="position: absolute; left: 100px; top: 100px; width: 206px; height: 6px; rotate: 90deg; overflow: visible;"><path d="M3 3 L203 3 M182 -9 L203 3 L182 15" stroke="#111111" stroke-width="6" fill="none"></path></svg><div class="shape"',
      );
      const e = editor({ markup });
      const svg = e.$("#old");
      keepBox(e, svg);
      svg.dispatchEvent(
        new e.window.PointerEvent("pointerdown", { clientX: 203, clientY: 103, button: 0, bubbles: true }),
      );
      at(e, "pointerup", 203, 103);
      // Around its center, (203, 103), the line now runs from top to bottom.
      expect(handles(e, "point").map(spot)).toEqual([
        [203, 3],
        [203, 203],
      ]);
      pull(e, handles(e, "point")[1]!, [403, 3], { metaKey: true });
      expect(svg.style.rotate).toBe("");
      expect(svg.style).toMatchObject({ left: "200px", top: "-12px", width: "206px" });
      expect(svg.querySelector("path")!.getAttribute("d")).toMatch(/^M3 15 L203 15 M/);
    });

    it("spreads a curve through its points when given a size, keeping the arrow's head", () => {
      const { e, svg, path } = drawn("arrow", [100, 100], [300, 100]);
      pull(e, handles(e, "add")[0]!, [200, 300], { metaKey: true });
      const head = path.getAttribute("d")!.split(" M")[1]!;
      const [, w] = /0 0 (\d+)/.exec(svg.getAttribute("viewBox")!)!;
      e.fromParent({ type: "slop:edit-geometry", w: Number(w) });
      expect(path.getAttribute("d")!.split(" M")[1]).toBe(head);
      e.fromParent({ type: "slop:edit-geometry", w: Number(w) + 200 });
      expect(handles(e, "point")).toHaveLength(3);
      expect(path.getAttribute("d")).toMatch(/ C.* C.* M\S+ \S+ L\S+ \S+ L\S+ \S+$/);
    });

    it("sizes an arrow's head and its box with the line's width", () => {
      const { e, svg, path } = drawn("arrow", [100, 100], [400, 100]);
      style(e, { strokeWidth: 16 });
      expect(path.getAttribute("d")).toBe("M8 40 L308 40 M253 8 L308 40 L253 72");
      expect(svg.style.top).toBe("60px");
    });

    it("leaves freehand drawings their box", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "draw", style: LINE_STYLE });
      at(e, "pointerdown", 10, 20);
      at(e, "pointermove", 50, 40);
      at(e, "pointermove", 90, 20);
      at(e, "pointerup", 90, 20);
      e.fromParent({ type: "slop:edit-tool", tool: "select" });
      const svg = added(e)[0]!;
      e.down(svg);
      e.up(svg);
      expect(handles(e, "point")).toEqual([]);
      expect(e.$("[data-slop-ui]").style.display).toBe("");
    });

    it("gives a tilted line its box back, to reset the tilt", () => {
      const { e, svg } = drawn("line", [100, 100], [300, 200]);
      svg.style.setProperty("transform", "perspective(1000px) rotateX(20deg) rotateY(0deg)");
      e.fromParent({ type: "slop:edit-select-all" });
      e.fromParent({ type: "slop:edit-select", path: [5] });
      expect(handles(e, "point")).toEqual([]);
    });

    it("hides the points while several elements are selected", () => {
      const { e } = drawn("line", [100, 100], [300, 200]);
      e.fromParent({ type: "slop:edit-select-all" });
      expect(handles(e, "point")).toEqual([]);
    });
  });

  describe("cut-out shapes", () => {
    it.each(["triangle", "star", "bubble"])("drags out a %s that holds text, with no border", (tool) => {
      const e = editor();
      e.fromParent({
        type: "slop:edit-tool",
        tool,
        style: { ...SHAPE_STYLE, stroke: "#000000", strokeWidth: 4 },
      });
      dragOut(e, [100, 100], [400, 300]);
      const [shape] = added(e);
      expect(shape!.getAttribute("data-added")).toBe("shape");
      expect(shape!.tagName.toLowerCase()).toBe("div");
      expect(shape!.style.getPropertyValue("clip-path")).toMatch(/^polygon\(/);
      expect(e.selected()).toEqual([shape]);
      expect(lastSelection(e)).toMatchObject({
        kind: "shape",
        text: true,
        clipped: true,
        radius: null,
        stroke: null,
        strokeWidth: 0,
      });
      expect(e.commits()[0]!.markup).toContain("clip-path: polygon(");
    });

    it("ignores border, shadow and radius, which the cut would only slice", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "star", style: SHAPE_STYLE });
      dragOut(e, [100, 100], [400, 300]);
      style(e, { stroke: "#000000", strokeWidth: 4, shadow: 20, radius: 10 });
      const shape = added(e)[0]!;
      expect(shape.style.getPropertyValue("box-shadow")).toBe("");
      expect(shape.style.getPropertyValue("border-radius")).toBe("0px");
      expect(lastSelection(e)).toMatchObject({ strokeWidth: 0, shadow: 0, radius: null });
    });
  });

  describe("opacity, shadow and corner radius", () => {
    it("sets, reports and clears them on any element", () => {
      const e = editor();
      const card = e.$(".card");
      e.down(card);
      style(e, { opacity: 0.5, shadow: 24, radius: 16 });
      expect(card.style.opacity).toBe("0.5");
      expect(card.style.getPropertyValue("box-shadow")).toContain("0px 8px 24px");
      expect(card.style.getPropertyValue("border-radius")).toBe("16px");
      expect(lastSelection(e)).toMatchObject({ opacity: 0.5, shadow: 24, radius: 16 });
      expect(e.commits().at(-1)!.markup).toContain("opacity: 0.5");
      style(e, { opacity: 1, shadow: 0, radius: 0 });
      expect(card.getAttribute("style")).toBeNull();
      expect(lastSelection(e)).toMatchObject({ opacity: 1, shadow: 0, radius: 0 });
    });

    it("keeps an element clickable: opacity stops short of zero", () => {
      const e = editor();
      e.down(e.$(".card"));
      style(e, { opacity: 0 });
      expect(e.$(".card").style.opacity).toBe("0.05");
    });

    it("overrides what the deck's styles set when clearing", () => {
      const e = editor({
        markup: DECK.replace("<head>", "<head><style>.card { opacity: 0.5; box-shadow: 0px 2px 6px black; }</style>"),
      });
      e.down(e.$(".card"));
      expect(lastSelection(e)).toMatchObject({ opacity: 0.5, shadow: 6 });
      style(e, { opacity: 1, shadow: 0 });
      expect(e.$(".card").style.opacity).toBe("1");
      expect(e.$(".card").style.getPropertyValue("box-shadow")).toBe("none");
    });

    it("shades a drawing with a filter that follows its line, and gives it no corners", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "line", style: LINE_STYLE });
      dragOut(e, [100, 100], [300, 200]);
      style(e, { shadow: 12, radius: 8 });
      const svg = added(e)[0]!;
      expect(svg.style.getPropertyValue("filter")).toContain("drop-shadow(");
      expect(svg.style.getPropertyValue("box-shadow")).toBe("");
      expect(lastSelection(e)).toMatchObject({ shadow: 12, radius: null });
      style(e, { shadow: 0 });
      expect(svg.style.getPropertyValue("filter")).toBe("");
    });

    it("reports an ellipse's radius in pixels", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "ellipse", style: SHAPE_STYLE });
      dragOut(e, [100, 100], [400, 300]);
      expect(lastSelection(e).radius).toBe(100);
    });
  });

  describe("deck colors", () => {
    const colors = (e: ReturnType<typeof editor>) =>
      (e.posted().find((m) => (m as { type: string }).type === "slop:edit-colors") as { colors: unknown }).colors;

    it("reports the colors in the deck's CSS variables once, skipping non-colors, the app's own and repeats", () => {
      const e = editor({ markup: IMAGE });
      expect(colors(e)).toEqual([
        { name: "brand", value: "#ff0000" },
        { name: "brand-dark", value: "#0000ff" },
        { name: "panel", value: "#00ff00" },
      ]);
    });

    it("reports none for a deck without variables", () => {
      expect(colors(editor())).toEqual([]);
    });

    it("leaves nothing behind in the document", () => {
      const e = editor({ markup: IMAGE });
      expect(e.doc.querySelectorAll("body > span")).toHaveLength(0);
    });
  });

  describe("images", () => {
    const photo = (e: ReturnType<typeof editor>) => e.$("#photo") as HTMLImageElement;

    it("reports an image's fit, position, alt text and flips; other elements have none", () => {
      const e = editor({ markup: IMAGE });
      e.down(photo(e));
      expect(lastSelection(e)).toMatchObject({
        kind: "media",
        image: true,
        fit: "fill",
        alt: "old",
        flipX: false,
        flipY: false,
      });
      e.down(e.$("#note"));
      expect(lastSelection(e)).toMatchObject({ image: false, fit: null, alt: null });
    });

    it("sets fit, position and alt text", () => {
      const e = editor({ markup: IMAGE });
      e.down(photo(e));
      style(e, { fit: "cover", fitPosition: "50% 0%", alt: "A cat" });
      expect(photo(e).style.getPropertyValue("object-fit")).toBe("cover");
      expect(photo(e).style.getPropertyValue("object-position")).toBe("50% 0%");
      expect(photo(e).getAttribute("alt")).toBe("A cat");
      expect(lastSelection(e)).toMatchObject({ fit: "cover", fitPosition: "50% 0%", alt: "A cat" });
      expect(e.commits().at(-1)!.markup).toContain('alt="A cat"');
    });

    it("refuses values that are not fits or positions, and leaves other elements alone", () => {
      const e = editor({ markup: IMAGE });
      e.down(photo(e));
      style(e, { fit: "tile", fitPosition: "red; color: blue" });
      expect(photo(e).style.getPropertyValue("object-fit")).toBe("");
      expect(photo(e).style.getPropertyValue("object-position")).toBe("");
      e.down(e.$("#note"));
      style(e, { fit: "cover", alt: "x", flipX: true });
      expect(e.$("#note").getAttribute("alt")).toBeNull();
      expect(e.$("#note").getAttribute("style")).toBeNull();
    });

    it("flips horizontally and vertically, keeping a tilt in front", () => {
      const e = editor({ markup: IMAGE });
      e.down(photo(e));
      style(e, { flipX: true });
      expect(photo(e).style.transform).toBe("scaleX(-1)");
      style(e, { flipY: true });
      expect(photo(e).style.transform).toBe("scaleX(-1) scaleY(-1)");
      expect(lastSelection(e)).toMatchObject({ flipX: true, flipY: true });
      // A flip is a style, not a hand move.
      expect(photo(e).hasAttribute("data-moved")).toBe(false);
      style(e, { flipX: false, flipY: false });
      expect(photo(e).style.transform).toBe("");
      photo(e).style.setProperty("transform", "perspective(1000px) rotateX(10deg) rotateY(0deg)", "important");
      style(e, { flipX: true });
      expect(photo(e).style.transform).toBe("perspective(1000px) rotateX(10deg) rotateY(0deg) scaleX(-1)");
      expect(photo(e).hasAttribute("data-moved")).toBe(true);
    });

    it("replaces the file, keeping the image's box and cropping to it", () => {
      const e = editor({ markup: IMAGE });
      e.down(photo(e));
      e.fromParent({ type: "slop:edit-replace-image", src: "assets/b.png" });
      expect(photo(e).getAttribute("src")).toBe("assets/b.png");
      expect(photo(e).style).toMatchObject({ width: "400px", height: "200px" });
      expect(photo(e).style.getPropertyValue("object-fit")).toBe("cover");
      expect(e.commits().at(-1)!.markup).toContain('src="assets/b.png"');
    });

    it("keeps a fit the image already has when replacing", () => {
      const e = editor({ markup: IMAGE });
      e.down(photo(e));
      style(e, { fit: "contain" });
      e.fromParent({ type: "slop:edit-replace-image", src: "assets/b.png" });
      expect(photo(e).style.getPropertyValue("object-fit")).toBe("contain");
    });

    it("replaces only images, and only with the deck's assets", () => {
      const e = editor({ markup: IMAGE });
      e.down(e.$("#note"));
      e.fromParent({ type: "slop:edit-replace-image", src: "assets/b.png" });
      e.down(photo(e));
      e.fromParent({ type: "slop:edit-replace-image", src: "https://example.test/b.png" });
      expect(photo(e).getAttribute("src")).toBe("assets/a.png");
      expect(e.commits()).toEqual([]);
    });
  });

  describe("slide background", () => {
    const told = (e: ReturnType<typeof editor>) =>
      e.posted().filter((m) => (m as { type: string }).type === "slop:edit-background") as { color: string | null }[];

    it("reports it on load, sets it on the slide, and drops it again", () => {
      const e = editor();
      expect(told(e).at(-1)).toEqual({ type: "slop:edit-background", slide: "intro", color: null });
      e.fromParent({ type: "slop:edit-background", color: "#ff0000" });
      expect(e.$("#intro").style.getPropertyValue("background-image")).toBe("none");
      expect(told(e).at(-1)!.color).toBe("#ff0000");
      expect(e.commits().at(-1)!.markup).toMatch(/^<section class="slide" id="intro" style="background-color: [^"]*"/);
      e.fromParent({ type: "slop:edit-background", color: null });
      expect(e.$("#intro").hasAttribute("style")).toBe(false);
      expect(told(e).at(-1)!.color).toBeNull();
    });

    it("refuses anything but a color", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-background", color: "url(x); color: red" });
      expect(e.$("#intro").hasAttribute("style")).toBe(false);
      expect(e.commits()).toEqual([]);
    });
  });

  describe("format painter", () => {
    const paint = (e: ReturnType<typeof editor>, from: Element, to: Element) => {
      e.down(from);
      e.up(from);
      e.fromParent({ type: "slop:edit-tool", tool: "paint" });
      e.down(to);
      e.up(to);
    };

    it("gives the next element clicked the look of the selection, then goes back to the select tool", () => {
      const e = editor();
      const from = e.$(".card p:last-child");
      from.style.fontSize = "30px";
      from.style.fontWeight = "700";
      from.style.backgroundColor = "#00ff00";
      from.style.opacity = "0.5";
      from.style.setProperty("border-radius", "12px");
      e.fromParent({ type: "slop:edit-select", path: [1, 1] });
      const to = e.$(".card p");
      e.fromParent({ type: "slop:edit-tool", tool: "paint" });
      expect(e.doc.documentElement.getAttribute("data-slop-tool")).toBe("paint");
      e.down(to);
      e.up(to);
      expect(lastSelection(e)).toMatchObject({
        color: "#ff0000",
        fontSize: 30,
        bold: true,
        fill: "#00ff00",
        opacity: 0.5,
        radius: 12,
      });
      expect(e.selected()).toEqual([to]);
      expect(e.doc.documentElement.hasAttribute("data-slop-tool")).toBe(false);
      expect(toolTold(e)).toEqual([{ type: "slop:edit-tool", slide: "intro", tool: "select" }]);
      expect(e.commits()).toHaveLength(1);
      expect(e.commits()[0]!.select).toEqual([1, 0]);
    });

    it("only puts itself away on a click on empty space", () => {
      const e = editor();
      e.down(e.$("h1"));
      e.up(e.$("h1"));
      e.fromParent({ type: "slop:edit-tool", tool: "paint" });
      e.down(e.$("#intro"));
      e.up(e.$("#intro"));
      expect(toolTold(e)).toHaveLength(1);
      expect(e.commits()).toEqual([]);
    });

    it("keeps a line's stroke when painting from an element that has none", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "line", style: LINE_STYLE });
      dragOut(e, [100, 100], [300, 200]);
      const svg = added(e)[0]!;
      e.$("h1").style.opacity = "0.5";
      paint(e, e.$("h1"), svg.querySelector("path")!);
      expect(svg.querySelector("path")!.getAttribute("stroke")).toBe("#ef4444");
      expect(svg.style.opacity).toBe("0.5");
      expect(svg.style.color).toBe("");
    });

    it("does nothing without anything to copy from", () => {
      const e = editor();
      e.fromParent({ type: "slop:edit-tool", tool: "paint" });
      e.down(e.$("h1"));
      expect(e.commits()).toEqual([]);
      expect(toolTold(e)).toHaveLength(1);
    });

    it("is put away by Escape", () => {
      const e = editor();
      e.down(e.$("h1"));
      e.up(e.$("h1"));
      e.fromParent({ type: "slop:edit-tool", tool: "paint" });
      e.key("Escape");
      expect(e.doc.documentElement.hasAttribute("data-slop-tool")).toBe(false);
    });
  });
});
