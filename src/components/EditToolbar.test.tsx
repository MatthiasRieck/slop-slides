import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditGeometry, EditLayer } from "../lib/arrange";
import { type EditSelection, parseSelection } from "../lib/editTools";
import { SWATCHES } from "../lib/palette";
import { collapsedWidth } from "../lib/ribbon";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { EDIT_SECTIONS, EditToolbar } from "./EditToolbar";
import { reportDeckLook, reportFromEditor, resetEditorState, useEditorState } from "./stage/editorState";

const SECTION_WIDTH = 200;

let resize: ResizeObserverCallback | null = null;
let ribbonWidth = 0;
const NoLayout = globalThis.ResizeObserver;

/**
 * The toolbar, with what the slide editor last reported about the slide it is at work on: its
 * `selection`, where that is (`geometry`) and its `layers`, which the toolbar's controls read for
 * themselves.
 */
function toolbar({
  selection = null,
  geometry = null,
  layers = [],
  ...overrides
}: Partial<Parameters<typeof EditToolbar>[0]> & {
  selection?: EditSelection | null;
  geometry?: EditGeometry | null;
  layers?: EditLayer[];
} = {}) {
  act(() => {
    reportFromEditor("intro", "selection", selection);
    reportFromEditor("intro", "geometry", geometry);
    reportFromEditor("intro", "layers", layers);
  });
  return (
    <EditToolbar
      onSizeMode={() => {}}
      tool="select"
      styles={{ text: {}, shape: {}, draw: {} }}
      onTool={() => {}}
      onStyle={() => {}}
      onOrder={() => {}}
      {...overrides}
    />
  );
}

/** Lays the ribbon out `width` pixels wide. */
function widen(width: number) {
  ribbonWidth = width;
  act(() => resize?.([], {} as ResizeObserver));
}

const collapsedButton = (section: string) => screen.queryByRole("button", { name: `${section} tools` });
/** What the sections take together, every one open. */
const ALL_OPEN = EDIT_SECTIONS.length * (SECTION_WIDTH + 1);
/** What the ribbon gains as `section` collapses. */
const gain = (section: string) => SECTION_WIDTH + 1 - collapsedWidth(section);

