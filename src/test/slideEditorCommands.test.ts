// @vitest-environment node
/**
 * The slide editor's commands (src-tauri/assets/editor/47-commands.js): the shortcuts with ⌘ /
 * Ctrl, flips, text size steps, copying a look, clearing formatting, unlocking, the context menu's
 * report, snapping on and off, and previewing a restyle.
 */
import { describe, expect, it } from "vitest";
import { editorPage } from "./slideEditorPage";

const box = (id: string, left: number, top: number, extra = "") =>
  `<div id="${id}" data-added="shape" style="position: absolute; left: ${left}px; top: ${top}px; width: 200px; height: 100px; ${extra}">${id.toUpperCase()}</div>`;
const LINE =
  '<svg id="line" data-added="drawing" viewBox="0 0 100 20" style="position: absolute; left: 10px; top: 10px; width: 100px; height: 20px"><path d="M2 2 L98 18" fill="none" stroke="#111111" stroke-width="4"></path></svg>';
const DECK = `<!DOCTYPE html><html><head></head><body>
<main class="deck">
  <section class="slide" id="intro">
    <h1 class="title" style="color: red; font-size: 40px">Hello <b>big</b> <a href="#outro">link</a></h1>
    ${box("a", 100, 100, "font-size: 48px;")}
    ${box("b", 400, 300, "font-size: 48px;")}
    <img id="pic" src="assets/pic.png" alt="" style="position: absolute; left: 0px; top: 0px; width: 50px; height: 50px">
    ${LINE}
  </section>
  <section class="slide" id="outro"><p>Bye</p></section>
</main></body></html>`;

function editor(markup = DECK) {
  const e = editorPage({ markup });
  return {
    ...e,
    pick(first: string, ...more: string[]) {
      e.down(e.$(first));
      e.up(e.$(first));
      for (const selector of more) e.click(e.$(selector), { shiftKey: true });
    },
    rightClick(target: Element) {
      target.dispatchEvent(
        new e.window.MouseEvent("contextmenu", { clientX: 120, clientY: 80, bubbles: true, cancelable: true }),
      );
    },
    menu: () => e.messages<Record<string, unknown>>("slop:edit-menu").at(-1)!,
  };
}

