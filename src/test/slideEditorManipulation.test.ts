// @vitest-environment node
/**
 * The slide editor (src-tauri/assets/editor/), second pass on direct manipulation: what a
 * double-click, typing and the keys do to the selection, undo while typing, and adding elements
 * with a tool (their size, their snapping, their ink).
 */
import { describe, expect, it } from "vitest";
import { editorPage } from "./slideEditorPage";

const DECK = `<!DOCTYPE html><html><head></head><body>
<main class="deck">
  <section class="slide" id="intro">
    <div class="card" style="padding: 40px; background: rgb(240, 240, 240)"><h2>Title</h2><p>Body <b>text</b></p></div>
    <div id="row" style="display: flex">Label<div class="badge">New</div></div>
    <img id="pic" src="assets/a.png" alt="" style="width: 200px; height: 100px">
    <div id="box" data-added="text" style="position: absolute; left: 100px; top: 100px; width: 300px; display: flex; flex-direction: column"><div data-text-body="">Hello</div></div>
    <div data-group="" style="position: absolute; left: 600px; top: 600px; width: 400px; height: 200px; margin: 0px">
      <div id="g1" data-added="shape" style="position: absolute; left: 0px; top: 0px; width: 100px; height: 100px; background: red"><div data-text-body="">In</div></div>
      <div id="g2" data-added="shape" style="position: absolute; left: 200px; top: 0px; width: 100px; height: 100px; background: blue"></div>
    </div>
  </section>
</main></body></html>`;

const editor = (markup = DECK) => editorPage({ markup, slide: "intro" });
type Page = ReturnType<typeof editor>;

/** A click on the empty slide, so the next press is no double-click. */
const away = (e: Page) => {
  e.down(e.$("#intro"), 1800, 1000);
  e.up(e.$("#intro"), 1800, 1000);
};
const click = (e: Page, el: Element) => {
  e.down(el);
  e.up(el);
};
const doubleClick = (e: Page, el: Element) => {
  click(e, el);
  click(e, el);
};
const mod = { metaKey: true, ctrlKey: true };
const editing = (e: Page) => e.doc.querySelector("[data-slop-editing]");
/** Types `text` at the caret as the webview does: its beforeinput, the change, its input. */
const type = (e: Page, text: string) => {
  const el = editing(e)!;
  el.dispatchEvent(
    new e.window.InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true }),
  );
  const range = e.window.getSelection()!.getRangeAt(0);
  range.deleteContents();
  const node = e.doc.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  e.window.getSelection()!.removeAllRanges();
  e.window.getSelection()!.addRange(range);
  el.dispatchEvent(new e.window.InputEvent("input", { inputType: "insertText", data: text, bubbles: true }));
};
/** Puts the caret at the end of what is being typed in. */
const caretAtEnd = (e: Page) => {
  const range = e.doc.createRange();
  range.selectNodeContents(editing(e)!.querySelector("[data-text-body]") ?? editing(e)!);
  range.collapse(false);
  e.window.getSelection()!.removeAllRanges();
  e.window.getSelection()!.addRange(range);
};
const selectAllText = (e: Page) => {
  const range = e.doc.createRange();
  range.selectNodeContents(editing(e)!);
  e.window.getSelection()!.removeAllRanges();
  e.window.getSelection()!.addRange(range);
};