// The slide editor is at work on the deck's first slide.
beforeEach(() => useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", editing: true, running: false }));
afterEach(() => {
  resetEditorState();
  useApp.setState({ editing: false, editTool: "select", editToolKept: false });
});

/** A selection as the editor reports it, with `look` set. */
const selection = (look: Partial<EditSelection> & { kind: string }) => parseSelection(look) as EditSelection;
const SHAPE = selection({ kind: "shape", text: true });
const ONE = { count: 1, x: 0, y: 0, w: 100, h: 50, rotation: 0 };
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const menuItem = (name: string) =>
  screen
    .queryAllByRole("menuitem")
    .concat(screen.queryAllByRole("menuitemcheckbox"))
    .find((el) => el.textContent?.startsWith(name)) as HTMLButtonElement;

describe("EditToolbar ribbon", () => {
  beforeEach(() => {
    resize = null;
    ribbonWidth = 0;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(SECTION_WIDTH);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => ribbonWidth);
  });

  afterEach(() => {
    globalThis.ResizeObserver = NoLayout;
    vi.restoreAllMocks();
  });

  it("groups its tools in captioned sections, the insert tools compact", () => {
    render(toolbar());
    for (const name of EDIT_SECTIONS) {
      expect(within(screen.getByRole("group", { name })).getAllByText(name).length).toBeGreaterThan(0);
    }
    const inGroup = (group: string, tool: string) =>
      within(screen.getByRole("group", { name: group })).getByRole("button", { name: tool });
    for (const tool of ["Select and move", "Add text", "Shapes", "Lines", "Add an image from a file…"]) {
      expect(inGroup("Insert", tool)).toBeTruthy();
    }
    // The insert tools are eight buttons, the shapes behind one of them.
    expect(within(screen.getByRole("group", { name: "Insert" })).getAllByRole("button")).toHaveLength(8);
    expect(screen.queryByRole("button", { name: "Add a rectangle" })).toBeNull();
    expect(inGroup("Text", "Bold")).toBeTruthy();
    expect(inGroup("Paragraph", "Bulleted list")).toBeTruthy();
    expect(inGroup("Style", "Fill")).toBeTruthy();
    expect(inGroup("Slide", "Slide background")).toBeTruthy();
    for (const tool of ["Align", "Order", "Rotate and flip", "Position and size", "Duplicate", "Layers"]) {
      expect(inGroup("Arrange", tool)).toBeTruthy();
    }
    // Deleting is on the keyboard and in the context menu, not beside Duplicate.
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    // The canvas's own settings are at the end, not among what acts on the selection.
    expect(inGroup("Canvas", "Canvas options")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Snap to guides" })).toBeNull();
    expect(inGroup("Timeline", "Show the timeline under the slide")).toBeTruthy();
  });

  it("measures its sections once, and fits them to each new width from that", () => {
    render(toolbar());
    const widths = vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!.get!);
    const measured = widths.mock.calls.length;
    expect(measured).toBe(EDIT_SECTIONS.length);
    for (const width of [5000, 4990, 4980, 4970, 4970]) widen(width);
    expect(widths.mock.calls.length).toBe(measured);
    for (const name of EDIT_SECTIONS) expect(collapsedButton(name)).toBeNull();
  });

  it("measures its sections again once what is in them changed, when it next resizes", async () => {
    render(toolbar());
    widen(4 * SECTION_WIDTH);
    expect(collapsedButton("Paragraph")).toBeTruthy();
    await act(async () => {});
    const widths = vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!.get!);
    const measured = widths.mock.calls.length;
    widen(4 * SECTION_WIDTH - 10);
    expect(widths.mock.calls.length).toBe(measured + EDIT_SECTIONS.length);
    widen(4 * SECTION_WIDTH - 20);
    expect(widths.mock.calls.length).toBe(measured + EDIT_SECTIONS.length);
  });

  it("puts what pops up back in the bar reading the layout once for all of it, not once for each", () => {
    const { container } = render(<div>{toolbar()}</div>);
    widen(100);
    const flyouts = container.querySelectorAll<HTMLElement>("[data-flyout]");
    // The timeline's one toggle needs no flyout, and the canvas's one button never collapses.
    expect(flyouts.length).toBe(EDIT_SECTIONS.length - 2);
    const order: string[] = [];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches("[data-flyout]")) order.push("read");
      return new DOMRect(this.matches("[data-flyout]") ? 900 : 0, 0, this.matches("[data-flyout]") ? 300 : 1000, 40);
    });
    for (const flyout of flyouts) {
      const style = flyout.style;
      const set = style.setProperty.bind(style);
      Object.defineProperty(style, "marginLeft", {
        configurable: true,
        get: () => style.getPropertyValue("margin-left"),
        set: (value: string) => {
          if (value) order.push("write");
          set("margin-left", value);
        },
      });
    }
    widen(90);
    const firstWrite = order.indexOf("write");
    expect(order.filter((step) => step === "read")).toHaveLength(flyouts.length);
    expect(order.slice(firstWrite).every((step) => step === "write")).toBe(true);
    expect(flyouts[0]!.style.marginLeft).toBe("-204px");
  });

  it("keeps every section open while there is room, and with no layout to go by", () => {
    render(toolbar());
    for (const name of EDIT_SECTIONS) expect(collapsedButton(name)).toBeNull();
    widen(5000);
    for (const name of EDIT_SECTIONS) expect(collapsedButton(name)).toBeNull();
  });

  it("with something selected, collapses the insert tools first and keeps the formatting open", () => {
    render(toolbar({ selection: SHAPE, geometry: ONE }));
    widen(ALL_OPEN - gain("Timeline") - 1);
    expect(screen.getByRole("button", { name: "Show the timeline under the slide" })).toBeTruthy();
    expect(collapsedButton("Insert")).toBeTruthy();
    for (const name of ["Text", "Paragraph", "Style", "Arrange"]) expect(collapsedButton(name)).toBeNull();
    // Narrower still, the paragraph's tools go before the text's, and arranging stays longest.
    widen(ALL_OPEN - gain("Timeline") - gain("Insert") - 1);
    expect(collapsedButton("Paragraph")).toBeTruthy();
    expect(collapsedButton("Text")).toBeNull();
    expect(collapsedButton("Arrange")).toBeNull();
  });

  it("with nothing selected, keeps the insert tools open and collapses the formatting", () => {
    render(toolbar());
    widen(ALL_OPEN - gain("Timeline") - 1);
    expect(collapsedButton("Insert")).toBeNull();
    expect(collapsedButton("Paragraph")).toBeTruthy();
  });

  it("lays out again when a selection comes or goes, and not between selections", () => {
    const { rerender } = render(toolbar());
    widen(ALL_OPEN - gain("Timeline") - 1);
    expect(collapsedButton("Insert")).toBeNull();
    rerender(toolbar({ selection: SHAPE, geometry: ONE }));
    expect(collapsedButton("Insert")).toBeTruthy();
    expect(collapsedButton("Paragraph")).toBeNull();
    rerender(toolbar({ selection: selection({ kind: "text", text: true, bold: true }), geometry: ONE }));
    expect(collapsedButton("Insert")).toBeTruthy();
    rerender(toolbar());
    expect(collapsedButton("Insert")).toBeNull();
  });

  it("captions a collapsed section, and gives it a width of its own", () => {
    render(toolbar());
    widen(100);
    const paragraph = collapsedButton("Paragraph")!;
    expect(paragraph.textContent).toBe("Paragraph");
    expect((screen.getByRole("group", { name: "Paragraph" }) as HTMLElement).style.width).toBe(
      `${collapsedWidth("Paragraph")}px`,
    );
    // The timeline's one toggle stays a toggle, captioned, with no flyout.
    expect(collapsedButton("Timeline")).toBeNull();
    const timeline = screen.getAllByRole("button", { name: "Show the timeline under the slide" });
    expect(timeline.some((el) => el.textContent === "Timeline")).toBe(true);
  });

  it("never collapses a section that would be no narrower collapsed", () => {
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!.get!).mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.closest("[aria-label=Slide]") ? 38 : SECTION_WIDTH;
    });
    render(toolbar());
    widen(100);
    expect(collapsedButton("Slide")).toBeNull();
    expect(collapsedButton("Insert")).toBeTruthy();
  });

  it("opens a collapsed section's tools from its icon, working as they do in the ribbon", () => {
    const onOrder = vi.fn();
    render(toolbar({ onOrder, selection: SHAPE, geometry: ONE }));
    widen(100);
    expect(collapsedButton("Arrange")!.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(collapsedButton("Arrange")!);
    expect(collapsedButton("Arrange")!.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(button("Order"));
    fireEvent.click(menuItem("Bring to front"));
    expect(onOrder).toHaveBeenCalledWith("front");
    fireEvent.click(collapsedButton("Arrange")!);
    expect(collapsedButton("Arrange")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a tool's panel in a flyout below the flyout, never over its tools", async () => {
    const { container } = render(<div>{toolbar({ selection: SHAPE, geometry: ONE })}</div>);
    widen(100);
    fireEvent.click(collapsedButton("Style")!);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches("[data-flyout]")) return new DOMRect(0, 40, 200, 70);
      if (this.matches("[role=dialog]")) return new DOMRect(0, 64, 200, 200);
      // The fill well's button, which the panel hangs from.
      return new DOMRect(0, 40, 24, 24);
    });
    fireEvent.click(button("Fill"));
    await act(async () => {});
    const panel = container.querySelector<HTMLElement>("[role=dialog][aria-label=Fill]")!;
    // The flyout reaches 46px further down than the button: the panel starts below it.
    expect(panel.style.marginTop).toBe("50px");
  });

  it("closes a section's flyout on a press outside it", () => {
    render(toolbar());
    widen(100);
    fireEvent.click(collapsedButton("Text")!);
    fireEvent.pointerDown(screen.getByRole("group", { name: "Text" }));
    expect(collapsedButton("Text")!.getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerDown(document.body);
    expect(collapsedButton("Text")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes a section's flyout when a tool is picked, to get out of the way of the slide", () => {
    const { rerender } = render(toolbar());
    widen(100);
    fireEvent.click(collapsedButton("Insert")!);
    rerender(toolbar({ tool: "rect" }));
    expect(collapsedButton("Insert")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("drops the flyout when its section has room again", () => {
    render(toolbar());
    widen(100);
    fireEvent.click(collapsedButton("Style")!);
    widen(5000);
    widen(100);
    expect(collapsedButton("Style")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a flyout inside the bar around the ribbon", async () => {
    const { container } = render(<div>{toolbar()}</div>);
    const rect = (left: number, right: number) => ({ left, right }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.matches("[data-flyout]") ? rect(400, 620) : rect(0, 500);
    });
    widen(100);
    await act(async () => {});
    expect(container.querySelector<HTMLElement>("[data-flyout]")!.style.marginLeft).toBe("-124px");
  });
});

describe("EditToolbar controls", () => {
  afterEach(() => {
    act(() =>
      useApp.setState({ recentColors: [], editPanelAsk: null, editSnap: true, copiedStyle: null, running: false }),
    );
    localStorage.clear();
  });

  it("says in a disabled control's tooltip what it waits for", () => {
    render(toolbar());
    const reasons: Record<string, string> = {
      Bold: "Select text or a text box",
      "Align text left": "Select text or a text box",
      "More text formatting": "Select text or a text box",
      "Text color": "Select text or a text box",
      Spacing: "Select text or a text box",
      Fill: "Select an element",
      "Border color": "Select an element",
      Effects: "Select an element",
      Link: "Select an element",
      Group: "Select two or more elements to group them, or a group to take it apart",
      Align: "Select an element",
      Order: "Select an element",
      "Rotate and flip": "Select an element",
      Lock: "Select an element",
      Duplicate: "Select an element",
      Layers: "Nothing on this slide",
    };
    for (const [name, reason] of Object.entries(reasons)) {
      expect(button(name).disabled, name).toBe(true);
      expect(button(name).title, name).toBe(reason);
      expect(button(name).className, name).not.toContain("pointer-events-none");
    }
    for (const name of ["Font", "Font weight"]) {
      const list = screen.getByRole("combobox", { name }) as HTMLSelectElement;
      expect(list.disabled, name).toBe(true);
      expect(list.title, name).toMatch(/^Select /);
    }
    expect((screen.getByLabelText("Font size") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Border width") as HTMLInputElement).disabled).toBe(true);
  });

  it("names the keys in the tooltips, not in the accessible names", () => {
    render(toolbar({ selection: SHAPE, geometry: { ...ONE, count: 2 } }));
    const keys: Record<string, string> = {
      "Select and move": "V",
      "Add text": "T",
      Bold: "Ctrl+B",
      Italic: "Ctrl+I",
      Underline: "Ctrl+U",
      Link: "Ctrl+K",
      "Align text left": "Ctrl+Shift+L",
      "Center text": "Ctrl+Shift+E",
      "Align text right": "Ctrl+Shift+R",
      "Justify text": "Ctrl+Shift+J",
      Group: "Ctrl+G",
      Lock: "Ctrl+Alt+L",
      Duplicate: "Ctrl+D",
    };
    for (const [name, shortcut] of Object.entries(keys)) {
      const title = button(name).title;
      expect(title.endsWith(`(${shortcut})`), `${name}: ${title}`).toBe(true);
    }
    expect(button("Group").title).toBe("Group the selected elements, to move, size and style them as one (Ctrl+G)");
    // The menus list theirs.
    fireEvent.click(button("Order"));
    expect(menuItem("Bring to front").textContent).toContain("Ctrl+Shift+]");
  });

  it("marks the buttons that open a panel or a menu", () => {
    render(toolbar({ selection: SHAPE, geometry: ONE, layers: [] }));
    for (const name of ["Spacing", "Effects", "Link", "Align", "Order", "Rotate and flip", "Position and size"]) {
      expect(button(name).getAttribute("aria-expanded"), name).toBe("false");
      expect(button(name).querySelectorAll("svg").length, name).toBe(2);
    }
  });

  it("hands the focus back to the slide after a pick from any list or a typed number", () => {
    const onReturnFocus = vi.fn();
    const onStyle = vi.fn();
    render(toolbar({ selection: SHAPE, onReturnFocus, onStyle }));
    const picks: [string, string, object][] = [
      ["Font", "Arial, Helvetica, sans-serif", { fontFamily: "Arial, Helvetica, sans-serif" }],
      ["Font weight", "600", { weight: 600 }],
    ];
    for (const [name, value, style] of picks) {
      onReturnFocus.mockClear();
      fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
      expect(onStyle, name).toHaveBeenLastCalledWith(style);
      expect(onReturnFocus, name).toHaveBeenCalledTimes(1);
    }
    // Any width, not just the listed ones.
    onReturnFocus.mockClear();
    const width = screen.getByLabelText("Border width");
    fireEvent.change(width, { target: { value: "3" } });
    fireEvent.keyDown(width, { key: "Enter" });
    expect(onStyle).toHaveBeenLastCalledWith({ strokeWidth: 3 });
    expect(onReturnFocus).toHaveBeenCalledTimes(1);
    // Or one of the usual ones.
    fireEvent.click(button("Border width: usual values"));
    fireEvent.click(screen.getByRole("option", { name: "8 px" }));
    expect(onStyle).toHaveBeenLastCalledWith({ strokeWidth: 8 });
  });

  it("offers the weights the deck's font comes in", () => {
    act(() =>
      reportDeckLook({ fonts: [{ name: "Inter", stack: "Inter, sans-serif", weights: [300, 400, 500, 600, 800] }] }),
    );
    render(toolbar({ selection: selection({ kind: "text", text: true, fontFamily: "Inter", weight: 500 }) }));
    const weight = screen.getByRole("combobox", { name: "Font weight" }) as HTMLSelectElement;
    expect([...weight.options].map((o) => o.text)).toEqual(["Light", "Regular", "Medium", "Semibold", "Extra bold"]);
    expect(weight.value).toBe("500");
  });

  it("shows what several selected elements do not share as mixed", () => {
    const onStyle = vi.fn();
    render(
      toolbar({
        selection: selection({
          kind: "text",
          text: true,
          fontFamily: "Georgia",
          fontSize: 40,
          bold: true,
          align: "center",
          dash: "dashed",
          strokeWidth: 4,
          opacity: 0.5,
          mixed: ["fontFamily", "fontSize", "weight", "bold", "align", "dash", "strokeWidth", "opacity"],
        }),
        geometry: { ...ONE, count: 2 },
        onStyle,
      }),
    );
    expect((screen.getByRole("combobox", { name: "Font" }) as HTMLSelectElement).selectedOptions[0]!.text).toBe(
      "Mixed",
    );
    expect((screen.getByRole("combobox", { name: "Font weight" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Font size") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Border width") as HTMLInputElement).value).toBe("");
    expect(button("Bold").getAttribute("aria-pressed")).toBe("mixed");
    // A mixed toggle makes them all bold.
    fireEvent.click(button("Bold"));
    expect(onStyle).toHaveBeenLastCalledWith({ bold: true });
    expect(button("Center text").getAttribute("aria-pressed")).toBe("false");
    expect(button("Border style").title).toBe("Border style: mixed");
    // A slider shows no number until it is moved.
    fireEvent.click(button("Effects"));
    expect((screen.getByLabelText("Opacity value") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("slider", { name: "Opacity" }).getAttribute("aria-valuetext")).toBe("Mixed");
  });

  it("steps the text size from each element's own, and clears formatting, from the text menu", () => {
    const onArrange = vi.fn();
    render(toolbar({ selection: selection({ kind: "text", text: true }), onArrange }));
    fireEvent.click(button("More text formatting"));
    fireEvent.click(menuItem("Larger text"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-font-step", step: 1 });
    fireEvent.click(button("More text formatting"));
    fireEvent.click(menuItem("Smaller text"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-font-step", step: -1 });
    fireEvent.click(button("More text formatting"));
    fireEvent.click(menuItem("Clear formatting"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-clear-formatting" });
  });

  it("sets the case, strikethrough and scripts from the text menu", () => {
    const onStyle = vi.fn();
    render(toolbar({ selection: selection({ kind: "text", text: true, textCase: "upper" }), onStyle }));
    fireEvent.click(button("More text formatting"));
    expect(menuItem("UPPERCASE").getAttribute("aria-checked")).toBe("true");
    expect(menuItem("Strikethrough").textContent).toContain("Ctrl+Shift+X");
    fireEvent.click(menuItem("As typed"));
    expect(onStyle).toHaveBeenLastCalledWith({ textCase: null });
    fireEvent.click(button("More text formatting"));
    fireEvent.click(menuItem("Superscript"));
    expect(onStyle).toHaveBeenLastCalledWith({ script: "sup" });
  });

  it("offers the deck's default text color and size", () => {
    const onStyle = vi.fn();
    render(toolbar({ selection: selection({ kind: "text", text: true, fontSize: 40, color: "#ff0000" }), onStyle }));
    fireEvent.click(button("Text color"));
    fireEvent.click(screen.getByRole("button", { name: "Deck default" }));
    expect(onStyle).toHaveBeenLastCalledWith({ color: null });
    fireEvent.click(button("Font size: usual values"));
    fireEvent.click(screen.getByRole("option", { name: "Deck default" }));
    expect(onStyle).toHaveBeenLastCalledWith({ fontSize: null });
  });

  it("highlights text, and sets its spacing, indents and bullets", () => {
    const onStyle = vi.fn();
    const onArrange = vi.fn();
    render(
      toolbar({
        selection: selection({ kind: "text", text: true, list: "ul", listStyle: "disc" }),
        onStyle,
        onArrange,
      }),
    );
    fireEvent.click(button("Highlight"));
    fireEvent.click(screen.getByRole("button", { name: `Yellow (${SWATCHES.yellow})` }));
    expect(onStyle).toHaveBeenLastCalledWith({ highlight: SWATCHES.yellow });
    fireEvent.click(button("Increase indent"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-indent", step: 1 });
    fireEvent.click(button("Spacing"));
    const spaced = within(screen.getByRole("dialog", { name: "Spacing" }));
    const before = spaced.getByLabelText("Space before");
    fireEvent.change(before, { target: { value: "12" } });
    fireEvent.keyDown(before, { key: "Enter" });
    expect(onStyle).toHaveBeenLastCalledWith({ spaceBefore: 12 });
    const height = spaced.getByLabelText("Line height");
    fireEvent.change(height, { target: { value: "1.3" } });
    fireEvent.keyDown(height, { key: "Enter" });
    expect(onStyle).toHaveBeenLastCalledWith({ lineHeight: 1.3 });
    fireEvent.change(spaced.getByRole("combobox", { name: "Bullets" }), { target: { value: "square" } });
    expect(onStyle).toHaveBeenLastCalledWith({ listStyle: "square" });
  });

  it("places text in its box and says what happens when it does not fit, in one menu", () => {
    const onStyle = vi.fn();
    render(toolbar({ selection: selection({ kind: "shape", text: true, valign: "middle" }), onStyle }));
    fireEvent.click(button("Text in its box"));
    expect(menuItem("Middle").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(menuItem("Shrink text to fit"));
    expect(onStyle).toHaveBeenLastCalledWith({ autofit: "shrink" });
  });

  it("draws the dashes it offers, and picks one", () => {
    const onStyle = vi.fn();
    render(toolbar({ selection: SHAPE, onStyle }));
    fireEvent.click(button("Border style"));
    const dashes = within(screen.getByRole("dialog", { name: "Border style" }));
    expect(dashes.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Solid",
      "Dashed",
      "Dotted",
    ]);
    fireEvent.click(dashes.getByRole("button", { name: "Dotted" }));
    expect(onStyle).toHaveBeenLastCalledWith({ dash: "dotted" });
  });

  describe("the slot for one kind of selection", () => {
    it("shows an image's tools only for an image, with Replace labelled and no position for a stretched one", () => {
      const onPickImage = vi.fn();
      const onStyle = vi.fn();
      const { rerender } = render(toolbar({ selection: SHAPE }));
      expect(screen.queryByRole("button", { name: "Image options" })).toBeNull();
      rerender(toolbar({ selection: selection({ kind: "media", image: true, fit: "fill" }), onPickImage, onStyle }));
      fireEvent.click(button("Image options"));
      fireEvent.click(screen.getByRole("button", { name: /Replace image…/ }));
      expect(onPickImage).toHaveBeenCalledWith(true);
      expect((screen.getByRole("group", { name: "Image position" }) as HTMLFieldSetElement).disabled).toBe(true);
      rerender(toolbar({ selection: selection({ kind: "media", image: true, fit: "cover" }), onPickImage, onStyle }));
      expect((screen.getByRole("group", { name: "Image position" }) as HTMLFieldSetElement).disabled).toBe(false);
    });

    it("shows a line's tools for a line, swaps its ends, and offers it no fill", () => {
      const onStyle = vi.fn();
      const line = selection({
        kind: "drawing",
        vector: true,
        line: { start: null, end: "arrow", route: "straight" },
      });
      render(toolbar({ selection: line, onStyle }));
      expect(button("Fill").disabled).toBe(true);
      expect(button("Fill").title).toBe("A line has no fill");
      expect(button("Line color")).toBeTruthy();
      fireEvent.click(button("Line ends and route"));
      fireEvent.click(screen.getByRole("button", { name: "Swap ends" }));
      expect(onStyle).toHaveBeenLastCalledWith({ headStart: "arrow", headEnd: null });
      const start = within(screen.getByRole("group", { name: "Start of the line" }));
      fireEvent.click(start.getByRole("button", { name: "Dot" }));
      expect(onStyle).toHaveBeenLastCalledWith({ headStart: "dot" });
    });

    it("shows a shape's radius and proportions for a shape, and nothing for plain text", () => {
      const { rerender } = render(
        toolbar({
          selection: selection({
            kind: "shape",
            text: true,
            adjust: { value: 5, min: 3, max: 12, step: 1, label: "Points" },
          }),
        }),
      );
      fireEvent.click(button("Shape options"));
      expect(screen.getByRole("slider", { name: "Points" })).toBeTruthy();
      rerender(toolbar({ selection: selection({ kind: "text", text: true, radius: 0 }) }));
      expect(screen.queryByRole("button", { name: "Shape options" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Line ends and route" })).toBeNull();
    });
  });

  describe("insert tools", () => {
    it("adds a shape from the gallery, and keeps it in hand on a double-click", () => {
      const onTool = vi.fn();
      const onArrange = vi.fn();
      render(toolbar({ onTool, onArrange }));
      fireEvent.click(button("Shapes"));
      const gallery = within(screen.getByRole("dialog", { name: "Shapes" }));
      for (const heading of ["Basic shapes", "Flowchart", "Arrows", "More shapes"]) {
        expect(gallery.getByRole("group", { name: heading })).toBeTruthy();
      }
      fireEvent.click(gallery.getByRole("button", { name: "Add a brace" }));
      expect(onTool).toHaveBeenCalledWith("brace");
      expect(screen.queryByRole("dialog", { name: "Shapes" })).toBeNull();
      fireEvent.click(button("Shapes"));
      fireEvent.doubleClick(screen.getByRole("button", { name: "Add a rectangle" }));
      expect(useApp.getState()).toMatchObject({ editTool: "rect", editToolKept: true });
      expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-tool-keep", tool: "rect", on: true });
    });

    it("finds the connectors with the lines", () => {
      const onTool = vi.fn();
      render(toolbar({ onTool }));
      fireEvent.click(button("Lines"));
      const gallery = within(screen.getByRole("dialog", { name: "Lines" }));
      expect(gallery.getByRole("group", { name: "Connectors" })).toBeTruthy();
      fireEvent.click(gallery.getByRole("button", { name: /^Add an elbow connector/ }));
      expect(onTool).toHaveBeenCalledWith("elbow");
    });

    it("lets go of a kept tool on a single click", () => {
      const onArrange = vi.fn();
      act(() => useApp.getState().setEditTool("text", true));
      render(toolbar({ tool: "text", onArrange }));
      expect(button("Add text").title).toContain("kept for several");
      fireEvent.click(button("Select and move"));
      expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-tool-keep", tool: "select", on: false });
    });

    it("marks the requests to the agent as such, and holds them while it is busy", () => {
      const onInsertAsk = vi.fn();
      const { rerender } = render(toolbar({ onInsertAsk }));
      for (const [name, kind] of [
        ["Ask the agent for a table", "table"],
        ["Ask the agent for a chart", "chart"],
        ["Ask the agent for an icon", "icon"],
      ] as const) {
        expect(button(name).title).toMatch(/· asks the agent$/);
        expect(button(name).querySelector(".text-primary")).toBeTruthy();
        fireEvent.click(button(name));
        expect(onInsertAsk).toHaveBeenLastCalledWith(kind);
      }
      act(() => useApp.setState({ running: true }));
      rerender(toolbar({ onInsertAsk }));
      expect(button("Ask the agent for a table").disabled).toBe(true);
      expect(button("Ask the agent for a table").title).toBe("The agent is busy");
    });
  });

  it("keeps the format painter for several on a double-click, and tells the copy-style keys", () => {
    const onTool = vi.fn();
    const onArrange = vi.fn();
    render(toolbar({ selection: SHAPE, onTool, onArrange }));
    expect(button("Format painter").title).toContain("Ctrl+Alt+C");
    fireEvent.doubleClick(button("Format painter"));
    expect(useApp.getState()).toMatchObject({ editTool: "paint", editToolKept: true });
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-tool-keep", tool: "paint", on: true });
  });

  it("duplicates, and keeps the canvas's settings in their own menu", () => {
    const onArrange = vi.fn();
    const onSizeMode = vi.fn();
    render(toolbar({ selection: SHAPE, geometry: ONE, onArrange, onSizeMode }));
    fireEvent.click(button("Duplicate"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-duplicate" });
    fireEvent.click(button("Canvas options"));
    const snap = menuItem("Snap to guides");
    expect(snap.getAttribute("aria-checked")).toBe("true");
    expect(snap.title).toContain("hold Ctrl while dragging");
    fireEvent.click(snap);
    expect(useApp.getState().editSnap).toBe(false);
    expect(localStorage.getItem("slopslides.editSnap")).toBe("false");
    fireEvent.click(menuItem("Stretch contents when resizing"));
    expect(onSizeMode).toHaveBeenCalledWith("stretch");
    act(() => useEditorState.setState({ sizeMode: "stretch" }));
    // While it is on, the button says so.
    expect(button("Canvas options").getAttribute("aria-pressed")).toBe("true");
  });

  it("aligns, distributes and matches sizes from the Align menu", () => {
    const onArrange = vi.fn();
    const { rerender } = render(toolbar({ selection: SHAPE, geometry: ONE, onArrange }));
    fireEvent.click(button("Align"));
    fireEvent.click(menuItem("Align left"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-align", to: "left", target: "slide" });
    fireEvent.click(button("Align"));
    expect(menuItem("Distribute horizontally").disabled).toBe(true);
    expect(menuItem("Distribute horizontally").title).toBe("Select three or more elements");
    rerender(toolbar({ selection: SHAPE, geometry: { ...ONE, count: 3, rotation: null }, onArrange }));
    fireEvent.click(menuItem("Align top"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-align", to: "top", target: "selection" });
    fireEvent.click(button("Align"));
    fireEvent.click(menuItem("Distribute vertically"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-distribute", axis: "v" });
    fireEvent.click(button("Align"));
    fireEvent.click(menuItem("Match width"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-match", axis: "w" });
  });

  it("turns and flips from the ribbon's Rotate menu", () => {
    const onArrange = vi.fn();
    render(
      toolbar({ selection: selection({ kind: "media", image: true, flippable: true }), geometry: ONE, onArrange }),
    );
    fireEvent.click(button("Rotate and flip"));
    expect(menuItem("Rotate right 90°").textContent).toContain("Ctrl+Alt+R");
    fireEvent.click(menuItem("Rotate right 90°"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-rotate", step: 1 });
    fireEvent.click(button("Rotate and flip"));
    fireEvent.click(menuItem("Flip vertically"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-flip", axis: "y" });
  });

  it("lays out Position and size as a grid, rotation labelled, 3D rotate folded away", () => {
    const onArrange = vi.fn();
    const { rerender } = render(toolbar({ selection: SHAPE, geometry: ONE, onArrange }));
    fireEvent.click(button("Position and size"));
    const panel = within(screen.getByRole("dialog", { name: "Position and size" }));
    for (const label of ["Position", "Size", "Rotate"]) expect(panel.getByText(label)).toBeTruthy();
    expect(panel.getByLabelText("Rotation in degrees")).toBeTruthy();
    expect(panel.queryByRole("group", { name: "3D rotate" })).toBeNull();
    fireEvent.click(panel.getByRole("button", { name: "3D rotate" }));
    expect(panel.getByRole("group", { name: "3D rotate" })).toBeTruthy();
    fireEvent.click(panel.getByRole("button", { name: /^Rotate left 90°/ }));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-rotate", step: -1 });
    expect(button("Flip horizontally").disabled).toBe(true);
    rerender(toolbar({ selection: SHAPE, geometry: { ...ONE, count: 3, rotation: null }, onArrange }));
    expect(button("Lock aspect ratio").disabled).toBe(true);
    fireEvent.click(button("Flip vertically"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-flip", axis: "y" });
    expect(screen.getByText(/3 elements selected/)).toBeTruthy();
  });

  it("moves a layer up or down exactly where the editor says it can", () => {
    const onArrange = vi.fn();
    const layer = (name: string, path: number[], canUp: boolean, canDown: boolean): EditLayer => ({
      path,
      name,
      group: false,
      locked: false,
      held: false,
      selected: false,
      depth: 0,
      canUp,
      canDown,
    });
    render(
      toolbar({
        selection: SHAPE,
        geometry: ONE,
        onArrange,
        layers: [layer("Box", [3], false, true), layer("Image", [0, 1], true, true), layer("Title", [1], true, false)],
      }),
    );
    fireEvent.click(button("Layers"));
    expect(button("Move Box up").disabled).toBe(true);
    // A layer in another place on the slide still moves among them.
    expect(button("Move Image up").disabled).toBe(false);
    expect(button("Move Image down").disabled).toBe(false);
    expect(button("Move Title down").disabled).toBe(true);
    fireEvent.click(button("Move Image up"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-order", to: "forward", path: [0, 1], any: true });
  });

  describe("color wells", () => {
    it("names the swatches, and tells no color from one that is mixed or not plain", () => {
      const { rerender } = render(toolbar({ selection: selection({ kind: "shape", fill: SWATCHES.blue }) }));
      expect(button("Fill").title).toBe(`Fill: Blue (${SWATCHES.blue})`);
      expect(screen.getByTestId("Fill swatch").dataset.state).toBe("color");
      fireEvent.click(button("Fill"));
      const well = within(screen.getByRole("dialog", { name: "Fill" }));
      expect(well.getByRole("button", { name: `Blue (${SWATCHES.blue})` }).getAttribute("aria-pressed")).toBe("true");
      expect(well.queryByText(/Mixed/)).toBeNull();

      rerender(toolbar({ selection: selection({ kind: "shape" }) }));
      expect(button("Fill").title).toBe("Fill: none");
      expect(well.getByRole("button", { name: "None" }).getAttribute("aria-pressed")).toBe("true");

      rerender(toolbar({ selection: selection({ kind: "shape", fillOther: true }) }));
      expect(button("Fill").title).toBe("Fill: mixed, or not a plain color");
      expect(screen.getByTestId("Fill swatch").dataset.state).toBe("other");
      expect(well.getByText(/Picking a color replaces it/)).toBeTruthy();
    });

    it("stays open while colors are tried, showing each on the slide under the pointer", () => {
      const onStyle = vi.fn();
      const onArrange = vi.fn();
      const { rerender } = render(toolbar({ selection: SHAPE, onStyle, onArrange }));
      fireEvent.click(button("Fill"));
      const red = screen.getByRole("button", { name: `Red (${SWATCHES.red})` });
      fireEvent.mouseEnter(red);
      expect(onArrange).toHaveBeenLastCalledWith({
        type: "slop:edit-style",
        style: { fill: SWATCHES.red },
        preview: true,
      });
      fireEvent.mouseLeave(screen.getByRole("dialog", { name: "Fill" }));
      expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-style-cancel" });
      fireEvent.click(red);
      expect(onStyle).toHaveBeenLastCalledWith({ fill: SWATCHES.red });
      fireEvent.click(screen.getByRole("button", { name: `Green (${SWATCHES.green})` }));
      expect(onStyle).toHaveBeenLastCalledWith({ fill: SWATCHES.green });
      expect(screen.getByRole("dialog", { name: "Fill" })).toBeTruthy();
      // The editor reports the color picked last, and the ring goes to it, the well still open.
      rerender(
        toolbar({ selection: selection({ kind: "shape", text: true, fill: SWATCHES.green }), onStyle, onArrange }),
      );
      expect(screen.getByRole("button", { name: `Green (${SWATCHES.green})` }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("dialog", { name: "Fill" })).toBeNull();
    });

    it("takes a typed hex value on Enter", () => {
      const onStyle = vi.fn();
      const onReturnFocus = vi.fn();
      render(toolbar({ selection: SHAPE, onStyle, onReturnFocus }));
      fireEvent.click(button("Fill"));
      const hex = screen.getByLabelText("Fill as a hex value") as HTMLInputElement;
      fireEvent.change(hex, { target: { value: "nope" } });
      fireEvent.keyDown(hex, { key: "Enter" });
      expect(onStyle).not.toHaveBeenCalled();
      expect(hex.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByText(/Type a hex color/)).toBeTruthy();
      fireEvent.change(hex, { target: { value: "1A2b3c" } });
      fireEvent.keyDown(hex, { key: "Enter" });
      expect(onStyle).toHaveBeenCalledWith({ fill: "#1a2b3c" });
      expect(onReturnFocus).toHaveBeenCalled();
    });

    it("offers the deck's colors with a lighter and a darker row, in as many columns as there are", () => {
      act(() =>
        reportDeckLook({
          colors: Array.from({ length: 7 }, (_, i) => ({ name: `c${i}`, value: `#00000${i}` })),
        }),
      );
      render(toolbar({ selection: SHAPE }));
      fireEvent.click(button("Fill"));
      const deck = screen.getByRole("group", { name: "Deck colors" });
      expect(within(deck).getAllByRole("button")).toHaveLength(21);
      expect((deck.querySelector("div") as HTMLElement).style.gridTemplateColumns).toBe("repeat(7, minmax(0, 1fr))");
    });

    it("offers the colors picked last, in every well", () => {
      const onStyle = vi.fn();
      render(toolbar({ selection: SHAPE, onStyle }));
      fireEvent.click(button("Fill"));
      expect(screen.queryByRole("group", { name: "Recent" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: `Red (${SWATCHES.red})` }));
      fireEvent.change(screen.getByLabelText("Fill as a hex value"), { target: { value: "#123456" } });
      fireEvent.keyDown(screen.getByLabelText("Fill as a hex value"), { key: "Enter" });
      expect(useApp.getState().recentColors).toEqual(["#123456", SWATCHES.red]);
      fireEvent.pointerDown(document.body);
      fireEvent.click(button("Border color"));
      const recent = within(screen.getByRole("group", { name: "Recent" }));
      fireEvent.click(recent.getByRole("button", { name: "Recent color #123456" }));
      expect(onStyle).toHaveBeenLastCalledWith({ stroke: "#123456" });
    });

    it("picks a color from the screen where the browser can", async () => {
      const onStyle = vi.fn();
      const open = vi.fn().mockResolvedValue({ sRGBHex: "#AABBCC" });
      Object.assign(window, {
        EyeDropper: class {
          open = open;
        },
      });
      render(toolbar({ selection: SHAPE, onStyle }));
      fireEvent.click(button("Fill"));
      await act(async () => fireEvent.click(button("Pick a color from the screen")));
      expect(onStyle).toHaveBeenLastCalledWith({ fill: "#aabbcc" });
      delete (window as { EyeDropper?: unknown }).EyeDropper;
    });
  });

  describe("slide background", () => {
    it("says a gradient or image is not a color, and that a pick replaces it", () => {
      act(() => reportDeckLook({ background: "#f4f1ea", backgroundOther: true }));
      render(toolbar());
      expect(screen.getByTestId("Slide background swatch").dataset.state).toBe("other");
      fireEvent.click(button("Slide background"));
      expect(
        screen.getByText("This slide has a gradient or image background. Picking a color replaces it."),
      ).toBeTruthy();
      expect((screen.getByRole("button", { name: /Apply to all slides/ }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("gives every slide this one's background", async () => {
      const apply = vi.fn().mockResolvedValue(2);
      const { applyBackgroundToAll } = useApp.getState();
      useApp.setState({ applyBackgroundToAll: apply });
      act(() => reportDeckLook({ background: "#ff0000", backgroundOwn: true }));
      render(toolbar());
      fireEvent.click(button("Slide background"));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: /Apply to all slides/ })));
      expect(apply).toHaveBeenCalledWith("#ff0000");
      // The deck's own background goes to the others as theirs again.
      act(() => reportDeckLook({ background: "#ffffff", backgroundOwn: false }));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: /Apply to all slides/ })));
      expect(apply).toHaveBeenLastCalledWith(null);
      useApp.setState({ applyBackgroundToAll });
    });
  });

  it("opens the Link, Position and size and background popovers when they are asked for from outside", () => {
    const onPickImage = vi.fn();
    const { rerender } = render(toolbar({ selection: SHAPE, geometry: ONE, onPickImage }));
    act(() => useApp.getState().askForEditPanel("link"));
    expect(screen.getByRole("dialog", { name: "Link" })).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("Link address"), { key: "Escape" });
    act(() => useApp.getState().askForEditPanel("position"));
    expect(screen.getByRole("dialog", { name: "Position and size" })).toBeTruthy();
    act(() => useApp.getState().askForEditPanel("background"));
    expect(screen.getByRole("dialog", { name: "Slide background" })).toBeTruthy();
    rerender(toolbar({ selection: selection({ kind: "media", image: true }), geometry: ONE, onPickImage }));
    act(() => useApp.getState().askForEditPanel("replace-image"));
    expect(onPickImage).toHaveBeenCalledWith(true);
    // With nothing to link, the ask for a link goes unanswered.
    rerender(toolbar());
    act(() => useApp.getState().askForEditPanel("link"));
    expect(screen.queryByRole("dialog", { name: "Link" })).toBeNull();
  });

  it("lists the slides to link to by their titles, and opens an existing web link", () => {
    render(toolbar({ selection: selection({ kind: "text", text: true, link: "https://example.com" }) }));
    fireEvent.click(button("Link"));
    const slides = screen.getByRole("combobox", { name: "Link to slide" }) as HTMLSelectElement;
    expect([...slides.options].map((o) => o.text)).toContain("Slide 1 · Intro");
    expect(screen.getByRole("link", { name: "Open link" }).getAttribute("href")).toBe("https://example.com");
  });
});
