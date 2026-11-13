import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { useFindShortcut } from "./FindReplace";
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

/** The ribbon with the stage's ⌘F around it, which is what brings its search up. */
function WithFindKey(props: { children: React.ReactNode }) {
  useFindShortcut();
  return props.children;
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
    // The Timeline section's toggle is called "Timeline" too, under its caption.
    for (const name of SECTIONS) within(screen.getByRole("group", { name })).getAllByText(name);
    expect(inGroup("Mark up", "Draw on the slide")).toBeTruthy();
    expect(inGroup("Mark up", "Color #3b82f6")).toBeTruthy();
    expect(inGroup("Review", "Comment on an area (rectangle)")).toBeTruthy();
    expect(inGroup("Animations", /final state/)).toBeTruthy();
    expect(inGroup("Find", "Replace…")).toBeTruthy();
    expect(inGroup("Review", "Comments (0)")).toBeTruthy();
  });

  it("names the review toggle by what it shows, pressed while it does", () => {
    const mark = { tool: "pen" as const, color: "#ef4444", points: [[0.5, 0.5]] as [number, number][] };
    useApp.setState({ sketches: { intro: [mark] }, reviewVisible: true });
    render(toolbar());
    const toggle = () => inGroup("Review", "Show review marks and comments on the slides");
    expect(toggle().textContent).toBe("Review marks");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle());
    expect(useApp.getState().reviewVisible).toBe(false);
    expect(toggle().textContent).toBe("Review marks");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    act(() => useApp.setState({ sketches: {}, reviewVisible: true }));
  });

  it("has one two-way choice for the animations, and plays them again on Replay", () => {
    useApp.setState({ finalState: false, replayRev: 0 });
    render(toolbar());
    const choice = within(screen.getByRole("group", { name: "When a slide is shown" }));
    const [play, final] = choice.getAllByRole("button") as [HTMLElement, HTMLElement];
    expect([play.textContent, final.textContent]).toEqual(["Play", "Final"]);
    expect([play.getAttribute("aria-pressed"), final.getAttribute("aria-pressed")]).toEqual(["true", "false"]);
    fireEvent.click(final);
    expect(useApp.getState().finalState).toBe(true);
    expect(final.getAttribute("aria-pressed")).toBe("true");
    // Replaying plays them, so it leaves the final state too.
    fireEvent.click(inGroup("Animations", "Play this slide's animations again, from their start"));
    expect(useApp.getState()).toMatchObject({ finalState: false, replayRev: 1 });
  });

  it("lists the deck's comments by slide, goes to one pressed, and hands them all to the agent", () => {
    const comment = (id: string, text: string) => ({ id, text, x: 0.5, y: 0.5 });
    useApp.setState({
      deck: deckFor(DECK_HTML),
      selected: "intro",
      comments: {
        intro: [comment("a", "Bigger title")],
        outro: [comment("b", "Thank them"), comment("c", "Add a link")],
      },
      commentsHeld: { b: "Thank them" },
      commentScope: "slide",
      commentAsked: null,
      sidebarTab: "files",
    });
    render(toolbar());
    fireEvent.click(inGroup("Review", "Comments (3)"));
    const list = within(screen.getByRole("dialog", { name: "Comments" }));
    expect(list.getByText("3 comments on 2 slides")).toBeTruthy();
    expect(within(list.getByRole("group", { name: "Slide 1" })).getAllByRole("button")).toHaveLength(1);
    expect(within(list.getByRole("group", { name: "Slide 3" })).getAllByRole("button")).toHaveLength(2);
    fireEvent.click(list.getByRole("button", { name: "Add a link" }));
    expect(useApp.getState()).toMatchObject({ selected: "outro", commentAsked: { slide: "outro", id: "c" } });
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();

    fireEvent.click(inGroup("Review", "Comments (3)"));
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    expect(useApp.getState()).toMatchObject({ commentScope: "deck", commentsHeld: {}, sidebarTab: "chat" });
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
    act(() => useApp.setState({ comments: {}, commentAsked: null }));
  });

  it("says so when there is no comment yet, with nothing to send", () => {
    useApp.setState({ comments: {} });
    render(toolbar());
    fireEvent.click(inGroup("Review", "Comments (0)"));
    expect(screen.getByText("No comments yet")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement).disabled).toBe(true);
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
    for (const name of ["Remove last mark", "Clear marks on this slide"])
      expect(inGroup("Mark up", name).disabled).toBe(true);
    expect(inGroup("Review", "Show review marks and comments on the slides").disabled).toBe(true);

    const mark = { tool: "pen" as const, color: "#ef4444", points: [[0.5, 0.5]] as [number, number][] };
    const undo = vi.fn();
    act(() => useApp.setState({ sketches: { intro: [mark] } }));
    rerender(toolbar({ annotations: annotations({ strokes: [mark], undo }) }));
    fireEvent.click(inGroup("Mark up", "Remove last mark"));
    expect(undo).toHaveBeenCalled();
    expect(inGroup("Review", "Show review marks and comments on the slides").disabled).toBe(false);
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
    render(<WithFindKey>{toolbar()}</WithFindKey>);
    widen(100);
    expect(collapsedButton("Find")!.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
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
    // Replacing is Edit mode's; the ribbon is View's, where the deck may be both for a moment.
    useApp.setState({ editing: true });
    render(<div>{toolbar()}</div>);
    const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 0 }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.matches("[role=dialog]") ? rect(400, 760) : rect(0, 500);
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }));
    await act(async () => {});
    expect(screen.getByRole("dialog", { name: "Replace" }).style.marginLeft).toBe("");
  });

  it("leaves the search field alone for ⌘F while its section is open in the ribbon", () => {
    render(<WithFindKey>{toolbar()}</WithFindKey>);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(collapsedButton("Find")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search slides" }));
  });
});
