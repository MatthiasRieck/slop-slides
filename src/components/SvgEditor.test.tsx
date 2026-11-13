import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useApp } from "../store";
import { type SvgOpen, useSvgEditor } from "../svgStore";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { SvgEditor } from "./SvgEditor";

const DECK = "/decks/talk/deck.html";
const DRAWING =
  '<svg viewBox="0 0 100 100" style="translate: 40px 0px"><script>alert(1)</script>' +
  '<rect id="box" x="10" y="10" width="20" height="20" fill="red"></rect>' +
  '<g class="group"><path d="M0 0 L50 0 L50 50"></path></g></svg>';

// jsdom has no SVG geometry: each element of the drawing is drawn at 2 screen pixels per unit.
const SCALE = 2;
class Matrix {
  constructor(
    public a = 1,
    public b = 0,
    public c = 0,
    public d = 1,
    public e = 0,
    public f = 0,
  ) {}
  static fromMatrix(m: Matrix) {
    return new Matrix(m.a, m.b, m.c, m.d, m.e, m.f);
  }
  inverse() {
    const det = this.a * this.d - this.b * this.c;
    return new Matrix(
      this.d / det,
      -this.b / det,
      -this.c / det,
      this.a / det,
      (this.c * this.f - this.d * this.e) / det,
      (this.b * this.e - this.a * this.f) / det,
    );
  }
}
class Point2 {
  constructor(
    public x = 0,
    public y = 0,
  ) {}
  matrixTransform(m: Matrix) {
    return new Point2(m.a * this.x + m.c * this.y + m.e, m.b * this.x + m.d * this.y + m.f);
  }
}
const proto = SVGElement.prototype as unknown as Record<string, unknown>;
const saved = { ctm: proto.getScreenCTM, bbox: proto.getBBox };

beforeEach(() => {
  Object.assign(globalThis, { DOMMatrix: Matrix, DOMPoint: Point2 });
  proto.getScreenCTM = () => new Matrix(SCALE, 0, 0, SCALE, 0, 0);
  proto.getBBox = () => ({ x: 0, y: 0, width: 10, height: 10 });
  invoke.mockReset().mockResolvedValue(undefined);
  useSvgEditor.setState({ edit: null });
  useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", toasts: [] });
});

afterEach(() => {
  proto.getScreenCTM = saved.ctm;
  proto.getBBox = saved.bbox;
});

async function open(changes: Partial<SvgOpen> = {}) {
  await act(() =>
    useSvgEditor.getState().open({
      deckId: DECK,
      slide: "intro",
      path: [1],
      markup: DRAWING,
      size: { w: 200, h: 200 },
      color: "rgb(1, 2, 3)",
      vars: { "--brand": "#00f" },
      css: "",
      fonts: "",
      ancestors: [],
      ...changes,
    }),
  );
  return render(<SvgEditor />);
}

/** The drawing as the canvas shows it, inside its shadow root. */
const shown = () => screen.getByTestId("svg-drawing").shadowRoot!;
const draft = () => useSvgEditor.getState().edit!.draft;
const press = (target: Element, x: number, y: number, type = "pointerDown") =>
  fireEvent[type as "pointerDown"](target, { button: 0, pointerId: 1, clientX: x, clientY: y, composed: true });