describe("shortcuts on the selection", () => {
  it("restacks with ⌘] and ⌘[, to the front and back with Shift", () => {
    const e = editor();
    e.pick("#a");
    const event = e.key("]", { metaKey: true, shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(e.$("#a").style.zIndex).not.toBe("");
    expect(e.commits()).toHaveLength(1);
    const front = e.$("#a").style.zIndex;
    e.key("{", { metaKey: true, shiftKey: true, code: "BracketLeft" });
    expect(e.$("#a").style.zIndex).not.toBe(front);
    // The editor took the keys: they do not go on to the app.
    expect(e.keys()).toEqual([]);
  });

  it("leaves the keys to the app with nothing selected", () => {
    const e = editor();
    const event = e.key("]", { metaKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(e.commits()).toEqual([]);
  });

  it("aligns text with ⌘⇧L / E / R / J, also while typing", () => {
    const e = editor();
    e.pick("#a");
    e.key("E", { metaKey: true, shiftKey: true });
    expect(e.$("#a").style.textAlign).toBe("center");
    e.key("J", { ctrlKey: true, shiftKey: true });
    expect(e.$("#a").style.textAlign).toBe("justify");
    expect(e.messages<{ selection: { align: string } }>("slop:edit-selection").at(-1)!.selection.align).toBe("justify");
    e.key("Enter");
    expect(e.$("#a").hasAttribute("contenteditable")).toBe(true);
    e.key("R", { metaKey: true, shiftKey: true });
    expect(e.$("#a").style.textAlign).toBe("right");
    e.key("L", { metaKey: true, shiftKey: true });
    expect(e.$("#a").style.textAlign).toBe("left");
  });

  it("does not align what holds no text", () => {
    const e = editor();
    e.pick("#pic");
    expect(e.key("E", { metaKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(e.$("#pic").style.textAlign).toBe("");
  });

  it("steps the text size with ⌘⇧. and ⌘⇧,", () => {
    const e = editor();
    e.pick("#a", "#b");
    e.key(">", { metaKey: true, shiftKey: true });
    expect([e.$("#a").style.fontSize, e.$("#b").style.fontSize]).toEqual(["56px", "56px"]);
    expect(e.commits()).toHaveLength(1);
    e.key(",", { metaKey: true, shiftKey: true, code: "Comma" });
    e.key("<", { metaKey: true, shiftKey: true });
    expect(e.$("#a").style.fontSize).toBe("40px");
    e.fromParent({ type: "slop:edit-font-step", step: 1 });
    expect(e.$("#a").style.fontSize).toBe("48px");
  });

  it("locks and unlocks with ⌘⌥L, by where the key is", () => {
    const e = editor();
    e.pick("#a");
    e.key("¬", { metaKey: true, altKey: true, code: "KeyL" });
    expect(e.$("#a").hasAttribute("data-lock")).toBe(true);
    e.key("¬", { metaKey: true, altKey: true, code: "KeyL" });
    expect(e.$("#a").hasAttribute("data-lock")).toBe(false);
    expect(e.commits()).toHaveLength(2);
  });

  it("asks the app for its Link popover with ⌘K, also while typing", () => {
    const e = editor();
    e.pick("#a");
    expect(e.key("k", { metaKey: true }).defaultPrevented).toBe(true);
    e.key("Enter");
    e.key("k", { metaKey: true });
    expect(e.messages("slop:edit-request")).toEqual([
      { type: "slop:edit-request", slide: "intro", what: "link" },
      { type: "slop:edit-request", slide: "intro", what: "link" },
    ]);
  });

  it("copies a look with ⌘⌥C and pastes the one the app kept with ⌘⌥V", () => {
    const e = editor();
    e.pick("#a");
    e.fromParent({ type: "slop:edit-style", style: { fill: "#ff0000", opacity: 0.5, bold: true } });
    e.key("ç", { metaKey: true, altKey: true, code: "KeyC" });
    const copied = e.messages<{ style: Record<string, Record<string, unknown>> }>("slop:edit-style-copied");
    expect(copied).toHaveLength(1);
    expect(copied[0]!.style.paint!.fill).toBe("#ff0000");
    expect(copied[0]!.style.shared!.opacity).toBe(0.5);
    e.pick("#b", "#pic");
    e.key("√", { metaKey: true, altKey: true, code: "KeyV" });
    expect(e.messages("slop:edit-request").at(-1)).toMatchObject({ what: "paste-style" });
    const before = e.commits().length;
    e.fromParent({ type: "slop:edit-paste-style", style: copied[0]!.style });
    expect(e.$("#b").style.backgroundColor).toBe("rgb(255, 0, 0)");
    expect(e.$("#b").style.fontWeight).toBe("700");
    expect([e.$("#b").style.opacity, e.$("#pic").style.opacity]).toEqual(["0.5", "0.5"]);
    // An image takes the look, but no text styles.
    expect(e.$("#pic").style.fontWeight).toBe("");
    expect(e.commits()).toHaveLength(before + 1);
    expect(e.selected()).toEqual([e.$("#b"), e.$("#pic")]);
  });

  it("ignores a pasted look that is not one", () => {
    const e = editor();
    e.pick("#a");
    for (const style of [null, 3, "x", {}, { shared: {}, paint: [], text: {} }]) {
      e.fromParent({ type: "slop:edit-paste-style", style });
    }
    expect(e.commits()).toEqual([]);
  });

  it("flips with ⌘⇧H and ⌘⇧V, every selected element that can flip, and back again", () => {
    const e = editor();
    e.pick("#pic", "#a", "#line");
    const path = () => e.$("#line path").getAttribute("d");
    const drawn = path();
    e.key("H", { metaKey: true, shiftKey: true });
    expect(e.$("#pic").style.transform).toContain("scaleX(-1)");
    // A plain box does not flip; a line is mirrored through its points.
    expect(e.$("#a").style.transform).toBe("");
    expect(path()).not.toBe(drawn);
    expect(e.commits()).toHaveLength(1);
    e.key("H", { metaKey: true, shiftKey: true });
    expect(e.$("#pic").style.transform).toBe("");
    expect(path()).toBe(drawn);
    e.fromParent({ type: "slop:edit-flip", axis: "y" });
    expect(e.$("#pic").style.transform).toContain("scaleY(-1)");
    e.key("V", { metaKey: true, shiftKey: true });
    expect(e.$("#pic").style.transform).toBe("");
    expect(e.selected()).toHaveLength(3);
  });
});

describe("clear formatting", () => {
  it("unwraps the inline formatting of the selection's text, keeping its links", () => {
    const e = editor();
    e.pick("h1");
    e.fromParent({ type: "slop:edit-clear-formatting" });
    expect(e.$("h1").innerHTML).toBe('Hello big <a href="#outro">link</a>');
    // An element of the deck's goes back to the deck's styles.
    expect(e.$("h1").hasAttribute("style")).toBe(false);
    expect(e.commits()).toHaveLength(1);
  });

  it("keeps the look a text box the user added has as a whole", () => {
    const e = editor(DECK.replace(">A</div>", '><i>A</i> <span style="color: blue">x</span></div>'));
    e.pick("#a");
    e.fromParent({ type: "slop:edit-clear-formatting" });
    expect(e.$("#a").textContent).toBe("A x");
    expect(e.$("#a").querySelector("i, span")).toBeNull();
    expect(e.$("#a").style.fontSize).toBe("48px");
  });
});

describe("locked elements", () => {
  const LOCKED = DECK.replace('id="a" data-added="shape"', 'id="a" data-added="shape" data-lock=""');

  it("selects a locked element on a click, so it can be unlocked", () => {
    const e = editor(LOCKED);
    e.click(e.$("#a"));
    expect(e.selected()).toEqual([e.$("#a")]);
    // Something in a locked element is as locked: the click selects what holds the lock.
    const held = e.doc.createElement("p");
    held.textContent = "Held";
    e.$("#a").append(held);
    e.click(e.$("#b"));
    e.click(held);
    expect(e.selected()).toEqual([e.$("#a")]);
  });

  it("selects a locked element on a right-click, so the menu can unlock it", () => {
    const e = editor(LOCKED);
    e.rightClick(e.$("#a"));
    expect(e.selected()).toEqual([e.$("#a")]);
    expect(e.menu()).toMatchObject({ locked: true, editable: false });
    expect((e.menu().elements as unknown[]).length).toBe(1);
  });

  it("prefers what is not locked, and reports an empty spot as one", () => {
    const e = editor(LOCKED);
    e.rightClick(e.$("#b"));
    expect(e.selected()).toEqual([e.$("#b")]);
    e.rightClick(e.$("#intro"));
    expect(e.menu()).toMatchObject({ element: null, elements: [], editable: false, locked: true });
  });

  it("unlocks everything on the slide when asked", () => {
    const e = editor(LOCKED.replace('id="b" data-added="shape"', 'id="b" data-added="shape" data-lock=""'));
    e.fromParent({ type: "slop:edit-unlock-all" });
    expect(e.doc.querySelectorAll("[data-lock]")).toHaveLength(0);
    expect(e.commits()).toHaveLength(1);
    e.fromParent({ type: "slop:edit-unlock-all" });
    expect(e.commits()).toHaveLength(1);
  });
});

describe("context menu report", () => {
  it("lists every selected element, in the slide's order", () => {
    const e = editor();
    e.pick("#b", "#a");
    e.rightClick(e.$("#a"));
    const menu = e.menu();
    expect((menu.elements as { name: string }[]).map((el) => el.name)).toEqual([`<div> "A"`, `<div> "B"`]);
    expect(menu.editable).toBe(false);
    expect(menu.locked).toBe(false);
  });

  it("says whether the one selected element holds text to edit, and edits it when asked", () => {
    const e = editor();
    e.rightClick(e.$("#pic"));
    expect(e.menu().editable).toBe(false);
    e.rightClick(e.$("#a"));
    expect(e.menu().editable).toBe(true);
    e.fromParent({ type: "slop:edit-edit-text" });
    expect(e.$("#a").hasAttribute("contenteditable")).toBe(true);
  });
});

describe("the SVG editor's button", () => {
  it("stays away from a line drawn with the line tools", () => {
    const e = editor();
    e.pick("#line");
    expect((e.$("[data-slop-svg-open]") as HTMLButtonElement).hidden).toBe(true);
  });
});

describe("previewing a restyle", () => {
  it("shows it without saving, and saves once when it is applied", () => {
    const e = editor();
    e.pick("#a");
    e.fromParent({ type: "slop:edit-style", style: { opacity: 0.8 }, preview: true });
    e.fromParent({ type: "slop:edit-style", style: { opacity: 0.6 }, preview: true });
    expect(e.$("#a").style.opacity).toBe("0.6");
    expect(e.commits()).toEqual([]);
    e.fromParent({ type: "slop:edit-style", style: { opacity: 0.5 } });
    expect(e.$("#a").style.opacity).toBe("0.5");
    expect(e.commits()).toHaveLength(1);
    expect(e.commits()[0]!.markup).toContain("opacity: 0.5");
  });

  it("puts everything back when it is cancelled", () => {
    const e = editor();
    e.pick("#a", "#b");
    const before = [e.$("#a").getAttribute("style"), e.$("#b").getAttribute("style")];
    e.fromParent({ type: "slop:edit-style", style: { radius: 30, shadow: 20 }, preview: true });
    expect(e.$("#b").style.borderRadius).toBe("30px");
    e.fromParent({ type: "slop:edit-style-cancel" });
    expect([e.$("#a").getAttribute("style"), e.$("#b").getAttribute("style")]).toEqual(before);
    expect(e.selected()).toEqual([e.$("#a"), e.$("#b")]);
    // Nothing was held back: the next change saves as usual.
    e.fromParent({ type: "slop:edit-style", style: { bold: true } });
    expect(e.commits()).toHaveLength(1);
    expect(e.commits()[0]!.markup).not.toContain("border-radius");
  });

  it("reports the selection once per frame while it previews, however many elements are selected", async () => {
    const e = editor();
    e.pick("#a", "#b", "#pic");
    const reports = () => e.messages<{ selection: { opacity: number } }>("slop:edit-selection");
    const before = reports().length;
    for (const opacity of [0.8, 0.7, 0.6]) {
      e.fromParent({ type: "slop:edit-style", style: { opacity }, preview: true });
    }
    // It shows on every element with every tick; the toolbar hears of it with the frame.
    expect(e.$("#pic").style.opacity).toBe("0.6");
    expect(reports()).toHaveLength(before);
    await e.frame();
    expect(reports()).toHaveLength(before + 1);
    expect(reports().at(-1)!.selection.opacity).toBe(0.6);
    // Applied for good, it is reported at once, and once for all three.
    e.fromParent({ type: "slop:edit-style", style: { opacity: 0.5 }, preview: true });
    e.fromParent({ type: "slop:edit-style", style: { opacity: 0.4 } });
    expect(reports()).toHaveLength(before + 2);
    expect(reports().at(-1)!.selection.opacity).toBe(0.4);
    await e.frame();
    expect(reports()).toHaveLength(before + 2);
    expect(e.commits()).toHaveLength(1);
  });

  it("keeps a preview the app never finished, saving it with the next thing done on the slide", () => {
    const e = editor();
    e.pick("#a");
    e.fromParent({ type: "slop:edit-style", style: { opacity: 0.4 }, preview: true });
    e.key("b", { metaKey: true });
    expect(e.commits()).toHaveLength(1);
    expect(e.commits()[0]!.markup).toContain("opacity: 0.4");
  });
});

describe("snapping", () => {
  const SNAP = `<!DOCTYPE html><html><head></head><body><main class="deck"><section class="slide" id="intro">
    ${box("a", 100, 100)}${box("b", 600, 100)}</section></main></body></html>`;
  /** jsdom has no layout: every box is where its inline styles say, at full size. */
  function laidOut() {
    const e = editor(SNAP);
    const rectOf = (el: HTMLElement) => {
      const moved = (el.style.translate || "0px 0px").match(/-?[\d.]+/g)!.map(Number);
      const slide = el.id === "intro";
      const left = slide ? 0 : Number.parseFloat(el.style.left) + moved[0]!;
      const top = slide ? 0 : Number.parseFloat(el.style.top) + (moved[1] ?? 0);
      const width = slide ? 1920 : 200;
      const height = slide ? 1080 : 100;
      const rect = { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
      return { ...rect, toJSON: () => rect } as DOMRect;
    };
    for (const id of ["intro", "a", "b"]) {
      const el = e.$(`#${id}`);
      el.getBoundingClientRect = () => rectOf(el);
    }
    return e;
  }
  const dragA = (e: ReturnType<typeof laidOut>, init: PointerEventInit = {}) => {
    const a = e.$("#a");
    e.down(a, 150, 150);
    e.move(a, 150 + 297, 150, init);
    e.up(a, 150 + 297, 150);
    return a.style.translate;
  };

  it("snaps a drag to the other element's edge, unless ⌘ is held", () => {
    // 297px to the right leaves a's right edge 3px short of b's left edge.
    expect(dragA(laidOut())).toBe("300px 0px");
    expect(dragA(laidOut(), { metaKey: true })).toBe("297px 0px");
  });

  it("moves freely with snapping off, where ⌘ snaps instead", () => {
    const off = laidOut();
    off.fromParent({ type: "slop:edit-snap", on: false });
    expect(dragA(off)).toBe("297px 0px");
    const held = laidOut();
    held.fromParent({ type: "slop:edit-snap", on: false });
    expect(dragA(held, { metaKey: true })).toBe("300px 0px");
    const on = laidOut();
    on.fromParent({ type: "slop:edit-snap", on: false });
    on.fromParent({ type: "slop:edit-snap", on: true });
    expect(dragA(on)).toBe("300px 0px");
  });
});

describe("colors the wells cannot show as one", () => {
  const selection = (e: ReturnType<typeof editor>) =>
    e.messages<{ selection: Record<string, unknown> }>("slop:edit-selection").at(-1)!.selection;

  it("tells a gradient from no fill", () => {
    const e = editor(
      DECK.replace("font-size: 48px;", "font-size: 48px; background-image: linear-gradient(red, blue);"),
    );
    e.pick("#a");
    expect(selection(e)).toMatchObject({ fill: null, fillOther: true, strokeOther: false });
    e.pick("#b");
    expect(selection(e)).toMatchObject({ fill: null, fillOther: false });
  });

  it("reports a color several selected elements do not share as mixed", () => {
    const e = editor(DECK.replace("left: 400px;", "left: 400px; background-color: rgb(255, 0, 0);"));
    e.pick("#b");
    expect(selection(e)).toMatchObject({ fill: "#ff0000", fillOther: false });
    e.click(e.$("#a"), { shiftKey: true });
    expect(selection(e)).toMatchObject({ fill: null, fillOther: true, colorOther: false });
    // The same color on both is that color.
    e.fromParent({ type: "slop:edit-style", style: { fill: "#00ff00" } });
    expect(selection(e)).toMatchObject({ fill: "#00ff00", fillOther: false });
  });
});