describe("double-click", () => {
  it("types in the text under the pointer, never in a card around several as one", () => {
    const e = editor();
    const card = e.$(".card");
    // On the card's own padding: nothing to type in.
    doubleClick(e, card);
    expect(editing(e)).toBeNull();
    card.dispatchEvent(new e.window.MouseEvent("dblclick", { bubbles: true }));
    expect(editing(e)).toBeNull();
    // Enter and the menu's "Edit text" cannot either.
    e.key("Enter");
    expect(editing(e)).toBeNull();
    e.fromParent({ type: "slop:edit-edit-text" });
    expect(editing(e)).toBeNull();
    // Where the pointer is over one of its texts, that one, whole: the paragraph, not its bold word.
    away(e);
    Object.assign(e.doc, { elementsFromPoint: () => [e.$(".card b"), e.$(".card p"), card, e.$("#intro")] });
    doubleClick(e, card);
    expect(editing(e)).toBe(e.$(".card p"));
  });

  it("types in an element with text of its own beside an element it holds", () => {
    const e = editor();
    e.down(e.$("#row"));
    e.key("Enter");
    expect(editing(e)).toBe(e.$("#row"));
  });

  it("asks the app to replace an image, as its menu's Replace image… does", () => {
    const e = editor();
    doubleClick(e, e.$("#pic"));
    expect(editing(e)).toBeNull();
    expect(e.messages("slop:edit-request")).toEqual([
      { type: "slop:edit-request", slide: "intro", what: "replace-image" },
    ]);
    // The browser's own dblclick that follows asks nothing more.
    e.$("#pic").dispatchEvent(new e.window.MouseEvent("dblclick", { bubbles: true }));
    expect(e.messages("slop:edit-request")).toHaveLength(1);
  });

  it("goes into a group and selects what it holds, without typing in it yet, and marks the group", () => {
    const e = editor();
    const group = e.$("[data-group]");
    const outline = e.$("[data-slop-outline=group]");
    click(e, e.$("#g1"));
    expect(e.selected()).toEqual([group]);
    expect(outline.style.display).toBe("");
    click(e, e.$("#g1"));
    expect(e.selected()).toEqual([e.$("#g1")]);
    // The browser's dblclick after the second press selects; it does not start typing.
    e.$("#g1").dispatchEvent(new e.window.MouseEvent("dblclick", { bubbles: true }));
    expect(editing(e)).toBeNull();
    expect(outline.style.display).toBe("block");
    // Out of the group, its mark goes.
    e.key("Escape");
    expect(e.selected()).toEqual([group]);
    e.key("Escape");
    expect(outline.style.display).toBe("");
  });
});

describe("typing with an element selected", () => {
  it("types into the selected text box at its end, and the letter is no tool's key", () => {
    const e = editor();
    click(e, e.$("#box"));
    const event = e.key("x");
    expect(event.defaultPrevented).toBe(true);
    expect(editing(e)).toBe(e.$("#box"));
    expect(e.$("#box").textContent).toBe("Hellox");
    expect(e.keys()).toEqual([]);
    e.key("Escape");
    expect(e.commits().at(-1)!.markup).toContain('<div data-text-body="">Hellox</div>');
  });

  it("leaves the keys to the tools with nothing, or nothing that holds text, selected", () => {
    const e = editor();
    e.key("t");
    click(e, e.$("#pic"));
    e.key("r");
    expect(e.keys().map((k) => k.key)).toEqual(["t", "r"]);
    expect(editing(e)).toBeNull();
    // Nor do Space, 0, ⇧2 or a key with a modifier start typing.
    click(e, e.$("#box"));
    e.key("@", { shiftKey: true, code: "Digit2" });
    e.key("a", { altKey: true });
    expect(editing(e)).toBeNull();
  });

  it("edits a selected element's text from the app as well as with Enter", () => {
    const e = editor();
    click(e, e.$("#box"));
    e.key("Enter");
    expect(editing(e)).toBe(e.$("#box"));
    // Enter selects all of it, to type over.
    expect(e.window.getSelection()!.toString()).toBe("Hello");
  });
});

describe("what typing costs", () => {
  it("posts the toolbar's report only when it says something new, however many keys are typed", async () => {
    const e = editor();
    click(e, e.$("#box"));
    e.key("Enter");
    caretAtEnd(e);
    await e.frame();
    const reports = () => e.messages("slop:edit-selection").length;
    const before = reports();
    for (let i = 0; i < 6; i++) {
      type(e, "x");
      // The webview tells of the caret moving as well, in a task of its own.
      e.doc.dispatchEvent(new e.window.Event("selectionchange"));
      await e.frame();
    }
    expect(e.$("#box").textContent).toBe("Helloxxxxxx");
    expect(reports()).toBe(before);
    // A change the toolbar shows is reported, once.
    selectAllText(e);
    e.fromParent({ type: "slop:edit-style", style: { bold: true } });
    await e.frame();
    expect(reports()).toBe(before + 1);
    expect(e.messages<{ selection: { bold: boolean } }>("slop:edit-selection").at(-1)!.selection.bold).toBe(true);
  });
});

