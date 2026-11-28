// @vitest-environment node
/**
 * Moving elements to another slide in the slide editor (src-tauri/assets/editor/), when several
 * slides are on the stage: the pasteboard says where the others are (`slop:neighbors`), and what
 * is dropped on one, or sent there from the menu, is cut here and handed to the app to paste.
 * jsdom lays nothing out, so each box is where its inline styles and the view put it.
 */
import { describe, expect, it } from "vitest";

import { editorPage } from "./slideEditorPage";

const box = (id: string, left: number, top: number) =>
  `<div id="${id}" style="position: absolute; left: ${left}px; top: ${top}px; width: 200px; height: 100px; background: red"></div>`;
const DECK = `<!DOCTYPE html><html><head></head><body><main class="deck"><section class="slide" id="intro">${box("a", 100, 100)}${box("b", 600, 100)}</section><section class="slide" id="outro"><p>Bye</p></section></main></body></html>`;

// The deck once the move's first half is saved: the elements are gone from the slide they left.
const MOVED = DECK.replace(/<div id=.*<\/div>/, "");

interface Transfer {
  type: string;
  slide: string;
  to: string;
  html: string;
  x: number | null;
  y: number | null;
  group: string;
}
interface Board {
  origin: () => { x: number; y: number };
  scale: () => number;
}

/** The editor on `slide`, with every box of the slide where the view shows it. */
function laidOut(slide = "intro", markup = DECK) {
  const e = editorPage({ markup, slide });
  const board = (e.window as unknown as { slopPasteboard: Board }).slopPasteboard;
  const px = (v: string) => Number.parseFloat(v) || 0;
  function rect(this: HTMLElement) {
    const k = board.scale();
    const at = board.origin();
    if (this.matches(".slide")) return new e.window.DOMRect(at.x, at.y, 1920 * k, 1080 * k);
    const [tx = 0, ty = 0] = (this.style.translate || "").split(" ").map(px);
    return new e.window.DOMRect(
      at.x + (px(this.style.left) + tx) * k,
      at.y + (px(this.style.top) + ty) * k,
      px(this.style.width) * k,
      px(this.style.height) * k,
    );
  }
  e.window.HTMLElement.prototype.getBoundingClientRect = rect;
  return e;
}
type Page = ReturnType<typeof laidOut>;
// The other slide's cell, right of this one, which fills the 1920px window at the start.
const beside = (e: Page, locked = false, x = 1944) =>
  e.fromParent({ type: "slop:neighbors", cells: [{ slide: "outro", x, y: 0, locked }] });
const transfers = (e: Page) => e.messages<Transfer>("slop:edit-transfer");
const refusals = (e: Page) => e.messages("slop:edit-transfer-refused");
const dropBox = (e: Page) => e.$("[data-slop-drop]");
/** The header of a copied element's markup. */
const header = (html: string) => JSON.parse(html.slice("<!--slopslides:".length, html.indexOf("-->")));

