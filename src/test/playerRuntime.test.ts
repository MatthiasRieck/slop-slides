/**
 * The player embedded in every deck.html (src-tauri/assets/runtime.js). It runs in the
 * editor's slide iframes, in the presenter, and in exported files opened in any browser.
 */
import { readFileSync } from "node:fs";
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
    expect(parent.postMessage).toHaveBeenCalledWith({ type: "slop:key", key: "ArrowRight", mod: false, shift: false }, "*");
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
    expect(parent.postMessage).toHaveBeenCalledWith({ type: "slop:key", key: "ArrowRight", mod: false, shift: false }, "*");
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
  ).replace(
    `<main class="deck">`,
    `<main class="deck">\n  <div class="deck-section" data-title="First part"></div>`,
  );

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
