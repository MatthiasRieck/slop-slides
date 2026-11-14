import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditGeometry } from "../lib/arrange";
import { type EditSelection, parseSelection } from "../lib/editTools";
import { SWATCHES } from "../lib/palette";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { EditToolbar } from "./EditToolbar";
import { reportFromEditor, resetEditorState } from "./stage/editorState";

const SECTIONS = ["Insert", "Text", "Paragraph", "Style", "Slide", "Arrange", "Timeline"];
const SECTION_WIDTH = 200;

let resize: ResizeObserverCallback | null = null;
let ribbonWidth = 0;
const NoLayout = globalThis.ResizeObserver;

/**
 * The toolbar, with what the slide editor last reported about the slide it is at work on: its
 * `selection` and where that is (`geometry`), which the toolbar's controls read for themselves.
 */
function toolbar({
  selection = null,
  geometry = null,
  ...overrides
}: Partial<Parameters<typeof EditToolbar>[0]> & {
  selection?: EditSelection | null;
  geometry?: EditGeometry | null;
} = {}) {
  act(() => {
    reportFromEditor("intro", "selection", selection);
    reportFromEditor("intro", "geometry", geometry);
  });
  return (
    <EditToolbar
      onSizeMode={() => {}}
      tool="select"
      styles={{ text: {}, shape: {}, line: {} } as never}
      onTool={() => {}}
      onStyle={() => {}}
      onOrder={() => {}}
      onDelete={() => {}}
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

// The slide editor is at work on the deck's first slide.
beforeEach(() => useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", editing: true }));
afterEach(() => {
  resetEditorState();
  useApp.setState({ editing: false });
});

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

  it("groups its tools in captioned sections", () => {
    render(toolbar());
    // Each section shows its caption (the timeline's toggle is named like its section).
    for (const name of SECTIONS) {
      expect(within(screen.getByRole("group", { name })).getAllByText(name).length).toBeGreaterThan(0);
    }
    const inGroup = (group: string, tool: string) =>
      within(screen.getByRole("group", { name: group })).getByRole("button", { name: tool });
    expect(inGroup("Insert", "Add an image from a file")).toBeTruthy();
    expect(inGroup("Text", "Bold")).toBeTruthy();
    expect(inGroup("Paragraph", "Bulleted list")).toBeTruthy();
    expect(inGroup("Style", "Fill")).toBeTruthy();
    // The slide's background is the slide's, not the selection's.
    expect(inGroup("Slide", "Slide background")).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: "Style" })).queryByRole("button", { name: "Slide background" }),
    ).toBeNull();
    expect(inGroup("Arrange", "Delete")).toBeTruthy();
    // Aligning and distributing are at hand; the numbers are in one popover.
    expect(inGroup("Arrange", "Align with the slide's left edges")).toBeTruthy();
    expect(inGroup("Arrange", "Distribute horizontally")).toBeTruthy();
    expect(inGroup("Arrange", "Position and size")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Size mode" })).toBeNull();
    // The timeline's tools are the same as in the view ribbon.
    expect(inGroup("Timeline", "Show the timeline under the slide")).toBeTruthy();
  });

  it("measures its sections once, and fits them to each new width from that", () => {
    render(toolbar());
    const widths = vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!.get!);
    const measured = widths.mock.calls.length;
    expect(measured).toBe(SECTIONS.length);
    // A panel's separator dragged: the ribbon is a little narrower with every tick, and nothing in it changes.
    for (const width of [5000, 4990, 4980, 4970, 4970]) widen(width);
    expect(widths.mock.calls.length).toBe(measured);
    for (const name of SECTIONS) expect(collapsedButton(name)).toBeNull();
  });

  it("measures its sections again once what is in them changed, when it next resizes", async () => {
    render(toolbar());
    widen(4 * SECTION_WIDTH);
    expect(collapsedButton("Arrange")).toBeTruthy();
    // The sections that collapsed got their buttons: the ribbon's content changed.
    await act(async () => {});
    const widths = vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!.get!);
    const measured = widths.mock.calls.length;
    widen(4 * SECTION_WIDTH - 10);
    expect(widths.mock.calls.length).toBe(measured + SECTIONS.length);
    widen(4 * SECTION_WIDTH - 20);
    expect(widths.mock.calls.length).toBe(measured + SECTIONS.length);
  });

  it("puts what pops up back in the bar reading the layout once for all of it, not once for each", () => {
    const { container } = render(<div>{toolbar()}</div>);
    widen(100);
    const flyouts = container.querySelectorAll<HTMLElement>("[data-flyout]");
    expect(flyouts.length).toBe(SECTIONS.length);
    // Reads and writes in the order they happen: every flyout is read before any is moved.
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
    for (const name of SECTIONS) expect(collapsedButton(name)).toBeNull();
    widen(5000);
    for (const name of SECTIONS) expect(collapsedButton(name)).toBeNull();
  });

  it("collapses sections to an icon from the right as it narrows, and opens them again as it widens", () => {
    render(toolbar());
    widen(4 * SECTION_WIDTH);
    expect(collapsedButton("Arrange")).toBeTruthy();
    expect(collapsedButton("Style")).toBeTruthy();
    expect(collapsedButton("Paragraph")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    widen(100);
    for (const name of SECTIONS) expect(collapsedButton(name)).toBeTruthy();

    widen(5000);
    for (const name of SECTIONS) expect(collapsedButton(name)).toBeNull();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("opens a collapsed section's tools from its icon, working as they do in the ribbon", () => {
    const onOrder = vi.fn();
    render(toolbar({ onOrder, selection: { kind: "element" } as never }));
    widen(100);
    expect(screen.queryByRole("button", { name: "Bring to front" })).toBeNull();

    fireEvent.click(collapsedButton("Arrange")!);
    expect(collapsedButton("Arrange")!.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Bring to front" }));
    expect(onOrder).toHaveBeenCalledWith("front");
    expect(screen.getByRole("button", { name: "Bring to front" })).toBeTruthy();

    fireEvent.click(collapsedButton("Arrange")!);
    expect(screen.queryByRole("button", { name: "Bring to front" })).toBeNull();
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

/** A selection as the editor reports it, with `look` set. */
const selection = (look: Partial<EditSelection> & { kind: string }) => parseSelection(look) as EditSelection;
const SHAPE = selection({ kind: "shape", text: true });
const ONE = { count: 1, x: 0, y: 0, w: 100, h: 50, rotation: 0 };
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("EditToolbar controls", () => {
  afterEach(() => {
    act(() => useApp.setState({ recentColors: [], editPanelAsk: null, editSnap: true }));
    localStorage.clear();
  });

  it("says in a disabled control's tooltip what it waits for", () => {
    render(toolbar());
    const reasons: Record<string, string> = {
      Bold: "Select text or a text box",
      "Smaller text": "Select text or a text box",
      "Align text left": "Select text or a text box",
      "Clear formatting": "Select text or a text box",
      "Text color": "Select text or a text box",
      Fill: "Select an element",
      "Border color": "Select an element",
      Appearance: "Select an element",
      Link: "Select an element",
      Group: "Select two or more elements",
      Ungroup: "Select a group",
      "Image options": "Select an image",
      "Bring to front": "Select an element",
      Lock: "Select an element",
      Duplicate: "Select an element",
      Delete: "Select an element",
      "Distribute horizontally": "Select three or more elements",
      "Line ends and route": "Select a line",
    };
    for (const [name, reason] of Object.entries(reasons)) {
      expect(button(name).disabled, name).toBe(true);
      expect(button(name).title, name).toBe(reason);
      // The pointer still reaches it, or the tooltip would never show.
      expect(button(name).className, name).not.toContain("pointer-events-none");
    }
    for (const name of ["Font", "Border width", "Border style", "When text does not fit"]) {
      const list = screen.getByRole("combobox", { name }) as HTMLSelectElement;
      expect(list.disabled, name).toBe(true);
      expect(list.title, name).toMatch(/^Select /);
    }
  });

  it("names the keys in the tooltips, not in the accessible names", () => {
    render(toolbar({ selection: SHAPE, geometry: { ...ONE, count: 2 } }));
    const keys: Record<string, string> = {
      "Select and move": "V",
      "Add text": "T",
      "Add a rectangle": "R",
      "Add an ellipse": "O",
      "Draw freehand": "D",
      "Add a line": "L",
      "Add an arrow": "A",
      Bold: "Ctrl+B",
      Italic: "Ctrl+I",
      Underline: "Ctrl+U",
      "Smaller text": "Ctrl+Shift+,",
      "Larger text": "Ctrl+Shift+.",
      Link: "Ctrl+K",
      "Align text left": "Ctrl+Shift+L",
      "Center text": "Ctrl+Shift+E",
      "Align text right": "Ctrl+Shift+R",
      "Justify text": "Ctrl+Shift+J",
      "Bring to front": "Ctrl+Shift+]",
      "Bring forward": "Ctrl+]",
      "Send backward": "Ctrl+[",
      "Send to back": "Ctrl+Shift+[",
      Group: "Ctrl+G",
      Ungroup: "Ctrl+Shift+G",
      Lock: "Ctrl+Alt+L",
      Duplicate: "Ctrl+D",
      Delete: "Backspace",
    };
    for (const [name, shortcut] of Object.entries(keys)) {
      const title = button(name).title;
      // A disabled one (Ungroup, with no group) says what it waits for instead.
      if (!button(name).disabled) expect(title.endsWith(`(${shortcut})`), `${name}: ${title}`).toBe(true);
    }
    expect(button("Group").title).toBe("Group the selected elements, to move, size and style them as one (Ctrl+G)");
  });

  it("hands the focus back to the slide after a pick from any list", () => {
    const onReturnFocus = vi.fn();
    const onStyle = vi.fn();
    render(toolbar({ selection: SHAPE, onReturnFocus, onStyle }));
    const picks: [string, string, object][] = [
      ["Font", "Arial, Helvetica, sans-serif", { fontFamily: "Arial, Helvetica, sans-serif" }],
      ["When text does not fit", "shrink", { autofit: "shrink" }],
      ["Border width", "4", { strokeWidth: 4 }],
      ["Border style", "dashed", { dash: "dashed" }],
    ];
    for (const [name, value, style] of picks) {
      onReturnFocus.mockClear();
      fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
      expect(onStyle, name).toHaveBeenLastCalledWith(style);
      expect(onReturnFocus, name).toHaveBeenCalledTimes(1);
    }
    fireEvent.click(button("Spacing"));
    onReturnFocus.mockClear();
    fireEvent.change(screen.getByLabelText("Line height"), { target: { value: "1.5" } });
    fireEvent.change(screen.getByLabelText("Letter spacing"), { target: { value: "2" } });
    expect(onReturnFocus).toHaveBeenCalledTimes(2);
  });

  it("names how text fits in plain words", () => {
    render(toolbar({ selection: SHAPE }));
    const fit = screen.getByRole("combobox", { name: "When text does not fit" }) as HTMLSelectElement;
    expect([...fit.options].map((o) => o.text)).toEqual(["Don't autofit", "Shrink text to fit", "Grow box to fit"]);
  });

  it("offers a line no zero width, and a box no border", () => {
    const { rerender } = render(toolbar({ selection: SHAPE }));
    const widths = (name: string) =>
      [...(screen.getByRole("combobox", { name }) as HTMLSelectElement).options].map((o) => o.text);
    expect(widths("Border width")[0]).toBe("No border");
    rerender(toolbar({ selection: selection({ kind: "drawing", vector: true, strokeWidth: 6 }) }));
    expect(widths("Line width")).toEqual(["1px", "2px", "4px", "6px", "8px", "12px", "16px"]);
  });

  it("justifies text and clears its formatting", () => {
    const onStyle = vi.fn();
    const onArrange = vi.fn();
    render(toolbar({ selection: selection({ kind: "text", text: true, align: "justify" }), onStyle, onArrange }));
    expect(button("Justify text").getAttribute("aria-pressed")).toBe("true");
    expect(button("Align text left").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button("Align text left"));
    expect(onStyle).toHaveBeenLastCalledWith({ align: "left" });
    fireEvent.click(button("Clear formatting"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-clear-formatting" });
  });

  it("groups the diagram shapes under headings, behind a shapes icon", () => {
    const onTool = vi.fn();
    render(toolbar({ onTool }));
    fireEvent.click(button("More shapes"));
    const picker = within(screen.getByRole("dialog", { name: "More shapes" }));
    for (const heading of ["Flowchart", "Arrows", "Shapes", "Brackets", "Connectors"]) {
      expect(picker.getByRole("group", { name: heading })).toBeTruthy();
    }
    fireEvent.click(
      within(picker.getByRole("group", { name: "Brackets" })).getByRole("button", { name: "Add a brace" }),
    );
    expect(onTool).toHaveBeenCalledWith("brace");
    expect(screen.queryByRole("dialog", { name: "More shapes" })).toBeNull();
  });

  it("starts a request to the agent for a table, a chart or an icon", () => {
    const onInsertAsk = vi.fn();
    render(toolbar({ onInsertAsk }));
    for (const [name, kind] of [
      ["Table…", "table"],
      ["Chart…", "chart"],
      ["Icon…", "icon"],
    ] as const) {
      expect(button(name).title).toContain("Ask the agent");
      fireEvent.click(button(name));
      expect(onInsertAsk).toHaveBeenLastCalledWith(kind);
    }
  });

  it("duplicates the selection and turns snapping on and off", () => {
    const onArrange = vi.fn();
    render(toolbar({ selection: SHAPE, geometry: ONE, onArrange }));
    fireEvent.click(button("Duplicate"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-duplicate" });
    const snap = button("Snap to guides");
    expect(snap.getAttribute("aria-pressed")).toBe("true");
    // The override is said where the toggle is.
    expect(snap.title).toContain("hold Ctrl while dragging to move freely");
    fireEvent.click(snap);
    expect(useApp.getState().editSnap).toBe(false);
    expect(snap.getAttribute("aria-pressed")).toBe("false");
    expect(snap.title).toContain("hold Ctrl while dragging to snap");
    expect(localStorage.getItem("slopslides.editSnap")).toBe("false");
  });

  it("flips several elements, and one that can flip, from Position and size", () => {
    const onArrange = vi.fn();
    const { rerender } = render(toolbar({ selection: SHAPE, geometry: ONE, onArrange }));
    fireEvent.click(button("Position and size"));
    expect(button("Flip horizontally").disabled).toBe(true);
    rerender(toolbar({ selection: SHAPE, geometry: { ...ONE, count: 3, rotation: null }, onArrange }));
    fireEvent.click(button("Flip vertically"));
    expect(onArrange).toHaveBeenLastCalledWith({ type: "slop:edit-flip", axis: "y" });
    expect(screen.getByText(/3 elements selected/)).toBeTruthy();
  });

  describe("color wells", () => {
    it("names the swatches, and tells no color from one that is mixed or not plain", () => {
      const { rerender } = render(toolbar({ selection: selection({ kind: "shape", fill: SWATCHES.blue }) }));
      expect(button("Fill").title).toBe(`Fill: Blue (${SWATCHES.blue})`);
      expect(screen.getByTestId("Fill swatch").dataset.state).toBe("color");
      fireEvent.click(button("Fill"));
      const well = within(screen.getByRole("dialog", { name: "Fill" }));
      expect(well.getByRole("button", { name: `Blue (${SWATCHES.blue})` }).getAttribute("aria-pressed")).toBe("true");
      expect(well.getByRole("button", { name: `Red (${SWATCHES.red})` }).title).toBe(`Red (${SWATCHES.red})`);
      expect(well.queryByText(/Mixed/)).toBeNull();

      rerender(toolbar({ selection: selection({ kind: "shape" }) }));
      expect(button("Fill").title).toBe("Fill: none");
      expect(screen.getByTestId("Fill swatch").dataset.state).toBe("none");
      expect(well.getByRole("button", { name: "None" }).getAttribute("aria-pressed")).toBe("true");

      rerender(toolbar({ selection: selection({ kind: "shape", fillOther: true }) }));
      expect(button("Fill").title).toBe("Fill: mixed, or not a plain color");
      expect(screen.getByTestId("Fill swatch").dataset.state).toBe("other");
      expect(well.getByRole("button", { name: "None" }).getAttribute("aria-pressed")).toBe("false");
      expect(well.getByText(/Mixed, or not a plain color/)).toBeTruthy();
    });

    it("takes a typed hex value on Enter, and marks one that is none", () => {
      const onStyle = vi.fn();
      const onReturnFocus = vi.fn();
      render(toolbar({ selection: SHAPE, onStyle, onReturnFocus }));
      fireEvent.click(button("Fill"));
      const hex = screen.getByLabelText("Fill as a hex value") as HTMLInputElement;
      fireEvent.change(hex, { target: { value: "nope" } });
      fireEvent.keyDown(hex, { key: "Enter" });
      expect(onStyle).not.toHaveBeenCalled();
      expect(hex.getAttribute("aria-invalid")).toBe("true");
      fireEvent.change(hex, { target: { value: "1A2b3c" } });
      expect(hex.getAttribute("aria-invalid")).toBeNull();
      fireEvent.keyDown(hex, { key: "Enter" });
      expect(onStyle).toHaveBeenCalledWith({ fill: "#1a2b3c" });
      expect(onReturnFocus).toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Fill" })).toBeNull();
    });

    it("offers the colors picked last, in every well", () => {
      const onStyle = vi.fn();
      render(toolbar({ selection: SHAPE, onStyle }));
      fireEvent.click(button("Fill"));
      expect(screen.queryByRole("group", { name: "Recent" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: `Red (${SWATCHES.red})` }));
      fireEvent.click(button("Fill"));
      fireEvent.change(screen.getByLabelText("Fill as a hex value"), { target: { value: "#123456" } });
      fireEvent.keyDown(screen.getByLabelText("Fill as a hex value"), { key: "Enter" });
      expect(useApp.getState().recentColors).toEqual(["#123456", SWATCHES.red]);
      // Another well has them too; no color is not one of them.
      fireEvent.click(button("Border color"));
      const recent = within(screen.getByRole("group", { name: "Recent" }));
      expect(recent.getAllByRole("button").map((b) => b.title)).toEqual(["#123456", `Red (${SWATCHES.red})`]);
      fireEvent.click(recent.getByRole("button", { name: "Recent color #123456" }));
      expect(onStyle).toHaveBeenLastCalledWith({ stroke: "#123456" });
      fireEvent.click(button("Border color"));
      fireEvent.click(screen.getByRole("button", { name: "None" }));
      expect(useApp.getState().recentColors).toEqual(["#123456", SWATCHES.red]);
    });
  });

  it("opens the Link popover and the slide's background when they are asked for from outside", () => {
    const { rerender } = render(toolbar({ selection: SHAPE }));
    act(() => useApp.getState().askForEditPanel("link"));
    expect(screen.getByRole("dialog", { name: "Link" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Slide background" })).toBeNull();
    fireEvent.keyDown(screen.getByLabelText("Link address"), { key: "Escape" });
    act(() => useApp.getState().askForEditPanel("background"));
    expect(screen.getByRole("dialog", { name: "Slide background" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Link" })).toBeNull();
    // With nothing to link, the ask for a link goes unanswered.
    rerender(toolbar());
    act(() => useApp.getState().askForEditPanel("link"));
    expect(screen.queryByRole("dialog", { name: "Link" })).toBeNull();
  });
});