describe("shown again", () => {
  it("starts over as a preview just loaded, and reports everything again, when the app shows it after loading it ahead", async () => {
    const e = editor();
    await e.frame();
    await e.frame();
    const count = (type: string) => e.messages(type).length;
    const kinds = [
      "slop:edit-layers",
      "slop:edit-overflow",
      "slop:edit-background",
      "slop:edit-fonts",
      "slop:edit-colors",
    ];
    const before = kinds.map(count);
    expect(before.every((n) => n > 0)).toBe(true);
    click(e, e.$("#box"));
    e.key("q");
    expect(editing(e)).toBe(e.$("#box"));
    e.fromParent({ type: "slop:edit-show" });
    // The typing is saved and done, and nothing is selected.
    expect(editing(e)).toBeNull();
    expect(e.selected()).toEqual([]);
    expect(e.commits().at(-1)!.markup).toContain("Helloq");
    expect(e.messages<{ selected: boolean }>("slop:edit-selection").at(-1)!.selected).toBe(false);
    const reports = count("slop:edit-selection");
    await e.frame();
    // What it said before, it says again, though nothing changed.
    expect(kinds.map(count)).toEqual(before.map((n) => n + 1));
    // Shown again with nothing selected, it still says so, once.
    e.fromParent({ type: "slop:edit-show" });
    expect(count("slop:edit-selection")).toBe(reports + 1);
  });
});

describe("undo while typing", () => {
  it("undoes and redoes the typing and the toolbar's formatting in the order they were made", () => {
    const e = editor();
    click(e, e.$("#box"));
    e.key("Enter");
    caretAtEnd(e);
    type(e, " world");
    expect(e.$("#box").textContent).toBe("Hello world");
    selectAllText(e);
    e.fromParent({ type: "slop:edit-style", style: { bold: true } });
    const bold = e.$("#box").innerHTML;
    expect(bold).toContain("font-weight: 700");
    // The formatting first, then the typing.
    expect(e.key("z", mod).defaultPrevented).toBe(true);
    expect(e.$("#box").innerHTML).toBe('<div data-text-body="">Hello world</div>');
    e.key("z", mod);
    expect(e.$("#box").textContent).toBe("Hello");
    e.key("z", { ...mod, shiftKey: true });
    expect(e.$("#box").textContent).toBe("Hello world");
    e.key("y", mod);
    expect(e.$("#box").innerHTML).toBe(bold);
    // Nothing of the app's undo yet, and still typing.
    expect(e.keys()).toEqual([]);
    expect(editing(e)).toBe(e.$("#box"));
    expect(e.commits()).toEqual([]);
  });

  it("finishes the text once there is nothing of it left to undo, and hands the key on to the app", () => {
    const e = editor();
    click(e, e.$("#box"));
    e.key("q");
    expect(e.$("#box").textContent).toBe("Helloq");
    e.key("z", mod);
    expect(e.$("#box").textContent).toBe("Hello");
    expect(e.keys()).toEqual([]);
    e.key("z", mod);
    expect(editing(e)).toBeNull();
    expect(e.keys()).toEqual([expect.objectContaining({ type: "slop:key", key: "z", mod: true })]);
    // The text came back to what it was: nothing to save.
    expect(e.commits()).toEqual([]);
  });

  it("takes ⌘Z pressed in the app while typing, and asks the app to undo once the typing has none left", () => {
    const e = editor();
    click(e, e.$("#box"));
    e.key("q");
    e.fromParent({ type: "slop:edit-undo", redo: false });
    expect(e.$("#box").textContent).toBe("Hello");
    e.fromParent({ type: "slop:edit-undo", redo: true });
    expect(e.$("#box").textContent).toBe("Helloq");
    e.fromParent({ type: "slop:edit-undo", redo: false });
    e.fromParent({ type: "slop:edit-undo", redo: false });
    expect(editing(e)).toBeNull();
    expect(e.posted().filter((m) => m.type === "slop:key")).toEqual([
      { type: "slop:key", key: "z", mod: true, shift: false },
    ]);
  });

  it("starts each text's steps afresh", () => {
    const e = editor();
    click(e, e.$("#box"));
    e.key("q");
    e.key("Escape");
    click(e, e.$("#intro"));
    away(e);
    click(e, e.$("#box"));
    e.key("Enter");
    // The step of the earlier typing is gone with it: undo is the app's at once.
    e.key("z", mod);
    expect(editing(e)).toBeNull();
    expect(e.$("#box").textContent).toBe("Helloq");
  });
});

