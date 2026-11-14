// @vitest-environment node
/**
 * The slide editor coming to the stage's page and going again with Edit mode, and the slide it
 * shows patched in place, all without the page loading again (src-tauri/assets/editor/75-life.js
 * and the pasteboard's `slop:edit-attach` / `slop:edit-detach`).
 */
import { describe, expect, it } from "vitest";
import { editorPage } from "./slideEditorPage";

const DECK = `<!DOCTYPE html><html><head><style>.slide { background: rgb(255, 255, 255) }</style></head><body>
<main class="deck">
  <section class="slide" id="intro">
    <h1 id="title" class="title">Hello</h1>
    <p class="body">Some words</p>
    <div class="shape" style="background: rgb(10, 20, 30); width: 100px; height: 50px"></div>
  </section>
  <section class="slide" id="outro"><p>Bye</p></section>
</main></body></html>`;

/** What the editor leaves on a page while it is there: its overlays, its styles, its marks. */
const editorTraces = (doc: Document) => ({
  overlays: doc.querySelectorAll(
    "[data-slop-ui], [data-slop-outline], [data-slop-points], [data-slop-edge], [data-slop-svg-open], [data-slop-overflow], [data-slop-guides], [data-slop-marquee], [data-slop-readout], [data-slop-multi]",
  ).length,
  marks: doc.querySelectorAll(
    "[contenteditable], [spellcheck], [data-slop-selected], [data-slop-hover], [data-slop-editing], [data-slop-typing]",
  ).length,
  styles: [...doc.querySelectorAll("style")].filter((style) => style.textContent?.includes("[data-slop-ui]")).length,
  tool: doc.documentElement.hasAttribute("data-slop-tool"),
});
const NO_TRACES = { overlays: 0, marks: 0, styles: 0, tool: false };

describe("the slide editor's life on the page", () => {
  it("goes away on detach without a trace, and the page is the player's again", () => {
    const e = editorPage({ markup: DECK });
    const doc = e.doc;
    expect(editorTraces(doc).overlays).toBeGreaterThan(0);
    e.click(e.$("h1"));
    e.fromParent({ type: "slop:edit-tool", tool: "rect" });
    expect(editorTraces(doc).tool).toBe(true);
    expect(editorTraces(doc).marks).toBeGreaterThan(0);

    e.fromParent({ type: "slop:edit-detach", still: false });
    expect(editorTraces(doc)).toEqual(NO_TRACES);
    expect((e.window as unknown as { slopEditor: unknown }).slopEditor).toBeNull();
    // The slide plays as View has it.
    expect(doc.documentElement.hasAttribute("data-slop-static")).toBe(false);
    // Nothing the editor did answers any more: a press and keys select nothing, say nothing.
    const said = e.posted().length;
    e.click(e.$("h1"));
    e.key("Delete");
    e.fromParent({ type: "slop:edit-select-all" });
    expect(e.selected()).toEqual([]);
    expect(
      e
        .posted()
        .slice(said)
        .filter((m) => m.type.startsWith("slop:edit-") || m.type === "slop:key"),
    ).toEqual([
      // Delete pressed with no editor is the player's, which forwards it.
      { type: "slop:key", key: "Delete", mod: false, shift: false },
    ]);
    // A double-click asks for the editor, as on a page loaded in View.
    e.$("h1").dispatchEvent(new e.window.MouseEvent("dblclick", { bubbles: true, button: 0 }));
    expect(e.posted().at(-1)).toEqual({ type: "slop:edit-ask", slide: "intro" });
  });

  it("drops what was not saved when it goes, as a page loaded again would: the typing, a drag", () => {
    for (const unsaved of ["typing", "drag"]) {
      const e = editorPage({ markup: DECK });
      const before = e.$("#intro").outerHTML;
      if (unsaved === "typing") {
        e.click(e.$("h1"));
        e.key("Enter");
        expect(e.$("h1").getAttribute("contenteditable")).toBe("true");
        e.$("h1").textContent = "Typed";
        e.$("h1").dispatchEvent(new e.window.InputEvent("input", { bubbles: true }));
      } else {
        const shape = e.$(".shape");
        e.down(shape);
        e.move(shape, 160, 140);
        expect(shape.style.translate).not.toBe("");
      }
      e.fromParent({ type: "slop:edit-detach", still: true });
      expect(e.$("#intro").outerHTML, unsaved).toBe(before);
      expect(e.commits(), unsaved).toEqual([]);
      expect(editorTraces(e.doc), unsaved).toEqual(NO_TRACES);
      expect(e.doc.documentElement.hasAttribute("data-slop-static")).toBe(true);
    }
  });

  it("comes to a page loaded without it, as often as it is asked for, and goes again each time", async () => {
    const e = editorPage({ markup: DECK, edit: false });
    const doc = e.doc;
    expect(editorTraces(doc)).toEqual(NO_TRACES);
    expect(doc.documentElement.hasAttribute("data-slop-static")).toBe(false);
    // Without the editor, a drag pans; nothing is selected.
    e.click(e.$("h1"));
    expect(e.selected()).toEqual([]);
    await e.frame();
    for (let round = 0; round < 3; round++) {
      e.fromParent({ type: "slop:edit-attach" });
      // The slide on its final animation frame, as the editor shows it.
      expect(doc.documentElement.hasAttribute("data-slop-static")).toBe(true);
      // Its overlays once, however many times it came.
      expect(doc.querySelectorAll("[data-slop-ui]")).toHaveLength(1);
      // Set up by the app once it says it is there.
      expect(e.posted().at(-1)).toEqual({ type: "slop:edit-attached", slide: "intro" });
      e.click(e.$("h1"));
      expect(e.selected()).toEqual([e.$("h1")]);
      // Asked for again while there: nothing more.
      e.fromParent({ type: "slop:edit-attach" });
      expect(doc.querySelectorAll("[data-slop-ui]")).toHaveLength(1);
      e.fromParent({ type: "slop:edit-detach", still: false });
      expect(editorTraces(doc)).toEqual(NO_TRACES);
      expect(doc.documentElement.hasAttribute("data-slop-static")).toBe(false);
    }
    // The pasteboard's own view keeps working throughout.
    expect((e.window as unknown as { slopPasteboard: { view: () => object } }).slopPasteboard.view()).toEqual({
      x: 0,
      y: 0,
      k: 1,
    });
  });

  it("saves what is changed after it came, against the slide as it was", async () => {
    const e = editorPage({ markup: DECK, edit: false });
    await e.frame();
    e.fromParent({ type: "slop:edit-attach" });
    e.drag(e.$(".shape"), 30, 20);
    const [commit] = e.commits();
    expect(commit!.slide).toBe("intro");
    expect(commit!.markup).toContain("translate: 30px 20px");
    expect(commit!.markup).not.toMatch(/data-slop|contenteditable|class="slide active"/);
  });
});

