import { beforeEach, describe, expect, it } from "vitest";

import { useApp } from "./store";
import { lastError } from "./store/errors";
import { isDirty, parseSvgOpen, type SvgOpen, useSvgEditor } from "./svgStore";
import { DECK_HTML, deckFor } from "./test/fixtures";
import { ask, calls, invoke } from "./test/tauri";

const DECK = "/decks/talk/deck.html";
const ORIGINAL = '<svg viewBox="0 0 10 10"><circle r="1"></circle></svg>';
const DRAFT = '<svg viewBox="0 0 10 10"><circle r="3"></circle></svg>';
const SLIDE = `<section class="slide" id="intro">\n  <h1>Hello</h1>\n  ${ORIGINAL}\n</section>`;

const drawing = (changes: Partial<SvgOpen> = {}): SvgOpen => ({
  deckId: DECK,
  slide: "intro",
  path: [1],
  markup: ORIGINAL,
  size: { w: 200, h: 200 },
  color: "rgb(0, 0, 0)",
  vars: {},
  css: "",
  fonts: "",
  ancestors: [],
  ...changes,
});

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  ask.mockReset();
  useSvgEditor.setState({ edit: null });
  useApp.setState({
    deck: deckFor(DECK_HTML),
    selected: "intro",
    toasts: [],
    sidebarOpen: false,
    sidebarTabs: ["chat"],
    sidebarTab: "chat",
    sidebarMaximized: false,
  });
});

describe("parseSvgOpen", () => {
  it("reads what the slide editor hands over", () => {
    expect(
      parseSvgOpen(
        {
          slide: "intro",
          path: [1, 0],
          markup: ORIGINAL,
          width: 40,
          height: 20,
          color: "red",
          vars: { "--a": "1", b: "2", "--c": 3 },
          css: ".hub circle { fill: navy; }",
          fonts: "@font-face { font-family: Brand; }",
          ancestors: [{ tag: "section", attrs: { class: "slide hub", id: "intro" } }],
        },
        DECK,
      ),
    ).toEqual({
      deckId: DECK,
      slide: "intro",
      path: [1, 0],
      markup: ORIGINAL,
      size: { w: 40, h: 20 },
      color: "red",
      vars: { "--a": "1" },
      css: ".hub circle { fill: navy; }",
      fonts: "@font-face { font-family: Brand; }",
      ancestors: [{ tag: "section", attrs: { class: "slide hub", id: "intro" } }],
    });
  });

  it("keeps only well-formed, inert elements around the drawing, and no styles that are not text", () => {
    const open = parseSvgOpen(
      {
        slide: "intro",
        markup: ORIGINAL,
        css: 3,
        fonts: null,
        ancestors: [
          { tag: "BODY", attrs: { class: "dark", onclick: "x()", "data-n": 2 } },
          { tag: "a", attrs: { href: "javascript:x()", "xlink:href": "#y", class: "link" } },
          { tag: "bad tag", attrs: {} },
          "nope",
          null,
          { tag: "div", attrs: { "bad name": "1", "data-ok": "1" } },
        ],
      },
      DECK,
    );
    expect(open).toMatchObject({
      css: "",
      fonts: "",
      ancestors: [
        { tag: "body", attrs: { class: "dark" } },
        { tag: "a", attrs: { class: "link" } },
        { tag: "div", attrs: { "data-ok": "1" } },
      ],
    });
    expect(parseSvgOpen({ slide: "intro", markup: ORIGINAL }, DECK)).toMatchObject({
      css: "",
      fonts: "",
      ancestors: [],
    });
  });

  it("makes do with a bad path or size, and refuses without a deck, slide or markup", () => {
    expect(parseSvgOpen({ slide: "intro", path: [-1], markup: ORIGINAL, width: 0 }, DECK)).toMatchObject({
      path: null,
      size: { w: 100, h: 100 },
      color: null,
      vars: {},
    });
    expect(parseSvgOpen({ slide: "intro", markup: ORIGINAL }, undefined)).toBeNull();
    expect(parseSvgOpen({ markup: ORIGINAL }, DECK)).toBeNull();
    expect(parseSvgOpen({ slide: "intro" }, DECK)).toBeNull();
  });
});