describe("moving elements to another slide", () => {
  it("does not dim what is around the slide while others are beside it", () => {
    const e = laidOut();
    const css = [...e.doc.querySelectorAll("style")].map((style) => style.textContent).join("\n");
    expect(css).toContain("html[data-slop-grid] [data-slop-frame] { box-shadow: none; }");
    expect(e.doc.documentElement.hasAttribute("data-slop-grid")).toBe(false);
    beside(e);
    expect(e.doc.documentElement.hasAttribute("data-slop-grid")).toBe(true);
  });

  it("cuts an element dropped on another slide and hands it over, centered on the drop", () => {
    const e = laidOut();
    beside(e);
    const a = e.$("#a");
    e.down(a, 150, 150);
    e.move(a, 2150, 200);
    expect(a.style.translate).toBe("2000px 50px");
    e.up(a, 2150, 200);

    expect(e.$("#a")).toBeNull();
    const [commit] = e.commits() as unknown as { markup: string; group: string }[];
    expect(e.commits()).toHaveLength(1);
    expect(commit!.group).toMatch(/^transfer:\w+$/);
    expect(commit!.markup).not.toContain('id="a"');
    expect(commit!.markup).toContain('id="b"');
    // The box's middle was at (2200, 200) of the window, and the other slide starts at 1944.
    const [transfer] = transfers(e);
    expect(transfers(e)).toHaveLength(1);
    expect(transfer).toMatchObject({ slide: "intro", to: "outro", x: 256, y: 200, group: commit!.group });
    // What goes over is the element as it was before the drag, as a copy of it would be.
    expect(transfer!.html).toContain('id="a"');
    expect(transfer!.html).not.toContain("translate");
    expect(header(transfer!.html)).toMatchObject({ slide: "intro", path: [0] });
    // The save comes first: the app saves this slide before it pastes on the other.
    const order = e.posted().map((m) => m.type);
    expect(order.indexOf("slop:edit-commit")).toBeLessThan(order.indexOf("slop:edit-transfer"));
    expect(e.selected()).toEqual([]);
  });

  it("gives the drop point in the other slide's pixels when this one is zoomed", () => {
    const e = laidOut();
    e.fromParent({ type: "slop:camera", x: 0, y: 0, k: 2 });
    beside(e, false, 4000);
    const a = e.$("#a");
    // At twice the size it spans (200, 200) to (600, 400); the drag goes 4000 window pixels.
    e.down(a, 300, 300);
    e.move(a, 4300, 300);
    expect(a.style.translate).toBe("2000px 0px");
    e.up(a, 4300, 300);
    expect(transfers(e)[0]).toMatchObject({ to: "outro", x: 400, y: 300 });
  });

  it("keeps the drop point on the other slide", () => {
    const e = laidOut();
    beside(e);
    const a = e.$("#a");
    // The pointer is just inside the other slide's left edge, the box's middle left of it.
    e.down(a, 290, 150);
    e.move(a, 1950, 150);
    e.up(a, 1950, 150);
    expect(transfers(e)[0]).toMatchObject({ x: 0, y: 150 });
  });

  it("moves several selected elements together", () => {
    const e = laidOut();
    beside(e);
    e.fromParent({ type: "slop:edit-select-all" });
    const a = e.$("#a");
    e.down(a, 150, 150);
    e.move(a, 2150, 150);
    e.up(a, 2150, 150);
    expect(e.doc.querySelectorAll("#intro > div")).toHaveLength(0);
    const [transfer] = transfers(e);
    expect(header(transfer!.html).group).toHaveLength(2);
    // The middle of both boxes, (100..800) by (100..200), moved 2000 to the right.
    expect(transfer).toMatchObject({ x: 450 + 2000 - 1944, y: 150 });
    expect(e.commits()).toHaveLength(1);
  });

  it("outlines the slide a drag is over, and snaps to nothing there", () => {
    const e = laidOut();
    beside(e);
    const a = e.$("#a");
    e.down(a, 150, 150);
    // 3px short of lining up with b: on this slide it snaps.
    e.move(a, 150, 647);
    e.move(a, 147, 650);
    expect(dropBox(e).style.display).toBe("none");
    e.move(a, 2150, 153);
    expect(a.style.translate).toBe("2000px 3px");
    expect(e.doc.querySelectorAll("[data-slop-guides] > *")).toHaveLength(0);
    expect(dropBox(e).style.cssText).toContain("left: 1944px");
    expect(dropBox(e).style.width).toBe("1920px");
    expect(dropBox(e).style.height).toBe("1080px");
    expect(dropBox(e).hasAttribute("data-locked")).toBe(false);
    // Back on this slide, the outline is gone and the element stays.
    e.move(a, 400, 400);
    expect(dropBox(e).style.display).toBe("none");
    e.up(a, 400, 400);
    expect(transfers(e)).toEqual([]);
    expect(e.$("#a").style.translate).toBe("250px 250px");
    expect(e.commits()).toHaveLength(1);
    expect((e.commits()[0] as unknown as { group?: string }).group).toBeUndefined();
  });

  it("drops on this slide where it reaches over another one", () => {
    const e = laidOut();
    // Zoomed in, this slide covers the other one's cell.
    e.fromParent({ type: "slop:camera", x: 0, y: 0, k: 2 });
    beside(e);
    const a = e.$("#a");
    e.down(a, 300, 300);
    e.move(a, 2300, 300);
    expect(dropBox(e).style.display).toBe("none");
    e.up(a, 2300, 300);
    expect(transfers(e)).toEqual([]);
    expect(e.$("#a").style.translate).toBe("1000px 0px");
  });

  it("puts the element back when the other slide is locked", () => {
    const e = laidOut();
    beside(e, true);
    const a = e.$("#a");
    e.down(a, 150, 150);
    e.move(a, 2150, 200);
    expect(dropBox(e).hasAttribute("data-locked")).toBe(true);
    e.up(a, 2150, 200);
    expect(dropBox(e).style.display).toBe("none");
    expect(e.$("#a").style.translate).toBe("");
    expect(e.$("#a").hasAttribute("data-moved")).toBe(false);
    expect(e.commits()).toEqual([]);
    expect(transfers(e)).toEqual([]);
    expect(refusals(e)).toEqual([{ type: "slop:edit-transfer-refused", slide: "intro", to: "outro" }]);
    expect(e.selected()).toEqual([a]);
  });

  it("leaves a line stuck to what it was when the other slide is locked", () => {
    // From the middle of #a's right side, 200px to the right.
    const line =
      '<svg id="line" data-added="drawing" data-from="a" data-from-at="100% 50%" viewBox="0 0 206 6" style="position: absolute; left: 297px; top: 147px; width: 206px; height: 6px; overflow: visible;"><path d="M3 3 L203 3" stroke="#111111" stroke-width="6" fill="none"></path></svg>';
    const e = laidOut("intro", DECK.replace("</section>", `${line}</section>`));
    beside(e, true);
    const el = e.$("#line");
    const before = e.$("#intro").innerHTML;
    e.down(el, 400, 150);
    e.move(el, 2400, 200);
    // On its way, it let go.
    expect(el.hasAttribute("data-from")).toBe(false);
    e.up(el, 2400, 200);
    expect(refusals(e)).toHaveLength(1);
    expect(el.getAttribute("data-from")).toBe("a");
    expect(el.getAttribute("data-from-at")).toBe("100% 50%");
    expect(e.$("#intro").innerHTML.replace(' data-slop-selected=""', "")).toBe(before);
    // So the next save has nothing of it: here, a click that changes nothing.
    e.click(e.$("#b"));
    e.key("Escape");
    expect(e.commits()).toEqual([]);
    // And the line still follows the element.
    e.drag(e.$("#a"), 40, 0);
    expect(e.commits().at(-1)!.markup).toContain('data-from="a" data-from-at="100% 50%"');
    expect(e.$("#line").style.cssText).not.toContain("left: 297px; top: 147px; width: 206px");
  });

  it("hands over the copy of an Alt-drag, leaving this slide as it was", () => {
    const e = laidOut();
    beside(e);
    const a = e.$("#a");
    const before = e.$("#intro").innerHTML;
    e.down(a, 150, 150);
    e.move(a, 2150, 200, { altKey: true });
    expect(e.doc.querySelectorAll("#intro > div")).toHaveLength(3);
    e.up(a, 2150, 200);
    expect(e.doc.querySelectorAll("#intro > div")).toHaveLength(2);
    expect(e.commits()).toEqual([]);
    const [transfer] = transfers(e);
    expect(transfer).toMatchObject({ slide: "intro", to: "outro", x: 256, y: 200 });
    expect(transfer!.group).toMatch(/^transfer:/);
    // The original keeps its id, so the copy goes without one.
    expect(transfer!.html).not.toContain('id="a"');
    expect(transfer!.html).toContain("left: 100px");
    expect(e.selected()).toEqual([a]);
    expect(e.$("#intro").innerHTML.replace(' data-slop-selected=""', "")).toBe(before);
  });

  it("drops the copy of an Alt-drag on a locked slide", () => {
    const e = laidOut();
    beside(e, true);
    const a = e.$("#a");
    e.down(a, 150, 150);
    e.move(a, 2150, 200, { altKey: true });
    e.up(a, 2150, 200);
    expect(e.doc.querySelectorAll("#intro > div")).toHaveLength(2);
    expect(e.commits()).toEqual([]);
    expect(transfers(e)).toEqual([]);
    expect(refusals(e)).toHaveLength(1);
    expect(e.selected()).toEqual([a]);
  });

  it("moves the selection to a slide the app's menu names, to where it is on this one", () => {
    const e = laidOut();
    e.fromParent({ type: "slop:edit-move-to", to: "outro" });
    expect(e.posted().filter((m) => /commit|transfer/.test(m.type))).toEqual([]);
    e.click(e.$("#a"));
    e.fromParent({ type: "slop:edit-move-to", to: "intro" });
    expect(transfers(e)).toEqual([]);
    e.fromParent({ type: "slop:edit-move-to", to: "outro" });
    expect(e.$("#a")).toBeNull();
    const [commit] = e.commits() as unknown as { group: string }[];
    expect(transfers(e)).toEqual([
      {
        type: "slop:edit-transfer",
        slide: "intro",
        to: "outro",
        html: expect.stringContaining('id="a"'),
        x: null,
        y: null,
        group: commit!.group,
      },
    ]);
    expect(commit!.group).toMatch(/^transfer:/);
    expect(header(transfers(e)[0]!.html).box).toMatchObject({ x: 100, y: 100 });
  });

  it("gives each move its own group", () => {
    const e = laidOut();
    e.click(e.$("#a"));
    e.fromParent({ type: "slop:edit-move-to", to: "outro" });
    e.click(e.$("#b"));
    e.fromParent({ type: "slop:edit-move-to", to: "outro" });
    const groups = transfers(e).map((t) => t.group);
    expect(groups).toHaveLength(2);
    expect(groups[0]).not.toBe(groups[1]);
  });

  it("moves nothing to a locked slide from the menu", () => {
    const e = laidOut();
    beside(e, true);
    e.click(e.$("#a"));
    e.fromParent({ type: "slop:edit-move-to", to: "outro" });
    expect(e.$("#a")).not.toBeNull();
    expect(e.commits()).toEqual([]);
    expect(transfers(e)).toEqual([]);
    expect(refusals(e)).toEqual([{ type: "slop:edit-transfer-refused", slide: "intro", to: "outro" }]);
  });

  it("pastes what came from another slide at a point of this slide, as a save of the move's group", () => {
    const source = laidOut();
    source.click(source.$("#a"));
    source.fromParent({ type: "slop:edit-move-to", to: "outro" });
    const { html, group } = transfers(source)[0]!;

    const e = laidOut("outro", MOVED);
    // Wherever the view is: the point is the slide's, not the window's.
    e.fromParent({ type: "slop:camera", x: 30, y: 40, k: 2 });
    e.fromParent({ type: "slop:edit-paste", html, x: 256, y: 200, space: "slide", group });
    const pasted = e.$("#outro > div");
    expect(pasted.id).toBe("a");
    expect([pasted.style.left, pasted.style.top]).toEqual(["156px", "150px"]);
    expect(e.commits()).toHaveLength(1);
    expect(e.commits()[0]).toMatchObject({ slide: "outro", group });
    expect(e.selected()).toEqual([pasted]);
  });

  it("pastes without the ids the slide it left still has, when that was not saved first", () => {
    const source = laidOut();
    source.click(source.$("#a"));
    source.fromParent({ type: "slop:edit-move-to", to: "outro" });
    const { html, group } = transfers(source)[0]!;
    const e = laidOut("outro");
    e.fromParent({ type: "slop:edit-paste", html, x: 256, y: 200, space: "slide", group });
    expect(e.$("#outro > div").id).toBe("");
  });

  it("pastes it where it was when the move names no point", () => {
    const source = laidOut();
    source.fromParent({ type: "slop:edit-select-all" });
    source.fromParent({ type: "slop:edit-move-to", to: "outro" });
    const { html, group } = transfers(source)[0]!;

    const e = laidOut("outro", MOVED);
    e.fromParent({ type: "slop:edit-paste", html, x: null, y: null, space: "slide", group });
    const pasted = [...e.doc.querySelectorAll<HTMLElement>("#outro > div")];
    expect(pasted.map((el) => [el.id, el.style.left, el.style.top])).toEqual([
      ["a", "100px", "100px"],
      ["b", "600px", "100px"],
    ]);
    expect(e.commits()[0]).toMatchObject({ slide: "outro", group });
  });

  it("still takes a paste's point in the window's pixels without a space", () => {
    const e = laidOut("outro", MOVED);
    e.fromParent({ type: "slop:camera", x: 0, y: 0, k: 2 });
    const html = `<!--slopslides:${JSON.stringify({ slide: "intro", path: [0], free: true, box: { x: 0, y: 0, w: 200, h: 100 }, look: {} })}--><div></div>`;
    e.fromParent({ type: "slop:edit-paste", html, x: 512, y: 400 });
    const pasted = e.$("#outro > div");
    expect([pasted.style.left, pasted.style.top]).toEqual(["156px", "150px"]);
    expect((e.commits()[0] as unknown as { group?: string }).group).toBeUndefined();
  });

  it("draws nothing with a tool on the empty space over another slide", () => {
    const e = laidOut();
    e.fromParent({ type: "slop:edit-tool", tool: "rect", style: {} });
    // Without another slide there, the tool draws around the slide too.
    e.down(e.doc.body, 2100, 300);
    e.up(e.doc.body, 2100, 300);
    expect(e.doc.querySelectorAll("#intro [data-added]")).toHaveLength(1);
    const commits = e.commits().length;

    e.fromParent({ type: "slop:edit-tool", tool: "rect", style: {} });
    beside(e);
    e.down(e.doc.body, 2100, 300);
    e.move(e.doc.body, 2200, 400);
    e.up(e.doc.body, 2200, 400);
    expect(e.doc.querySelectorAll("#intro [data-added]")).toHaveLength(1);
    expect(e.commits()).toHaveLength(commits);
    // On the slide it draws as ever.
    e.down(e.$("#intro"), 900, 600);
    e.up(e.$("#intro"), 900, 600);
    expect(e.doc.querySelectorAll("#intro [data-added]")).toHaveLength(2);
  });
});