describe("keys from the app", () => {
  it("nudges, selects and deletes the selection as the same keys in the slide do", () => {
    const e = editor();
    click(e, e.$("#box"));
    e.fromParent({ type: "slop:edit-key", key: "ArrowRight", shift: true });
    e.fromParent({ type: "slop:edit-key", key: "ArrowDown", shift: false });
    expect(e.$("#box").style.translate).toBe("10px 1px");
    e.fromParent({ type: "slop:edit-key", key: "Delete", shift: false });
    expect(e.doc.querySelector("#box")).toBeNull();
    expect(e.selected()).toEqual([]);
    // With nothing selected, nothing happens.
    e.fromParent({ type: "slop:edit-key", key: "Delete", shift: false });
    expect(e.commits()).toHaveLength(1);
  });

  it("pastes as plain text with ⇧⌘V on the slide, flipping nothing: the app pastes", () => {
    const e = editor();
    click(e, e.$("#pic"));
    const event = e.key("v", { ...mod, shiftKey: true, code: "KeyV" });
    // No native paste; the key goes on to the app.
    expect(event.defaultPrevented).toBe(true);
    expect(e.$("#pic").style.transform).toBe("");
    expect(e.keys()).toEqual([expect.objectContaining({ key: "v", mod: true, shift: true })]);
  });

  it("zooms to the selection with ⇧2", () => {
    const e = editor();
    const box = e.$("#box");
    box.getBoundingClientRect = () => new e.window.DOMRect(100, 100, 300, 60);
    click(e, box);
    const event = e.key("@", { shiftKey: true, code: "Digit2" });
    expect(event.defaultPrevented).toBe(true);
    const view = e.messages<{ x: number; y: number; k: number }>("slop:view").at(-1)!;
    const k = Math.min((1920 - 96) / 300, (1080 - 96) / 60);
    expect(view.k).toBeCloseTo(k, 5);
    // The box's middle is the view's.
    expect(view.x + 250 * view.k).toBeCloseTo(960, 5);
    expect(view.y + 130 * view.k).toBeCloseTo(540, 5);
  });
});