describe("the SVG editor's drawing", () => {
  it("opens in the sidebar's SVG tab", async () => {
    expect(await useSvgEditor.getState().open(drawing())).toBe(true);
    expect(useSvgEditor.getState().edit).toMatchObject({
      original: ORIGINAL,
      draft: ORIGINAL,
      slide: "intro",
      path: [1],
    });
    expect(useApp.getState()).toMatchObject({ sidebarOpen: true, sidebarTab: "svg", sidebarTabs: ["chat", "svg"] });
  });

  it("refuses markup that is not a drawing", async () => {
    expect(await useSvgEditor.getState().open(drawing({ markup: "<div></div>" }))).toBe(false);
    expect(useSvgEditor.getState().edit).toBeNull();
    expect(lastError(useApp.getState())).toMatch(/not an SVG/);
  });

  it("undoes and redoes its changes, a drag being one step", () => {
    void useSvgEditor.getState().open(drawing());
    const { change, undo, redo } = useSvgEditor.getState();
    change("<svg><g></g></svg>");
    change("<svg><g>1</g></svg>");
    change("<svg><g>2</g></svg>", false);
    expect(useSvgEditor.getState().edit!.past).toEqual([ORIGINAL, "<svg><g></g></svg>"]);
    undo();
    expect(useSvgEditor.getState().edit!.draft).toBe("<svg><g></g></svg>");
    redo();
    expect(useSvgEditor.getState().edit!.draft).toBe("<svg><g>2</g></svg>");
    undo();
    undo();
    undo();
    expect(useSvgEditor.getState().edit!.draft).toBe(ORIGINAL);
    redo();
    change("<svg><rect></rect></svg>");
    expect(useSvgEditor.getState().edit!.future).toEqual([]);
  });

  it("discards back to the drawing on the slide, which undo takes back", () => {
    void useSvgEditor.getState().open(drawing());
    useSvgEditor.getState().change(DRAFT);
    expect(isDirty(useSvgEditor.getState().edit)).toBe(true);
    useSvgEditor.getState().discard();
    expect(useSvgEditor.getState().edit!.draft).toBe(ORIGINAL);
    expect(isDirty(useSvgEditor.getState().edit)).toBe(false);
    useSvgEditor.getState().undo();
    expect(useSvgEditor.getState().edit!.draft).toBe(DRAFT);
  });

  it("asks before leaving changes for another drawing, and keeps them if told to", async () => {
    await useSvgEditor.getState().open(drawing());
    useSvgEditor.getState().change(DRAFT);
    ask.mockResolvedValue(false);
    const other = drawing({ path: [3], markup: "<svg><rect></rect></svg>" });
    expect(await useSvgEditor.getState().open(other)).toBe(false);
    expect(useSvgEditor.getState().edit!.draft).toBe(DRAFT);
    ask.mockResolvedValue(true);
    expect(await useSvgEditor.getState().open(other)).toBe(true);
    expect(useSvgEditor.getState().edit).toMatchObject({ path: [3], draft: "<svg><rect></rect></svg>" });
  });

  it("keeps the changes when the same drawing is opened again", async () => {
    await useSvgEditor.getState().open(drawing());
    useSvgEditor.getState().change(DRAFT);
    expect(await useSvgEditor.getState().open(drawing())).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(useSvgEditor.getState().edit!.draft).toBe(DRAFT);
  });

  it("accepts into the slide, read from the file and saved against its hash, and edits on", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "slide_source") return { markup: SLIDE, hash: "h1" };
      if (command === "update_slide") return deckFor(DECK_HTML, "2");
    });
    await useSvgEditor.getState().open(drawing());
    useSvgEditor.getState().change(DRAFT);
    expect(await useSvgEditor.getState().accept()).toBe(true);
    expect(calls("update_slide")).toEqual([
      { id: DECK, slide: "intro", markup: SLIDE.replace(ORIGINAL, DRAFT), base: "h1" },
    ]);
    expect(useSvgEditor.getState().edit).toMatchObject({ original: DRAFT, draft: DRAFT, saving: false });
    expect(useApp.getState().deck!.slides[0]!.hash).toBe("intro-2");
  });

  it("keeps the changes when the drawing on the slide is not as it was", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "slide_source")
        return { markup: SLIDE.replace(ORIGINAL, "<svg><rect></rect></svg>"), hash: "h1" };
    });
    await useSvgEditor.getState().open(drawing());
    useSvgEditor.getState().change(DRAFT);
    expect(await useSvgEditor.getState().accept()).toBe(false);
    expect(calls("update_slide")).toEqual([]);
    expect(lastError(useApp.getState())).toMatch(/has changed/);
    expect(useSvgEditor.getState().edit).toMatchObject({ original: ORIGINAL, draft: DRAFT, saving: false });
  });

  it("accepts only into the open deck, and only changes", async () => {
    await useSvgEditor.getState().open(drawing());
    expect(await useSvgEditor.getState().accept()).toBe(false);
    useSvgEditor.getState().change(DRAFT);
    useApp.setState({ deck: { ...deckFor(DECK_HTML), id: "/decks/other/deck.html" } });
    expect(await useSvgEditor.getState().accept()).toBe(false);
    expect(lastError(useApp.getState())).toMatch(/Open the deck/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("closes its tab, asking first about changes not accepted", async () => {
    await useSvgEditor.getState().open(drawing());
    useApp.getState().setSidebarMaximized(true);
    useSvgEditor.getState().change(DRAFT);
    ask.mockResolvedValue(false);
    expect(await useSvgEditor.getState().close()).toBe(false);
    expect(useApp.getState().sidebarTabs).toContain("svg");
    ask.mockResolvedValue(true);
    expect(await useSvgEditor.getState().close()).toBe(true);
    expect(useSvgEditor.getState().edit).toBeNull();
    expect(useApp.getState()).toMatchObject({ sidebarTabs: ["chat"], sidebarMaximized: false });
  });

  it("closes without asking when nothing changed", async () => {
    await useSvgEditor.getState().open(drawing());
    expect(await useSvgEditor.getState().close()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});
