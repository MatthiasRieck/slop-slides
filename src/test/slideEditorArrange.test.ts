// @vitest-environment node
/**
 * Selection and arrangement in the slide editor (src-tauri/assets/editor/): several selected
 * elements, the marquee, ⌘A and Tab, duplicates, smart guides, align and distribute, geometry.
 * jsdom lays nothing out, so each element gets a box that follows its inline `translate`.
 */
import { describe, expect, it, vi } from "vitest";

import { placement } from "./placement";
import { editorPage } from "./slideEditorPage";

const DECK = `<!DOCTYPE html><html><head></head><body>
<main class="deck">
  <section class="slide" id="intro">
    <div id="a" style="background: red">A</div>
    <div id="b" style="background: red">B</div>
    <div id="c" style="background: red">C</div>
    <div id="wrap"><div id="d" style="background: red">D</div></div>
    <aside class="notes">Say this</aside>
  </section>
</main></body></html>`;

/** Each element's box: left, top, width, height. */
const BOXES: Record<string, number[]> = {
  a: [100, 100, 200, 100],
  b: [400, 300, 200, 100],
  c: [800, 500, 200, 100],
  d: [1200, 700, 100, 100],
  wrap: [50, 50, 1800, 980],
};

function editor({ markup = DECK, beforeEditor = "" } = {}) {
  const page = editorPage({ markup, beforeEditor });
  const { window, $ } = page;
  const lay = (el: HTMLElement, x: number, y: number, w: number, h: number) => {
    Object.defineProperty(el, "offsetWidth", { get: () => Number.parseFloat(el.style.width) || w, configurable: true });
    Object.defineProperty(el, "offsetHeight", {
      get: () => Number.parseFloat(el.style.height) || h,
      configurable: true,
    });
    el.getBoundingClientRect = () => {
      const [dx = 0, dy = 0] = (el.style.translate.match(/-?[\d.]+/g) ?? []).map(Number);
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      return new window.DOMRect(
        x + dx + (Number.parseFloat(el.style.left) || 0),
        y + dy + (Number.parseFloat(el.style.top) || 0),
        width,
        height,
      );
    };
  };
  lay($("#intro"), 0, 0, 1920, 1080);
  for (const [id, box] of Object.entries(BOXES)) lay($(`#${id}`), box[0]!, box[1]!, box[2]!, box[3]!);
  /** Counts how often `el` is measured from now on; `count()` says how often so far. */
  const measured = (el: HTMLElement) => {
    const measure = el.getBoundingClientRect;
    let calls = 0;
    el.getBoundingClientRect = () => {
      calls++;
      return measure.call(el);
    };
    return { count: () => calls };
  };
  const e = {
    ...page,
    lay,
    measured,
    pick(...selectors: string[]) {
      selectors.forEach((s, i) => {
        page.click($(s), i ? { shiftKey: true } : {});
      });
    },
    ids: () => page.selected().map((el) => el.id),
    last: () => $("#intro").lastElementChild as HTMLElement,
  };
  return e;
}