describe("adding elements with a tool", () => {
  const TEXT_STYLE = {
    color: "#111111",
    fontSize: 48,
    align: "left",
    valign: "top",
    fill: null,
    stroke: null,
    strokeWidth: 0,
  };
  const SHAPE_STYLE = { color: "#ffffff", fontSize: 40, align: "center", valign: "middle", fill: "#3b82f6" };
  const at = (e: Page, type: string, x: number, y: number, init: PointerEventInit = {}) =>
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
  const added = (e: Page) => [...e.doc.querySelectorAll<HTMLElement>("#intro > [data-added]:not(#box)")];
  const readout = (e: Page) => e.$("[data-slop-readout]");

  it("shows the size by the pointer while a shape is dragged out, and snaps its corner to the guides", async () => {
    const e = editor();
    e.fromParent({ type: "slop:edit-tool", tool: "rect", style: SHAPE_STYLE });
    at(e, "pointerdown", 100, 100);
    // Near the slide's middle (960): the corner goes onto it, with a guide.
    at(e, "pointermove", 957, 300);
    await e.frame();
    expect(readout(e).textContent).toBe("X 100  Y 100  W 860  H 200");
    expect(readout(e).style.display).not.toBe("none");
    expect(e.$("[data-slop-guides]").children.length).toBeGreaterThan(0);
    // ⌘ / Ctrl draws freely.
    at(e, "pointermove", 957, 300, { metaKey: true, ctrlKey: true });
    await e.frame();
    expect(readout(e).textContent).toBe("X 100  Y 100  W 857  H 200");
    expect(e.$("[data-slop-guides]").children).toHaveLength(0);
    at(e, "pointerup", 957, 300);
    expect(added(e)[0]!.style.width).toBe("857px");
    // Done, the readout and the guides go.
    expect(readout(e).style.display).toBe("none");
  });

  it("draws a shape out from its center with Alt, and as wide as tall with Shift", () => {
    const e = editor();
    e.fromParent({ type: "slop:edit-tool", tool: "rect", style: SHAPE_STYLE });
    at(e, "pointerdown", 500, 500);
    at(e, "pointermove", 600, 550, { altKey: true });
    at(e, "pointerup", 600, 550);
    expect(added(e)[0]!.style).toMatchObject({ left: "400px", top: "450px", width: "200px", height: "100px" });
    e.fromParent({ type: "slop:edit-tool", tool: "ellipse", style: SHAPE_STYLE });
    at(e, "pointerdown", 500, 500);
    at(e, "pointermove", 600, 550, { altKey: true, shiftKey: true });
    at(e, "pointerup", 600, 550);
    expect(added(e)[1]!.style).toMatchObject({ left: "400px", top: "400px", width: "200px", height: "200px" });
  });

  it("shows a line's length and angle while it is drawn, and puts the readout away on Escape", async () => {
    const e = editor();
    e.fromParent({ type: "slop:edit-tool", tool: "line", style: { stroke: "#111111", strokeWidth: 4 } });
    at(e, "pointerdown", 100, 900);
    at(e, "pointermove", 400, 600);
    await e.frame();
    expect(readout(e).textContent).toBe("L 424  45°");
    e.key("Escape");
    expect(readout(e).style.display).toBe("none");
  });

  it("types into text that is there with the Text tool, the deck's own too, instead of adding a box on it", () => {
    const e = editor();
    e.fromParent({ type: "slop:edit-tool", tool: "text", style: TEXT_STYLE });
    const h2 = e.$("h2");
    h2.dispatchEvent(
      new e.window.PointerEvent("pointerdown", {
        clientX: 10,
        clientY: 10,
        button: 0,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(editing(e)).toBe(h2);
    expect(added(e)).toEqual([]);
    expect(e.messages<{ tool: string }>("slop:edit-tool").at(-1)!.tool).toBe("select");
  });

  it("starts a new text box empty, with a hint the deck never gets, and drops it when left so", () => {
    const e = editor();
    e.fromParent({ type: "slop:edit-tool", tool: "text", style: TEXT_STYLE });
    at(e, "pointerdown", 300, 300);
    at(e, "pointerup", 300, 300);
    const [box] = added(e);
    expect(box!.textContent).toBe("");
    expect(box!.hasAttribute("data-slop-empty")).toBe(true);
    type(e, "Hi");
    expect(box!.hasAttribute("data-slop-empty")).toBe(false);
    e.key("Escape");
    expect(e.commits().at(-1)!.markup).not.toContain("data-slop-empty");
    expect(e.commits().at(-1)!.markup).toContain(">Hi</div>");
  });

  it("gives new text and lines an ink that shows on a dark slide, and keeps a color picked on purpose", () => {
    const light = editor(
      DECK.replace(
        '<section class="slide" id="intro">',
        '<section class="slide" id="intro" style="background: rgb(250, 250, 250)">',
      ),
    );
    light.fromParent({ type: "slop:edit-tool", tool: "text", style: TEXT_STYLE });
    at(light, "pointerdown", 300, 300);
    at(light, "pointerup", 300, 300);
    expect(added(light)[0]!.style.color).toBe("rgb(17, 17, 17)");
    const dark = editor(
      DECK.replace(
        '<section class="slide" id="intro">',
        '<section class="slide" id="intro" style="background: rgb(10, 10, 20)">',
      ),
    );
    dark.fromParent({ type: "slop:edit-tool", tool: "text", style: TEXT_STYLE });
    at(dark, "pointerdown", 300, 300);
    at(dark, "pointerup", 300, 300);
    expect(added(dark)[0]!.style.color).toBe("rgb(255, 255, 255)");
    dark.key("Escape");
    dark.fromParent({ type: "slop:edit-tool", tool: "arrow", style: { stroke: "#111111", strokeWidth: 4 } });
    at(dark, "pointerdown", 100, 900);
    at(dark, "pointermove", 400, 900);
    at(dark, "pointerup", 400, 900);
    expect(dark.doc.querySelector("#intro > svg[data-added] path")!.getAttribute("stroke")).toBe("#ffffff");
    // Black picked on purpose stays black; so does a shape's border, on its own fill.
    dark.fromParent({ type: "slop:edit-tool", tool: "line", style: { stroke: "#000000", strokeWidth: 4 } });
    at(dark, "pointerdown", 100, 800);
    at(dark, "pointermove", 400, 800);
    at(dark, "pointerup", 400, 800);
    expect(
      dark.doc.querySelectorAll("#intro > svg[data-added]")[1]!.querySelector("path")!.getAttribute("stroke"),
    ).toBe("#000000");
  });
});