describe("SvgEditor", () => {
  it("says how to open a drawing while none is", () => {
    render(<SvgEditor />);
    expect(screen.getByRole("heading", { name: "No drawing open" })).toBeTruthy();
  });

  it("shows the drawing safely, at its size, in the deck's colors, wherever the slide put it", async () => {
    await open();
    const svg = shown().querySelector("svg")!;
    expect(svg.querySelector("script")).toBeNull();
    expect(svg.querySelector("#box")).not.toBeNull();
    expect(svg.style.getPropertyValue("translate")).toBe("none");
    expect(svg.style.getPropertyPriority("translate")).toBe("important");
    const frame = shown().querySelector<HTMLElement>(".frame")!;
    expect(frame.style.getPropertyValue("--brand")).toBe("#00f");
    expect(frame.style.color).toBe("rgb(1, 2, 3)");
    // The drawing as edited keeps its script: only the copy shown leaves it out.
    expect(draft()).toContain("<script>");
  });

  it("puts light drawings on a dark backdrop, which the user can change", async () => {
    await open({ markup: '<svg viewBox="0 0 10 10"><path d="M0 0 L5 5" stroke="#fff"></path></svg>' });
    const content = () => screen.getByTestId("svg-drawing").parentElement!;
    expect(content().dataset.backdrop).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: /^Light backdrop/ }));
    expect(content().dataset.backdrop).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: /^Dark backdrop/ }));
    expect(content().dataset.backdrop).toBe("dark");
    expect(screen.getByRole("button", { name: /from the drawing's colors/ })).toBeTruthy();
  });

  it("keeps dark drawings on a light backdrop", async () => {
    await open();
    expect(screen.getByTestId("svg-drawing").parentElement!.dataset.backdrop).toBe("light");
    expect(screen.getByRole("button", { name: /^Dark backdrop/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("styles the drawing with the deck's rules, inside the elements it sits in on the slide", async () => {
    await open({
      css: ".hub circle { fill: navy; }",
      fonts: '@font-face { font-family: Brand; src: url("https://fonts.example/brand.woff2"); }',
      ancestors: [
        { tag: "body", attrs: { class: "dark" } },
        { tag: "section", attrs: { class: "slide hub", id: "intro", style: "color: white" } },
        { tag: "script", attrs: { class: "odd" } },
      ],
    });
    const svg = shown().querySelector("svg")!;
    const deck = [...shown().querySelectorAll("style")].map((s) => s.textContent);
    expect(deck).toContain(".hub circle { fill: navy; }");
    // Mirrored, outermost first, drawing no boxes; anything active is only a <div>.
    const section = svg.closest<HTMLElement>("section.hub")!;
    expect(section.id).toBe("intro");
    expect(section.style.color).toBe("white");
    expect(section.style.getPropertyValue("display")).toBe("contents");
    expect(section.parentElement!.localName).toBe("body");
    expect(svg.parentElement!.localName).toBe("div");
    expect(svg.parentElement!.className).toBe("odd");
    expect(shown().querySelector("script")).toBeNull();
    // The deck's rules cannot move or resize it.
    expect(svg.style.getPropertyPriority("position")).toBe("important");
    expect(svg.style.getPropertyPriority("width")).toBe("important");
    // Web fonts load in the app's document while the drawing is open.
    const fonts = () => document.head.querySelector("style[data-slop-svg-fonts]");
    expect(fonts()!.textContent).toContain("font-family: Brand");
    await act(() => useSvgEditor.getState().close());
    expect(fonts()).toBeNull();
  });

  it("selects what is clicked and shows its look and attributes", async () => {
    await open();
    expect(screen.getByText(/Click an element of the drawing/)).toBeTruthy();
    press(shown().querySelector("#box")!, 25, 25);
    expect(screen.getByText("rect#box")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Fill" }) as HTMLInputElement).value).toBe("red");
    expect((screen.getByRole("textbox", { name: "Attribute width" }) as HTMLInputElement).value).toBe("20");
  });

  it("restyles the selected element", async () => {
    await open();
    press(shown().querySelector("#box")!, 25, 25);
    const fill = screen.getByRole("textbox", { name: "Fill" });
    fireEvent.focus(fill);
    fireEvent.change(fill, { target: { value: "#00ff00" } });
    fireEvent.keyDown(fill, { key: "Enter" });
    expect(draft()).toContain('fill="#00ff00"');
    fireEvent.change(screen.getByRole("textbox", { name: "Stroke width" }), { target: { value: "4" } });
    expect(draft()).toContain('stroke-width="4"');
    fireEvent.change(screen.getByRole("combobox", { name: "Line ends" }), { target: { value: "round" } });
    expect(draft()).toContain('stroke-linecap="round"');
    // Shown as changed right away.
    expect(shown().querySelector("#box")!.getAttribute("stroke-linecap")).toBe("round");
  });

  it("adds, changes and removes attributes, but no event handlers", async () => {
    await open();
    press(shown().querySelector("#box")!, 25, 25);
    fireEvent.change(screen.getByRole("textbox", { name: "New attribute name" }), { target: { value: "rx" } });
    fireEvent.change(screen.getByRole("textbox", { name: "New attribute value" }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Add the attribute" }));
    expect(draft()).toContain('rx="3"');
    fireEvent.click(screen.getByRole("button", { name: "Remove fill" }));
    expect(draft()).not.toContain('fill="red"');
    fireEvent.change(screen.getByRole("textbox", { name: "New attribute name" }), { target: { value: "onclick" } });
    fireEvent.click(screen.getByRole("button", { name: "Add the attribute" }));
    expect(draft()).not.toContain("onclick");
  });

  it("drags an element to move it, in its parent's units", async () => {
    await open();
    const box = shown().querySelector("#box")!;
    press(box, 20, 20);
    press(box, 60, 30, "pointerMove");
    press(box, 60, 30, "pointerUp");
    expect(draft()).toContain('transform="translate(20 5)"');
    // One drag, one undo step.
    act(() => useSvgEditor.getState().undo());
    expect(draft()).toBe(DRAWING);
  });

  it("drags a shape's points, adds points between them and takes them out", async () => {
    await open();
    press(shown().querySelector("path")!, 10, 0);
    const points = () => [...document.querySelectorAll("[data-handle]")].map((h) => h.getAttribute("data-handle"));
    expect(points()).toEqual(["to:0", "to:1", "add:1", "to:2", "add:2"]);
    const end = document.querySelector('[data-handle="to:2"]')!;
    press(end, 100, 100);
    press(end, 120, 100, "pointerMove");
    press(end, 120, 100, "pointerUp");
    expect(draft()).toContain('d="M0 0 L50 0 L60 50"');
    const add = document.querySelector('[data-handle="add:1"]')!;
    press(add, 50, 0);
    press(add, 50, 0, "pointerUp");
    expect(draft()).toContain('d="M0 0 L25 0 L50 0 L60 50"');
    fireEvent.doubleClick(document.querySelector('[data-handle="to:1"]')!);
    expect(draft()).toContain('d="M0 0 L50 0 L60 50"');
  });

  it("selects the parent with Escape, deletes with Delete and undoes with the keyboard", async () => {
    await open();
    press(shown().querySelector("path")!, 10, 0);
    const canvas = screen.getByTestId("svg-canvas");
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(screen.getByText("g.group")).toBeTruthy();
    fireEvent.keyDown(canvas, { key: "Delete" });
    expect(draft()).not.toContain("<g");
    fireEvent.keyDown(canvas, { key: "z", metaKey: true, ctrlKey: true });
    expect(draft()).toBe(DRAWING);
  });

  it("keeps its keys from the slide editor's shortcuts", async () => {
    await open();
    const seen: string[] = [];
    const listen = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", listen);
    const canvas = screen.getByTestId("svg-canvas");
    fireEvent.keyDown(canvas, { key: "t" });
    fireEvent.keyDown(canvas, { key: "Delete" });
    fireEvent.keyDown(canvas, { key: "n", metaKey: true, ctrlKey: true });
    window.removeEventListener("keydown", listen);
    expect(seen).toEqual(["n"]);
  });

  it("nudges with the arrow keys and duplicates", async () => {
    await open();
    press(shown().querySelector("#box")!, 25, 25);
    const canvas = screen.getByTestId("svg-canvas");
    fireEvent.keyDown(canvas, { key: "ArrowRight", shiftKey: true });
    expect(draft()).toContain('transform="translate(10 0)"');
    fireEvent.click(screen.getByRole("button", { name: /^Duplicate/ }));
    expect(draft().match(/<rect/g)).toHaveLength(2);
    // The copy has no id of its own, so it does not clash.
    expect(draft().match(/id="box"/g)).toHaveLength(1);
  });

  it("moves between the inspector's tabs with the arrow keys, without nudging the drawing", async () => {
    await open();
    const before = draft();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[0]);
    expect(draft()).toBe(before);
  });

  it("picks elements from the layers", async () => {
    await open();
    fireEvent.click(screen.getByRole("tab", { name: "layers" }));
    const layers = within(screen.getByRole("list", { name: "Layers" }));
    expect(layers.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "svg",
      "script",
      "rect#box",
      "g.group",
      "path",
    ]);
    fireEvent.click(layers.getByRole("button", { name: "g.group" }));
    fireEvent.click(screen.getByRole("tab", { name: "properties" }));
    expect(screen.getByText("g.group")).toBeTruthy();
  });

  it("edits the markup by hand, taking it only while it is one drawing", async () => {
    await open();
    fireEvent.click(screen.getByRole("tab", { name: "markup" }));
    const markup = screen.getByRole("textbox", { name: "Markup" });
    fireEvent.focus(markup);
    fireEvent.change(markup, { target: { value: "<svg><circle r='5'/>" } });
    expect(draft()).toBe('<svg><circle r="5"></circle></svg>');
    fireEvent.change(markup, { target: { value: "<div>" } });
    expect(screen.getByText(/the last valid markup is kept/)).toBeTruthy();
    expect(draft()).toBe('<svg><circle r="5"></circle></svg>');
  });

  it("accepts or discards only when there are changes", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "slide_source")
        return { markup: `<section class="slide" id="intro"><h1>Hi</h1>${DRAWING}</section>`, hash: "h" };
      if (command === "update_slide") return deckFor(DECK_HTML, "2");
    });
    await open();
    const accept = screen.getByRole("button", { name: /Accept/ }) as HTMLButtonElement;
    const discard = screen.getByRole("button", { name: /Discard/ }) as HTMLButtonElement;
    expect([accept.disabled, discard.disabled]).toEqual([true, true]);
    press(shown().querySelector("#box")!, 25, 25);
    fireEvent.keyDown(screen.getByTestId("svg-canvas"), { key: "ArrowDown" });
    expect([accept.disabled, discard.disabled]).toEqual([false, false]);
    fireEvent.click(discard);
    expect(draft()).toBe(DRAWING);
    fireEvent.keyDown(screen.getByTestId("svg-canvas"), { key: "ArrowDown" });
    await act(async () => fireEvent.click(accept));
    const update = invoke.mock.calls.find(([c]) => c === "update_slide")![1] as { markup: string };
    expect(update.markup).toContain('transform="translate(0 1)"');
    expect(accept.disabled).toBe(true);
  });

  it("does not accept into a deck other than the drawing's", async () => {
    await open({ deckId: "/decks/other/deck.html" });
    expect(screen.getByText(/in another deck/)).toBeTruthy();
  });
});