describe("several selected elements", () => {
  it("keeps them on a right-click on one of them, and collapses to another element", () => {
    const e = editor();
    const rightClick = (target: Element) =>
      target.dispatchEvent(new e.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    e.pick("#a", "#b");
    rightClick(e.$("#b"));
    expect(e.ids()).toEqual(["a", "b"]);
    expect(e.posted().filter((m) => m.type === "slop:edit-menu")).toHaveLength(1);
    rightClick(e.$("#c"));
    expect(e.ids()).toEqual(["c"]);
  });

  it("adds with Shift- or ⌘-click and takes out again, with a frame on each instead of handles", () => {
    const e = editor();
    e.click(e.$("#a"));
    e.click(e.$("#b"), { shiftKey: true });
    e.click(e.$("#c"), { metaKey: true });
    expect(e.ids()).toEqual(["a", "b", "c"]);
    expect(e.$("[data-slop-ui]").style.display).toBe("none");
    expect(e.$("[data-slop-multi]").children).toHaveLength(3);
    e.click(e.$("#b"), { shiftKey: true });
    expect(e.ids()).toEqual(["a", "c"]);
    expect(e.$("[data-slop-multi]").children).toHaveLength(2);
    e.click(e.$("#a"), { shiftKey: true });
    e.click(e.$("#c"), { shiftKey: true });
    expect(e.ids()).toEqual([]);
    expect(e.commits()).toEqual([]);
  });

  it("replaces an element with what it holds, or the other way around", () => {
    const e = editor();
    e.click(e.$("#wrap"));
    expect(e.ids()).toEqual(["wrap"]);
    e.click(e.$("#d"), { shiftKey: true });
    expect(e.ids()).toEqual(["d"]);
  });

  it("moves together, saved once with every element to select again", () => {
    const e = editor();
    e.pick("#a", "#b");
    e.drag(e.$("#b"), 30, 7);
    expect(e.$("#a").style.translate).toBe("30px 7px");
    expect(e.$("#b").style.translate).toBe("30px 7px");
    expect(e.commits()).toHaveLength(1);
    expect(e.commits()[0]).toMatchObject({ select: [0], also: [[1]] });
    expect(e.ids()).toEqual(["a", "b"]);
  });

  it("is selected again from what the commit said", () => {
    const e = editor();
    e.fromParent({ type: "slop:edit-select", path: [0], also: [[2]] });
    expect(e.ids()).toEqual(["a", "c"]);
  });

  it("stays selected through a right click on one of them, or Ctrl-click on a Mac", () => {
    const e = editor();
    Object.defineProperty(e.window.navigator, "platform", { value: "MacIntel", configurable: true });
    e.pick("#a", "#b");
    e.click(e.$("#b"), { button: 2 });
    expect(e.ids()).toEqual(["a", "b"]);
    e.click(e.$("#b"), { ctrlKey: true });
    expect(e.ids()).toEqual(["a", "b"]);
    // Ctrl-click elsewhere is still a press that selects what it lands on.
    e.click(e.$("#c"), { ctrlKey: true });
    expect(e.ids()).toEqual(["c"]);
  });

  it("collapses to the element clicked without dragging", () => {
    const e = editor();
    e.pick("#a", "#b");
    e.click(e.$("#b"));
    expect(e.ids()).toEqual(["b"]);
    expect(e.commits()).toEqual([]);
  });

  it("nudges together, and Escape lets go of all of them", () => {
    const e = editor();
    e.pick("#a", "#b");
    e.key("ArrowRight", { shiftKey: true });
    expect(e.$("#a").style.translate).toBe("10px 0px");
    expect(e.$("#b").style.translate).toBe("10px 0px");
    e.key("Escape");
    expect(e.ids()).toEqual([]);
  });

  it("deletes together, in one save", () => {
    const e = editor();
    e.pick("#a", "#c");
    e.key("Delete");
    expect(e.doc.querySelector("#a")).toBeNull();
    expect(e.doc.querySelector("#c")).toBeNull();
    expect(e.doc.querySelector("#b")).not.toBeNull();
    expect(e.commits()).toHaveLength(1);
    expect(e.ids()).toEqual([]);
  });

  it("restyles and restacks together, in one save, keeping the primary element", () => {
    const e = editor();
    e.pick("#a", "#b");
    e.fromParent({ type: "slop:edit-style", style: { color: "#ff0000" } });
    expect(e.$("#a").style.color).toBe("rgb(255, 0, 0)");
    expect(e.$("#b").style.color).toBe("rgb(255, 0, 0)");
    expect(e.commits()).toHaveLength(1);
    expect(e.commits()[0]).toMatchObject({ select: [0], also: [[1]] });
    e.key("b", { metaKey: true });
    expect(e.$("#a").style.fontWeight).toBe("700");
    expect(e.$("#b").style.fontWeight).toBe("700");
    expect(e.commits()).toHaveLength(2);
    e.fromParent({ type: "slop:edit-order", to: "front" });
    expect(e.$("#a").style.zIndex).not.toBe("");
    expect(e.$("#b").style.zIndex).not.toBe("");
    expect(e.commits()).toHaveLength(3);
  });

  it("copies and cuts together, and pastes keeping how they lie to each other", () => {
    const e = editor();
    e.pick("#b", "#a");
    e.key("c", { metaKey: true });
    const copied = e.posted().find((m) => m.type === "slop:edit-copied")!;
    expect(copied.text).toBe("A\nB");
    const html = copied.html as string;
    expect(html).toMatch(/^<!--slopslides:\{.*"group":\[.*\}-->.*>A<\/div>.*>B<\/div>$/);
    e.fromParent({ type: "slop:edit-paste", html });
    const [a, b] = e.selected() as HTMLElement[];
    expect([a!.textContent, b!.textContent]).toEqual(["A", "B"]);
    expect(a!.id).toBe("");
    // Where they were, a step away from the originals, as one.
    expect([a!.style.left, a!.style.top, a!.style.translate]).toEqual(["100px", "100px", "40px 40px"]);
    expect([b!.style.left, b!.style.top, b!.style.translate]).toEqual(["400px", "300px", "40px 40px"]);
    // Again at the same spot, the whole group steps further aside.
    e.fromParent({ type: "slop:edit-paste", html });
    const [a2, b2] = e.selected() as HTMLElement[];
    expect(a2!.style.translate).toBe("80px 80px");
    expect(b2!.style.translate).toBe("80px 80px");
    // From the context menu, centered on its point as one: 500 × 300 around (960, 540).
    e.fromParent({ type: "slop:edit-paste", html, x: 960, y: 540 });
    const [a3, b3] = e.selected() as HTMLElement[];
    expect([a3!.style.left, a3!.style.top]).toEqual(["710px", "390px"]);
    expect([b3!.style.left, b3!.style.top]).toEqual(["1010px", "590px"]);
    e.pick("#a", "#b");
    e.key("x", { metaKey: true });
    expect(e.doc.querySelector("#a")).toBeNull();
    expect(e.doc.querySelector("#b")).toBeNull();
  });
});

describe("marquee", () => {
  const slide = (e: ReturnType<typeof editor>) => e.$("#intro");

  it("selects what lies fully inside as it is dragged out on the slide, without panning", () => {
    const e = editor();
    e.down(slide(e), 50, 50);
    e.move(slide(e), 700, 450);
    expect(e.ids()).toEqual(["a", "b"]);
    const box = e.$("[data-slop-marquee]");
    expect([box.style.display, box.style.width, box.style.height]).toEqual(["", "650px", "400px"]);
    e.move(slide(e), 500, 450);
    expect(e.ids()).toEqual(["a"]);
    e.up(slide(e), 500, 450);
    expect(box.style.display).toBe("none");
    expect(placement(e.$(".deck"))).toBe("translate(0px,0px) scale(1)");
    expect(e.commits()).toEqual([]);
  });

  it("finds elements in a see-through wrapper, which a drag from it does not move", () => {
    const e = editor();
    e.$("#wrap").getBoundingClientRect = () => new e.window.DOMRect(50, 50, 1800, 980);
    e.down(e.$("#wrap"), 1100, 600);
    e.move(e.$("#wrap"), 1400, 900);
    e.up(e.$("#wrap"), 1400, 900);
    expect(e.ids()).toEqual(["d"]);
    expect(e.$("#wrap").style.translate).toBe("");
  });

  it("selects the see-through wrapper on a click, and moves it once selected", () => {
    const e = editor();
    e.down(e.$("#wrap"), 1100, 600);
    e.up(e.$("#wrap"), 1100, 600);
    expect(e.ids()).toEqual(["wrap"]);
    const again = editor();
    again.fromParent({ type: "slop:edit-select", path: [3] });
    again.drag(again.$("#wrap"), 20, 0);
    expect(again.$("#wrap").style.translate).toBe("20px 0px");
  });

  it("adds to the selection with Shift held", () => {
    const e = editor();
    e.click(e.$("#c"));
    e.down(slide(e), 50, 50, { shiftKey: true });
    e.move(slide(e), 350, 250, { shiftKey: true });
    e.up(slide(e), 350, 250);
    expect(e.ids().sort()).toEqual(["a", "c"]);
  });

  it("deselects on a click on empty space, or keeps the selection with Shift", () => {
    const e = editor();
    e.click(e.$("#a"));
    e.down(slide(e), 50, 50, { shiftKey: true });
    e.up(slide(e), 50, 50);
    expect(e.ids()).toEqual(["a"]);
    e.down(slide(e), 50, 50);
    e.up(slide(e), 50, 50);
    expect(e.ids()).toEqual([]);
  });

  it("leaves dragging the space around the slide to the pasteboard, and Space+drag on it", () => {
    const e = editor();
    e.down(e.doc.body, 2000, 1200);
    e.move(e.doc.body, 2050, 1230);
    e.up(e.doc.body, 2050, 1230);
    expect(placement(e.$(".deck"))).toBe("translate(50px,30px) scale(1)");
    e.key(" ");
    e.down(slide(e), 50, 50);
    e.move(slide(e), 60, 50);
    e.up(slide(e), 60, 50);
    expect(placement(e.$(".deck"))).toBe("translate(60px,30px) scale(1)");
    expect(e.$("[data-slop-marquee]").style.display).toBe("none");
  });
});

describe("⌘A and Tab", () => {
  it("selects everything on the slide, through wrappers, but not the notes", () => {
    const e = editor();
    const key = e.key("a", { metaKey: true });
    expect(key.defaultPrevented).toBe(true);
    expect(e.ids()).toEqual(["a", "b", "c", "d"]);
    e.fromParent({ type: "slop:edit-select", path: null });
    e.fromParent({ type: "slop:edit-select-all" });
    expect(e.ids()).toEqual(["a", "b", "c", "d"]);
  });

  it("goes through the elements with Tab, and back with Shift+Tab, wrapping around", () => {
    const e = editor();
    const key = e.key("Tab");
    expect(key.defaultPrevented).toBe(true);
    expect(e.ids()).toEqual(["a"]);
    e.key("Tab");
    expect(e.ids()).toEqual(["b"]);
    e.key("Tab", { shiftKey: true });
    e.key("Tab", { shiftKey: true });
    expect(e.ids()).toEqual(["d"]);
    e.key("Tab");
    expect(e.ids()).toEqual(["a"]);
  });
});

describe("duplicating", () => {
  it("copies in place with ⌘D, offset and without its id, in one save", () => {
    const e = editor();
    e.click(e.$("#a"));
    expect(e.key("d", { metaKey: true }).defaultPrevented).toBe(true);
    const copy = e.last();
    expect(copy).not.toBe(e.$("#a"));
    expect(copy.textContent).toBe("A");
    expect(copy.id).toBe("");
    expect(copy.style.position).toBe("absolute");
    expect(e.$("#a").style.position).toBe("");
    expect([copy.style.left, copy.style.top]).toEqual(["140px", "140px"]);
    expect(e.selected()).toEqual([copy]);
    expect(e.commits()).toHaveLength(1);
  });

  it("copies all of the selection when the app asks", () => {
    const e = editor();
    e.fromParent({ type: "slop:edit-duplicate" });
    expect(e.commits()).toEqual([]);
    e.pick("#a", "#b");
    e.fromParent({ type: "slop:edit-duplicate" });
    expect(e.selected().map((el) => el.textContent)).toEqual(["A", "B"]);
    expect(e.selected().every((el) => !el.id)).toBe(true);
    expect(e.commits()).toHaveLength(1);
  });

  it("drags a copy with Alt, leaving the original", () => {
    const e = editor();
    const a = e.$("#a");
    e.drag(a, 150, 150, { altKey: true });
    const copy = e.last();
    expect(a.style.translate).toBe("");
    expect(copy.textContent).toBe("A");
    expect(copy.style.translate).toBe("150px 150px");
    expect(e.selected()).toEqual([copy]);
    expect(e.commits()).toHaveLength(1);
  });

  it("only copies when Alt-dragged past the threshold", () => {
    const e = editor();
    e.click(e.$("#a"), { altKey: true });
    expect(e.$("#intro").querySelectorAll("div")).toHaveLength(5);
  });
});

describe("smart guides", () => {
  const guides = (e: ReturnType<typeof editor>) => e.$("[data-slop-guides]").children;

  it("snaps a moved element's edges to another element's, with a guide line while dragging", () => {
    const e = editor();
    const a = e.$("#a");
    e.down(a);
    // a's left (100) lands 4px short of b's left (400).
    e.move(a, 396, 100);
    expect(a.style.translate).toBe("300px 0px");
    // Just as wide as b, so its center and right edge line up too.
    expect([...guides(e)].map((line) => (line as HTMLElement).style.left)).toEqual(["400px", "500px", "600px"]);
    e.up(a, 396, 100);
    expect(guides(e)).toHaveLength(0);
  });

  it("keeps a move straight across or up and down with Shift, still snapping along it", () => {
    const e = editor();
    const a = e.$("#a");
    e.down(a);
    e.move(a, 396, 130, { shiftKey: true });
    // Mostly across: it stays level, and its left edge snaps to b's.
    expect(a.style.translate).toBe("300px 0px");
    e.move(a, 130, 400, { shiftKey: true });
    expect(a.style.translate).toBe("0px 300px");
    e.up(a, 130, 400);
  });

  it("snaps to the slide's center and edges", () => {
    const e = editor();
    const a = e.$("#a");
    // a's center (200, 150) goes to the slide's (960, 540).
    e.drag(a, 763, 388);
    expect(a.style.translate).toBe("760px 390px");
    // Its left edge (860) comes 4px short of the slide's.
    e.drag(a, -856, 0);
    expect(a.style.translate).toBe("-100px 390px");
  });

  it("snaps the bounds of several elements together, not to each other", () => {
    const e = editor();
    e.pick("#a", "#b");
    // Their bounds' right edge (600) goes to c's left (800); a alone would hit nothing.
    e.drag(e.$("#a"), 197, 40);
    expect(e.$("#a").style.translate).toBe("200px 40px");
    expect(e.$("#b").style.translate).toBe("200px 40px");
  });

  it("does not snap with ⌘ or Ctrl held", () => {
    const e = editor();
    const a = e.$("#a");
    e.down(a);
    e.move(a, 396, 100, { metaKey: true });
    expect(a.style.translate).toBe("296px 0px");
    expect(guides(e)).toHaveLength(0);
    e.up(a, 396, 100);
  });

  it("snaps the dragged edge of a resize, and not with ⌘ or Shift", () => {
    const resize = (init: PointerEventInit) => {
      const e = editor();
      const a = e.$("#a");
      e.click(a);
      const handle = e.doc.querySelector('[data-dir="1 0"]')!;
      e.down(handle, 300, 150);
      // a's right edge (300) goes 4px short of b's left (400).
      e.move(handle, 396, 150, init);
      const size = a.style.width;
      e.up(handle, 396, 150);
      return { size, commits: e.commits().length };
    };
    expect(resize({}).size).toBe("300px");
    expect(resize({}).commits).toBe(1);
    expect(resize({ metaKey: true }).size).toBe("296px");
  });

  it("shows the position and size while dragging, and the turn while rotating", async () => {
    const e = editor();
    const a = e.$("#a");
    const readout = e.$("[data-slop-readout]");
    e.down(a);
    e.move(a, 150, 100, { metaKey: true });
    // The readout is filled in with the frame's geometry report.
    await e.frame();
    expect(readout.textContent).toBe("X 150  Y 100  W 200  H 100");
    expect(readout.style.display).toBe("");
    e.up(a, 150, 100);
    expect(readout.style.display).toBe("none");
  });
});

describe("align and distribute", () => {
  it("lines several elements up with their bounds, in one save", () => {
    const e = editor();
    e.pick("#a", "#b");
    e.fromParent({ type: "slop:edit-align", to: "left" });
    expect(e.$("#a").style.translate).toBe("");
    expect(e.$("#b").style.translate).toBe("-300px 0px");
    e.fromParent({ type: "slop:edit-align", to: "bottom" });
    expect(e.$("#a").style.translate).toBe("0px 200px");
    expect(e.$("#b").style.translate).toBe("-300px 0px");
    expect(e.commits()).toHaveLength(2);
    e.fromParent({ type: "slop:edit-align", to: "nowhere" });
    expect(e.commits()).toHaveLength(2);
  });

  it("centers on the bounds", () => {
    const e = editor();
    e.pick("#a", "#b");
    e.fromParent({ type: "slop:edit-align", to: "center" });
    // The bounds run from 100 to 600.
    expect(e.$("#a").style.translate).toBe("150px 0px");
    expect(e.$("#b").style.translate).toBe("-150px 0px");
    e.fromParent({ type: "slop:edit-align", to: "middle" });
    expect(e.$("#a").style.translate).toBe("150px 100px");
    expect(e.$("#b").style.translate).toBe("-150px -100px");
  });

  it("lines one element up with the slide", () => {
    const e = editor();
    e.click(e.$("#a"));
    e.fromParent({ type: "slop:edit-align", to: "right" });
    expect(e.$("#a").style.translate).toBe("1620px 0px");
    e.fromParent({ type: "slop:edit-align", to: "middle" });
    expect(e.$("#a").style.translate).toBe("1620px 390px");
  });

  it("lines several elements up with the slide, each on its own, or with their bounds when asked", () => {
    const e = editor();
    e.pick("#a", "#b");
    e.fromParent({ type: "slop:edit-align", to: "right", target: "slide" });
    expect(e.$("#a").style.translate).toBe("1620px 0px");
    expect(e.$("#b").style.translate).toBe("1320px 0px");
    e.fromParent({ type: "slop:edit-align", to: "top", target: "selection" });
    // a's top is 100, b's 300.
    expect(e.$("#b").style.translate).toBe("1320px -200px");
    // One element has no bounds of its own to align with, so it goes by the slide.
    e.click(e.$("#c"));
    e.fromParent({ type: "slop:edit-align", to: "left", target: "selection" });
    expect(e.$("#c").style.translate).toBe("-800px 0px");
  });

  it("matches the others' width or height to the primary element's", () => {
    const e = editor();
    e.$("#b").style.width = "300px";
    e.$("#b").style.height = "50px";
    e.pick("#b", "#a", "#c");
    e.fromParent({ type: "slop:edit-match", axis: "w" });
    expect(e.$("#a").style.width).toBe("300px");
    expect(e.$("#c").style.width).toBe("300px");
    expect(e.$("#b").style.width).toBe("300px");
    e.fromParent({ type: "slop:edit-match", axis: "h" });
    expect(e.$("#a").style.height).toBe("50px");
    expect(e.$("#c").style.height).toBe("50px");
    expect(e.commits()).toHaveLength(2);
    e.fromParent({ type: "slop:edit-match", axis: "depth" });
    expect(e.commits()).toHaveLength(2);
  });

  it("matches nothing with one element selected", () => {
    const e = editor();
    e.click(e.$("#a"));
    e.fromParent({ type: "slop:edit-match", axis: "w" });
    expect(e.commits()).toEqual([]);
  });

  it("evens out the gaps between three or more, the outer two staying put", () => {
    const e = editor();
    e.pick("#c", "#a", "#b");
    e.$("#b").style.translate = "-200px -100px";
    e.fromParent({ type: "slop:edit-distribute", axis: "h" });
    // From 100 to 1000 with 300 free: gaps of 150; b is at 450.
    expect(e.$("#a").style.translate).toBe("");
    expect(e.$("#c").style.translate).toBe("");
    expect(e.$("#b").style.translate).toBe("50px -100px");
    e.fromParent({ type: "slop:edit-distribute", axis: "v" });
    // From 100 to 600 with 300 free: gaps of 100; b's top is at 300.
    expect(e.$("#b").style.translate).toBe("50px 0px");
    expect(e.commits()).toHaveLength(2);
  });

  it("does not distribute two elements", () => {
    const e = editor();
    e.pick("#a", "#c");
    e.fromParent({ type: "slop:edit-distribute", axis: "h" });
    expect(e.commits()).toEqual([]);
  });
});

describe("geometry", () => {
  const reported = async (e: ReturnType<typeof editor>) => {
    await vi.waitFor(() => expect(e.posted().some((m) => m.type === "slop:edit-geometry")).toBe(true));
    return e
      .posted()
      .filter((m) => m.type === "slop:edit-geometry")
      .at(-1)!.geometry;
  };

  it("reports one element's box and turn, once per change", async () => {
    const e = editor();
    e.click(e.$("#a"));
    expect(await reported(e)).toEqual({ count: 1, x: 100, y: 100, w: 200, h: 100, rotation: 0 });
  });

  it("reports the bounds of several, without a turn", async () => {
    const e = editor();
    e.pick("#a", "#b");
    await vi.waitFor(async () => expect(await reported(e)).toMatchObject({ count: 2 }));
    expect(await reported(e)).toEqual({ count: 2, x: 100, y: 100, w: 500, h: 300, rotation: null });
  });

  it("reports when nothing is selected any more", async () => {
    const e = editor();
    e.click(e.$("#a"));
    await reported(e);
    e.key("Escape");
    await vi.waitFor(async () => expect(await reported(e)).toBeNull());
  });

  it("moves to a typed position, and several elements together", () => {
    const e = editor();
    e.click(e.$("#a"));
    e.fromParent({ type: "slop:edit-geometry", x: 150, y: 90 });
    expect(e.$("#a").style.translate).toBe("50px -10px");
    expect(e.commits()).toHaveLength(1);
    e.click(e.$("#a"));
    e.click(e.$("#b"), { shiftKey: true });
    e.fromParent({ type: "slop:edit-geometry", x: 100, w: 999, rotation: 30 });
    expect(e.$("#a").style.translate).toBe("0px -10px");
    expect(e.$("#b").style.translate).toBe("-50px 0px");
    // Several elements have no size or rotation to type.
    expect(e.$("#a").style.rotate).toBe("");
    expect(e.$("#a").style.width).toBe("");
  });

  it("sets a typed size with the top left staying put, and a typed rotation", () => {
    const e = editor();
    e.click(e.$("#a"));
    e.fromParent({ type: "slop:edit-geometry", w: 300 });
    expect(e.$("#a").style.width).toBe("300px");
    e.fromParent({ type: "slop:edit-geometry", rotation: 45 });
    expect(e.$("#a").style.rotate).toBe("45deg");
    expect(e.commits()).toHaveLength(2);
  });

  it("stretches a typed size in Stretch mode", () => {
    const e = editor();
    e.fromParent({ type: "slop:edit-size-mode", mode: "stretch" });
    e.click(e.$("#a"));
    e.fromParent({ type: "slop:edit-geometry", w: 400 });
    expect(e.$("#a").style.scale).toBe("2 1");
    expect(e.$("#a").style.width).toBe("");
  });

  it("ignores numbers with nothing selected", () => {
    const e = editor();
    e.fromParent({ type: "slop:edit-geometry", x: 10 });
    expect(e.commits()).toEqual([]);
  });
});

describe("groups, locks and layers", () => {
  /** Lays out what sits in a group (or was moved onto the slide) from its inline box, in what holds it. */
  const nest = (e: ReturnType<typeof editor>) => {
    const px = (v: string) => Number.parseFloat(v) || 0;
    const slide = e.$("#intro");
    const place = (el: HTMLElement) => {
      const fixed = BOXES[el.id];
      const [dx = 0, dy = 0] = (el.style.translate.match(/-?[\d.]+/g) ?? []).map(Number);
      const w = px(el.style.width) || fixed?.[2] || 0;
      const h = px(el.style.height) || fixed?.[3] || 0;
      if (el.style.position !== "absolute" && fixed) return new e.window.DOMRect(fixed[0]! + dx, fixed[1]! + dy, w, h);
      const holder = el.parentElement!;
      const base = holder === slide ? { left: 0, top: 0 } : holder.getBoundingClientRect();
      return new e.window.DOMRect(base.left + px(el.style.left) + dx, base.top + px(el.style.top) + dy, w, h);
    };
    for (const el of [...slide.querySelectorAll<HTMLElement>("*")]) el.getBoundingClientRect = () => place(el);
    const group = () => e.$("[data-group]");
    return { group, place };
  };
  const grouped = () => {
    const e = editor();
    nest(e);
    e.pick("#a", "#b");
    e.key("g", { metaKey: true });
    const group = e.$("[data-group]");
    group.getBoundingClientRect = () => {
      const px = (v: string) => Number.parseFloat(v) || 0;
      const [dx = 0, dy = 0] = (group.style.translate.match(/-?[\d.]+/g) ?? []).map(Number);
      return new e.window.DOMRect(
        px(group.style.left) + dx,
        px(group.style.top) + dy,
        px(group.style.width),
        px(group.style.height),
      );
    };
    Object.defineProperty(group, "offsetWidth", {
      get: () => Number.parseFloat(group.style.width),
      configurable: true,
    });
    Object.defineProperty(group, "offsetHeight", {
      get: () => Number.parseFloat(group.style.height),
      configurable: true,
    });
    return { e, group };
  };
  const double = (e: ReturnType<typeof editor>, el: Element) => {
    e.click(el);
    e.click(el);
  };
  const layers = async (e: ReturnType<typeof editor>) => {
    await vi.waitFor(() => expect(e.posted().some((m) => m.type === "slop:edit-layers")).toBe(true));
    return e
      .posted()
      .filter((m) => m.type === "slop:edit-layers")
      .at(-1)!.layers as { path: number[]; name: string; depth: number; locked: boolean; selected: boolean }[];
  };

  it("groups the selection with ⌘G into a box around it, saved and selected as one", () => {
    const { e, group } = grouped();
    expect(group.parentElement).toBe(e.$("#intro"));
    expect(group.style).toMatchObject({
      position: "absolute",
      left: "100px",
      top: "100px",
      width: "500px",
      height: "300px",
    });
    expect([...group.children].map((el) => el.id)).toEqual(["a", "b"]);
    expect(e.$("#a").style).toMatchObject({
      position: "absolute",
      left: "0px",
      top: "0px",
      width: "200px",
      height: "100px",
    });
    expect(e.$("#b").style).toMatchObject({ left: "300px", top: "200px" });
    // What was in the layout leaves its slot behind, so the rest stays put.
    expect(e.doc.querySelectorAll("#intro > [data-resize-placeholder]")).toHaveLength(2);
    expect(e.selected()).toEqual([group]);
    expect(e.commits()).toHaveLength(1);
    expect(e.commits()[0]!.markup).toContain("<div data-group=");
    // Dragging what it holds moves the group, as one; a click on it selects the group.
    e.drag(e.$("#b"), 20, 10);
    expect(group.style.translate).toBe("20px 10px");
    expect(e.$("#b").style.translate).toBe("");
    e.click(e.$("#c"));
    e.click(e.$("#a"));
    expect(e.selected()).toEqual([group]);
  });

  it("goes into a group on a double-click, to select what it holds, until something else is picked", () => {
    const { e, group } = grouped();
    double(e, e.$("#a"));
    expect(e.ids()).toEqual(["a"]);
    e.click(e.$("#b"));
    expect(e.ids()).toEqual(["b"]);
    // Escape goes back out to the group.
    e.key("Escape");
    expect(e.selected()).toEqual([group]);
    e.click(e.$("#a"));
    expect(e.selected()).toEqual([group]);
    double(e, e.$("#a"));
    e.click(e.$("#c"));
    e.click(e.$("#a"));
    expect(e.selected()).toEqual([group]);
  });

  it("takes a group apart with ⇧⌘G, everything staying where it shows", () => {
    const { e, group } = grouped();
    e.drag(group, 50, 0);
    e.key("g", { metaKey: true, shiftKey: true });
    expect(e.doc.querySelector("[data-group]")).toBeNull();
    expect(e.ids()).toEqual(["a", "b"]);
    expect(e.$("#a").parentElement).toBe(e.$("#intro"));
    expect(e.$("#a").style).toMatchObject({ left: "150px", top: "100px", translate: "" });
    expect(e.$("#b").style).toMatchObject({ left: "450px", top: "300px" });
    expect(e.commits().at(-1)!.markup).not.toContain("data-group");
  });

  it("gives a group a size to type, which spreads what it holds", () => {
    const { e } = grouped();
    e.fromParent({ type: "slop:edit-geometry", w: 1000 });
    expect(e.$("[data-group]").style.width).toBe("1000px");
    expect(e.$("#a").style).toMatchObject({ left: "0px", width: "400px", height: "100px" });
    expect(e.$("#b").style).toMatchObject({ left: "600px", width: "400px" });
  });

  it("restyles everything in a group, in one save", () => {
    const { e } = grouped();
    e.fromParent({ type: "slop:edit-style", style: { color: "#00ff00" } });
    expect(e.$("#a").style.color).toBe("rgb(0, 255, 0)");
    expect(e.$("#b").style.color).toBe("rgb(0, 255, 0)");
    expect(e.$("[data-group]").style.color).toBe("");
    expect(e.commits()).toHaveLength(2);
    expect(e.selected()).toEqual([e.$("[data-group]")]);
  });

  it("reports a group as one, with its first element's look", () => {
    const { e } = grouped();
    const selection = e
      .posted()
      .filter((m) => m.type === "slop:edit-selection")
      .at(-1)!.selection as Record<string, unknown>;
    expect(selection).toMatchObject({ kind: "group", group: true, fill: "#ff0000", flippable: false });
  });

  it("does not group one element", () => {
    const e = editor();
    e.click(e.$("#a"));
    e.key("g", { metaKey: true });
    expect(e.doc.querySelector("[data-group]")).toBeNull();
    expect(e.commits()).toEqual([]);
  });

  it("keeps a locked element from being picked, moved or deleted, but lets it be unlocked", () => {
    const e = editor();
    e.click(e.$("#a"));
    e.fromParent({ type: "slop:edit-lock", locked: true });
    expect(e.$("#a").hasAttribute("data-lock")).toBe(true);
    expect(e.commits().at(-1)!.markup).toContain('id="a" style="background: red" data-lock=""');
    // Still selected, with its frame but no handles.
    expect(e.$("[data-slop-ui]").hasAttribute("data-locked")).toBe(true);
    e.key("ArrowRight");
    expect(e.$("#a").style.translate).toBe("");
    e.key("Delete");
    expect(e.$("#a").isConnected).toBe(true);
    e.fromParent({ type: "slop:edit-geometry", x: 500 });
    expect(e.$("#a").style.translate).toBe("");
    e.key("Escape");
    e.click(e.$("#a"));
    expect(e.ids()).toEqual([]);
    e.fromParent({ type: "slop:edit-select-all" });
    expect(e.ids()).toEqual(["b", "c", "d"]);
    e.fromParent({ type: "slop:edit-lock", locked: false, path: [0] });
    expect(e.$("#a").hasAttribute("data-lock")).toBe(false);
    e.click(e.$("#a"));
    expect(e.ids()).toEqual(["a"]);
  });

  it("lists the slide's layers, the top-most first, with what a group holds under it", async () => {
    const { e } = grouped();
    const rows = await layers(e);
    // The group is positioned, so above what is not; what is in a wrapper comes later on the slide.
    expect(rows.map((r) => [r.name, r.depth])).toEqual([
      ["Group of 2", 0],
      ["Box: B", 1],
      ["Box: A", 1],
      ["Box: D", 0],
      ["Box: C", 0],
    ]);
    expect(rows.map((r) => r.selected)).toEqual([true, false, false, false, false]);
    const group = rows[0]!.path;
    expect(rows[1]!.path).toEqual([...group, 1]);
    // A layer goes up past the next one, whether or not they overlap.
    e.fromParent({ type: "slop:edit-order", to: "forward", path: rows[3]!.path, any: true });
    // As high as the group, and later in the slide, so above it.
    expect(e.$("#d").style).toMatchObject({ position: "relative", zIndex: "0" });
    await vi.waitFor(async () => expect((await layers(e))[0]!.name).toBe("Box: D"));
    e.fromParent({ type: "slop:edit-lock", locked: true, path: rows[4]!.path });
    await vi.waitFor(async () => expect((await layers(e)).at(-1)).toMatchObject({ name: "Box: C", locked: true }));
  });
});

describe("the layer list on load", () => {
  it("is reported once the editor starts, before anything changes", async () => {
    const e = editor();
    await vi.waitFor(() => expect(e.posted().some((m) => m.type === "slop:edit-layers")).toBe(true));
    const rows = e.posted().find((m) => m.type === "slop:edit-layers")!.layers as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(["Box: D", "Box: C", "Box: B", "Box: A"]);
  });
});

describe("keeping up with the pointer", () => {
  const finder = (e: ReturnType<typeof editor>) =>
    vi.spyOn((e.window as unknown as { __slopOverflow: { find: () => unknown[] } }).__slopOverflow, "find");
  const wires = (e: ReturnType<typeof editor>) => [...e.doc.querySelectorAll<HTMLElement>("[data-slop-overflow] > *")];

  it("does not look for overflow while a drag is under way, and does once it ends", async () => {
    const e = editor();
    await e.frame();
    const find = finder(e);
    const a = e.$("#a");
    e.down(a);
    await e.frame();
    find.mockClear();
    for (let i = 1; i <= 20; i++) {
      e.move(a, 100 + i * 10, 100);
      if (i % 5 === 0) await e.frame();
    }
    expect(find).not.toHaveBeenCalled();
    e.up(a, 300, 100);
    await e.frame();
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("does not look for overflow while a handle resizes, turns or tilts an element", async () => {
    const e = editor();
    e.click(e.$("#a"));
    await e.frame();
    const find = finder(e);
    for (const kind of ['[data-dir="1 1"]', "[data-handle=rotate]", "[data-handle=tilt]"]) {
      const handle = e.$(`[data-slop-ui] ${kind}`);
      e.down(handle, 300, 200);
      for (let i = 1; i <= 5; i++) e.move(handle, 300 + i * 8, 200 + i * 8);
      await e.frame();
      expect(find).not.toHaveBeenCalled();
      e.up(handle, 340, 240);
      await e.frame();
      expect(find).toHaveBeenCalledTimes(1);
      find.mockClear();
    }
  });

  it("does not list the layers while a marquee grows, and does once it ends", async () => {
    const e = editor();
    await e.frame();
    const layers = () => e.messages("slop:edit-layers").length;
    const before = layers();
    const find = finder(e);
    e.down(e.$("#intro"), 50, 50);
    for (let i = 1; i <= 6; i++) e.move(e.$("#intro"), 50 + i * 100, 50 + i * 60);
    await e.frame();
    expect(e.ids()).toEqual(["a", "b"]);
    expect(layers()).toBe(before);
    expect(find).not.toHaveBeenCalled();
    e.up(e.$("#intro"), 650, 410);
    await e.frame();
    // The layers say what is selected.
    expect(layers()).toBe(before + 1);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("does not look for overflow while an element is dragged out with a tool", async () => {
    const e = editor();
    await e.frame();
    const find = finder(e);
    e.fromParent({ type: "slop:edit-tool", tool: "rect", style: {} });
    e.down(e.$("#intro"), 100, 600);
    for (let i = 1; i <= 10; i++) e.move(e.$("#intro"), 100 + i * 20, 600 + i * 10);
    await e.frame();
    expect(find).not.toHaveBeenCalled();
    e.up(e.$("#intro"), 300, 700);
    await e.frame();
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("moves the overflow wires with the view without measuring the slide again", async () => {
    const e = editor();
    e.lay(e.$("#c"), 1800, 500, 200, 100);
    e.click(e.$("#a"));
    await e.frame();
    const [wire] = wires(e);
    expect([wire!.style.left, wire!.style.top, wire!.style.width]).toEqual(["1800px", "500px", "120px"]);
    const find = finder(e);
    e.fromParent({ type: "slop:camera", x: -100, y: 30, k: 1 });
    await e.frame();
    expect(find).not.toHaveBeenCalled();
    // The same wire, where the element shows now.
    expect(wires(e)).toEqual([wire]);
    expect([wire!.style.left, wire!.style.top, wire!.style.width]).toEqual(["1700px", "530px", "200px"]);
    expect(e.messages("slop:edit-overflow")).toHaveLength(1);
  });

  it("places the handles once per frame however many elements move, keeping each frame's node", async () => {
    const e = editor();
    e.pick("#a", "#b", "#c");
    const frames = [...e.$("[data-slop-multi]").children] as HTMLElement[];
    expect(frames.map((f) => f.style.left)).toEqual(["100px", "400px", "800px"]);
    const a = e.$("#a");
    e.down(a);
    e.move(a, 110, 100, { metaKey: true });
    await e.frame();
    const counts = ["#a", "#b", "#c"].map((id) => e.measured(e.$(id)));
    for (let i = 2; i <= 12; i++) e.move(a, 100 + i * 10, 100, { metaKey: true });
    // Every element moved with every event, and none was measured for it.
    expect(e.$("#c").style.translate).toBe("120px 0px");
    expect(counts.map((c) => c.count())).toEqual([0, 0, 0]);
    expect(frames.map((f) => f.style.left)).toEqual(["110px", "410px", "810px"]);
    await e.frame();
    expect(counts.map((c) => c.count())).toEqual([1, 1, 1]);
    expect([...e.$("[data-slop-multi]").children]).toEqual(frames);
    expect(frames.map((f) => f.style.left)).toEqual(["220px", "520px", "920px"]);
    e.up(a, 220, 100);
  });

  it("has the handles in place as soon as a drag ends", () => {
    const e = editor();
    const a = e.$("#a");
    const ui = e.$("[data-slop-ui]");
    e.down(a);
    expect(ui.style.left).toBe("100px");
    e.move(a, 150, 100, { metaKey: true });
    e.up(a, 150, 100);
    expect(ui.style.left).toBe("150px");
  });

  it("fills the drag's readout from where the move started, without measuring", async () => {
    const e = editor();
    const a = e.$("#a");
    const readout = e.$("[data-slop-readout]");
    e.down(a);
    e.move(a, 110, 100, { metaKey: true });
    await e.frame();
    const count = e.measured(a);
    e.move(a, 150, 130, { metaKey: true });
    e.move(a, 170, 140, { metaKey: true });
    expect(count.count()).toBe(0);
    await e.frame();
    expect(readout.textContent).toBe("X 170  Y 140  W 200  H 100");
    expect([readout.style.left, readout.style.top]).toEqual(["184px", "158px"]);
    // Once for the handles; the readout and the report to the app took nothing.
    expect(count.count()).toBe(1);
    expect(e.messages<{ geometry: object }>("slop:edit-geometry").at(-1)!.geometry).toMatchObject({ x: 170, y: 140 });
    e.up(a, 170, 140);
    await e.frame();
    expect(e.messages<{ geometry: object }>("slop:edit-geometry").at(-1)!.geometry).toMatchObject({ x: 170, y: 140 });
  });

  it("does not measure the slide to know the zoom: the pasteboard tells", async () => {
    const e = editor();
    await e.frame();
    const slide = e.measured(e.$("#intro"));
    const a = e.$("#a");
    e.fromParent({ type: "slop:camera", x: 0, y: 0, k: 0.5 });
    e.down(a);
    for (let i = 1; i <= 10; i++) e.move(a, 100 + i * 10, 100, { metaKey: true });
    // Ten screen pixels are twenty of the slide's at half size.
    expect(a.style.translate).toBe("200px 0px");
    e.move(e.$("#b"), 500, 350);
    e.fromParent({ type: "slop:edit-geometry", x: 300 });
    expect(slide.count()).toBe(0);
    e.up(a, 200, 100);
  });

  it("measures the slide for the zoom when the pasteboard does not tell", () => {
    const e = editor({ beforeEditor: "delete window.slopPasteboard.scale; delete window.slopPasteboard.origin;" });
    const slide = e.$("#intro");
    slide.getBoundingClientRect = () => new e.window.DOMRect(0, 0, 960, 540);
    Object.defineProperty(slide, "offsetWidth", { value: 1920, configurable: true });
    e.down(e.$("#a"));
    e.move(e.$("#a"), 200, 50, { metaKey: true });
    e.up(e.$("#a"), 200, 50);
    expect(e.$("#a").style.translate).toBe("200px -100px");
  });

  it("measures the slide's elements once per marquee, and reports the selection once per frame", async () => {
    const e = editor();
    await e.frame();
    const counts = ["#a", "#b", "#c", "#d"].map((id) => e.measured(e.$(id)));
    const reports = () => e.messages("slop:edit-selection").length;
    const before = reports();
    e.down(e.$("#intro"), 50, 50);
    for (let i = 1; i <= 6; i++) e.move(e.$("#intro"), 50 + i * 100, 50 + i * 60);
    // What is inside is marked with every move.
    expect(e.ids()).toEqual(["a", "b"]);
    expect(reports()).toBe(before);
    await e.frame();
    expect(reports()).toBe(before + 1);
    // Once each to know where it is; the two selected once more for their frames, and once for
    // the bounds the app is told.
    expect(counts.map((c) => c.count())).toEqual([3, 3, 1, 1]);
    e.move(e.$("#intro"), 1100, 700);
    e.up(e.$("#intro"), 1100, 700);
    // The last of it is reported at once.
    expect(e.ids()).toEqual(["a", "b", "c"]);
    expect(e.messages<{ selected: boolean }>("slop:edit-selection").at(-1)!.selected).toBe(true);
    expect(reports()).toBe(before + 2);
    expect(e.$("[data-slop-multi]").children).toHaveLength(3);
  });

  it("leaves the guides as they are while a move keeps to the same ones", () => {
    const e = editor();
    const a = e.$("#a");
    const layer = e.$("[data-slop-guides]");
    e.down(a);
    // a's left edge snaps to b's (400) from anywhere close.
    e.move(a, 396, 100);
    const drawn = [...layer.children];
    expect(drawn.length).toBeGreaterThan(0);
    const changes: MutationRecord[] = [];
    const observer = new e.window.MutationObserver((records) => changes.push(...records));
    observer.observe(layer, { childList: true, subtree: true, attributes: true });
    e.move(a, 398, 100);
    e.move(a, 402, 100);
    changes.push(...observer.takeRecords());
    expect(a.style.translate).toBe("300px 0px");
    expect(changes).toEqual([]);
    // Other guides reuse the lines that are there.
    e.move(a, 396, 396);
    expect([...layer.children].slice(0, drawn.length)).toEqual(drawn);
    e.up(a, 396, 396);
    observer.disconnect();
    expect(layer.children).toHaveLength(0);
  });

  it("names the nudges of the same elements as one group for the app to undo together", () => {
    vi.useFakeTimers();
    const e = editor();
    e.pick("#a", "#b");
    e.key("ArrowRight");
    e.key("ArrowRight");
    vi.advanceTimersByTime(600);
    e.key("ArrowDown");
    vi.advanceTimersByTime(600);
    expect(e.commits()).toHaveLength(2);
    expect(e.commits().map((c) => c.group)).toEqual(["nudge:0,1", "nudge:0,1"]);
    // Another selection is another group, and saved by something else, a nudge still has its name.
    e.click(e.$("#c"));
    e.key("ArrowDown");
    e.key("z", { metaKey: true });
    expect(e.commits().at(-1)!.group).toBe("nudge:2");
    // Anything else saves without one.
    e.fromParent({ type: "slop:edit-align", to: "left" });
    expect(e.commits()).toHaveLength(4);
    expect("group" in e.commits().at(-1)!).toBe(false);
    e.fromParent({ type: "slop:edit-tilt", x: 15, y: 0 });
    vi.advanceTimersByTime(600);
    expect("group" in e.commits().at(-1)!).toBe(false);
    // Nudges saved together with a tilt step are not only nudges.
    e.fromParent({ type: "slop:edit-tilt", x: 15, y: 0 });
    e.key("ArrowDown");
    vi.advanceTimersByTime(600);
    expect(e.commits()).toHaveLength(6);
    expect("group" in e.commits().at(-1)!).toBe(false);
  });
});