describe("the slide patched in place", () => {
  const MOVED = `<section class="slide" id="intro">
    <h1 id="title" class="title" style="translate: 10px 0px;">Hello again</h1>
    <p class="body">Other words</p>
    <div class="shape" style="background: rgb(10, 20, 30); width: 100px; height: 50px"></div>
  </section>`;
  const patch = (e: ReturnType<typeof editorPage>, markup: string, hash = "h2") =>
    e.fromParent({ type: "slop:edit-patch", slide: "intro", hash, markup });

  it("takes the new markup into the slide that shows, selecting again what is still there", () => {
    const e = editorPage({ markup: DECK });
    const slide = e.$("#intro");
    e.down(e.$("h1"));
    e.up(e.$("h1"));
    const said = e.posted().length;
    patch(e, MOVED);
    // The same element, the player's still: shown, and nothing loaded.
    expect(e.$("#intro")).toBe(slide);
    expect(slide.classList.contains("active")).toBe(true);
    expect(e.$("h1").textContent).toBe("Hello again");
    expect(e.$("h1").style.translate).toBe("10px 0px");
    // The heading is selected again by its id: a new element, the same one to the user.
    expect(e.selected()).toEqual([e.$("h1")]);
    const after = e.posted().slice(said);
    expect(after).toContainEqual({ type: "slop:edit-patched", slide: "intro", hash: "h2", ok: true });
    expect(after.map((m) => m.type)).toContain("slop:edit-selection");
    expect(after.map((m) => m.type)).toContain("slop:edit-background");
    // Nothing to save: the deck has it already.
    expect(e.commits()).toEqual([]);
  });

  it("saves what is done next against the patched slide", () => {
    const e = editorPage({ markup: DECK });
    patch(e, MOVED);
    e.drag(e.$(".shape"), 30, 20);
    const [commit] = e.commits();
    expect(commit!.markup).toContain("Hello again");
    expect(commit!.markup).toContain("translate: 30px 20px");
  });

  it("selects nothing for an element without an id that is gone, or another kind in its place", () => {
    const e = editorPage({ markup: DECK });
    e.down(e.$(".shape"));
    e.up(e.$(".shape"));
    expect(e.selected()).toEqual([e.$(".shape")]);
    patch(e, `<section class="slide" id="intro"><h1 id="title">Hello</h1><p>A</p><span>B</span></section>`);
    expect(e.selected()).toEqual([]);
  });

  it("drops what was under way, unsaved: the typing, the nudges", async () => {
    const e = editorPage({ markup: DECK });
    e.down(e.$(".shape"));
    e.up(e.$(".shape"));
    e.key("ArrowRight");
    patch(e, MOVED);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(e.commits()).toEqual([]);
    expect(e.$(".shape").style.translate).toBe("");
  });

  it("refuses what only a page load shows right, changing nothing", () => {
    const e = editorPage({ markup: DECK });
    const before = e.$("#intro").innerHTML;
    for (const markup of [
      `<section class="slide" id="intro"><h1>Hi</h1><script>run()</script></section>`,
      `<section class="slide" id="outro"><h1>Hi</h1></section>`,
      `<section class="slide" id="intro"></section><section class="slide" id="more"></section>`,
      `<div id="intro"></div>`,
    ]) {
      patch(e, markup, markup);
      expect(e.posted().at(-1)).toEqual({ type: "slop:edit-patched", slide: "intro", hash: markup, ok: false });
      expect(e.$("#intro").innerHTML).toBe(before);
    }
  });
});
