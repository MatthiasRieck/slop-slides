import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import type { Annotations } from "./PresenterTools";
import { ViewToolbar } from "./ViewToolbar";

const SECTIONS = ["Mark up", "Review", "Animations", "Timeline", "Find"];
const SECTION_WIDTH = 200;

let resize: ResizeObserverCallback | null = null;
let ribbonWidth = 0;
const NoLayout = globalThis.ResizeObserver;

const annotations = (overrides: Partial<Annotations> = {}) =>
  ({
    tool: "pointer",
    setTool: vi.fn(),
    colors: { pen: "#ef4444", highlighter: "#facc15" },
    setColor: vi.fn(),
    strokes: [],
    undo: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  }) as unknown as Annotations;

function toolbar(overrides: Partial<Parameters<typeof ViewToolbar>[0]> = {}) {
  return (
    <ViewToolbar
      annotations={annotations()}
      commenting={false}
      onCommenting={() => {}}
      drawingArea={false}
      onDrawingArea={() => {}}
      areaShape="rect"
      onAreaShape={() => {}}
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
const inGroup = (group: string, tool: string | RegExp) =>
  within(screen.getByRole("group", { name: group })).getByRole("button", { name: tool }) as HTMLButtonElement;

describe("ViewToolbar ribbon", () => {
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
    useApp.setState({
      deck: deckFor(DECK_HTML),
      selected: "intro",
      sketches: {},
      comments: {},
      reviewVisible: true,
      finalState: false,
    });
  });

  afterEach(() => {
    globalThis.ResizeObserver = NoLayout;
    vi.restoreAllMocks();
  });

  it("groups its tools in captioned sections, like the edit ribbon", () => {
    render(toolbar());
    for (const name of SECTIONS) within(screen.getByRole("group", { name })).getByText(name);
    expect(inGroup("Mark up", "Draw on the slide")).toBeTruthy();
    expect(inGroup("Mark up", "Color #3b82f6")).toBeTruthy();
    expect(inGroup("Review", "Comment on an area (rectangle)")).toBeTruthy();
    expect(inGroup("Animations", /final state/)).toBeTruthy();
    expect(inGroup("Find", "Replace")).toBeTruthy();
  });

  it("shows or folds the timeline away, leaving playing the deck to the timeline's own bar", () => {
    useApp.setState({ timelineOpen: false });
    render(toolbar());
    const timeline = () => inGroup("Timeline", /the timeline under the slide$/);
    expect(timeline().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(timeline());
    expect(useApp.getState().timelineOpen).toBe(true);
    expect(timeline().getAttribute("aria-label")).toBe("Hide the timeline under the slide");
    expect(timeline().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(timeline());
    expect(useApp.getState().timelineOpen).toBe(false);
    expect(within(screen.getByRole("group", { name: "Timeline" })).getAllByRole("button")).toHaveLength(1);
  });

  it("has no timeline to show while every slide is hidden", () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck: { ...deck, slides: deck.slides.map((s) => ({ ...s, hidden: true })) } });
    render(toolbar());
    expect(inGroup("Timeline", /the timeline under the slide$/).disabled).toBe(true);
  });

  it("keeps every tool in place, off while it has nothing to work on", () => {
    const { rerender } = render(toolbar());
    for (const name of ["Undo mark", "Clear marks on this slide"]) expect(inGroup("Mark up", name).disabled).toBe(true);
    expect(inGroup("Review", "Hide review marks and comments").disabled).toBe(true);

    const mark = { tool: "pen" as const, color: "#ef4444", points: [[0.5, 0.5]] as [number, number][] };
    const undo = vi.fn();
    act(() => useApp.setState({ sketches: { intro: [mark] } }));
    rerender(toolbar({ annotations: annotations({ strokes: [mark], undo }) }));
    fireEvent.click(inGroup("Mark up", "Undo mark"));
    expect(undo).toHaveBeenCalled();
    expect(inGroup("Review", "Hide review marks and comments").disabled).toBe(false);
  });

  it("puts the other tools away when a color picks up the pen", () => {
    const setColor = vi.fn();
    const onCommenting = vi.fn();
    const onDrawingArea = vi.fn();
    render(toolbar({ annotations: annotations({ setColor }), commenting: true, onCommenting, onDrawingArea }));
    fireEvent.click(inGroup("Mark up", "Color #22c55e"));
    expect(setColor).toHaveBeenCalledWith("#22c55e");
    expect(onCommenting).toHaveBeenCalledWith(false);
    expect(onDrawingArea).toHaveBeenCalledWith(false);
  });

  it("collapses sections to an icon from the right as it narrows, and opens them again as it widens", () => {
    render(toolbar());
    for (const name of SECTIONS) expect(collapsedButton(name)).toBeNull();
    widen(3 * SECTION_WIDTH);
    expect(collapsedButton("Find")).toBeTruthy();
    expect(collapsedButton("Animations")).toBeTruthy();
    expect(collapsedButton("Review")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Search slides" })).toBeNull();

    widen(5000);
    for (const name of SECTIONS) expect(collapsedButton(name)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Search slides" })).toBeTruthy();
  });

  it("closes a section's flyout when its tool is picked, to get out of the way of the slide", () => {
    const { rerender } = render(toolbar());
    widen(100);
    fireEvent.click(collapsedButton("Mark up")!);
    expect(collapsedButton("Mark up")!.getAttribute("aria-expanded")).toBe("true");
    rerender(toolbar({ annotations: annotations({ tool: "pen" }) }));
    expect(collapsedButton("Mark up")!.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(collapsedButton("Animations")!);
    fireEvent.click(screen.getByRole("button", { name: /^Show the slide's final state/ }));
    expect(collapsedButton("Animations")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a collapsed Find section for ⌘F, in the app or in the slide, and focuses the search", () => {
    render(toolbar());
    widen(100);
    expect(collapsedButton("Find")!.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(collapsedButton("Find")!.getAttribute("aria-expanded")).toBe("true");
    const field = screen.getByRole("textbox", { name: "Search slides" });
    expect(document.activeElement).toBe(field);

    fireEvent.pointerDown(document.body);
    expect(collapsedButton("Find")!.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "slop:key", key: "f", mod: true } }));
    });
    expect(collapsedButton("Find")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves the Replace panel where it places itself, against the window", async () => {
    render(<div>{toolbar()}</div>);
    const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 0 }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.matches("[role=dialog]") ? rect(400, 760) : rect(0, 500);
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await act(async () => {});
    expect(screen.getByRole("dialog", { name: "Replace" }).style.marginLeft).toBe("");
  });

  it("leaves the search field alone for ⌘F while its section is open in the ribbon", () => {
    render(toolbar());
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(collapsedButton("Find")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search slides" }));
  });
});
