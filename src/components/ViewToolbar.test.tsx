import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import type { Annotations } from "./PresenterTools";
import { ViewToolbar } from "./ViewToolbar";

const SECTIONS = ["Mark up", "Review", "Animations", "Slide", "Timeline"];
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
    // The Timeline section's toggle is called "Timeline" too, under its caption.
    for (const name of SECTIONS) within(screen.getByRole("group", { name })).getAllByText(name);
    expect(inGroup("Mark up", "Draw on the slide")).toBeTruthy();
    expect(inGroup("Mark up", "Color #3b82f6")).toBeTruthy();
    expect(inGroup("Review", "Comment on an area (rectangle)")).toBeTruthy();
    expect(inGroup("Review", "Comments (0)")).toBeTruthy();
    // Find is the bar over the stage, the same in every mode: not a section here.
    expect(screen.queryByRole("group", { name: "Find" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("offers the requests to the agent about the slide's layout, marked as such", () => {
    useApp.setState({ running: false });
    render(toolbar());
    const change = inGroup("Slide", "Change layout…");
    const tidy = inGroup("Slide", "Tidy layout…");
    for (const button of [change, tidy]) {
      expect(button.title).toMatch(/· asks the agent$/);
      expect(button.querySelector(".text-primary")).toBeTruthy();
    }
    fireEvent.click(change);
    expect(screen.getByRole("dialog", { name: "Change layout" })).toBeTruthy();
    act(() => useApp.setState({ running: true }));
    expect(inGroup("Slide", "Tidy layout…").disabled).toBe(true);
    expect(inGroup("Slide", "Tidy layout…").title).toContain("at work");
    act(() => useApp.setState({ running: false }));
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

  it("sets how slides show with a two-way choice, and replays the animations with a command", () => {
    useApp.setState({ finalState: false, replayRev: 0 });
    render(toolbar());
    const choice = within(screen.getByRole("radiogroup", { name: "How slides show here" }));
    const animated = choice.getByRole("radio", { name: "Animated" }) as HTMLInputElement;
    const final = choice.getByRole("radio", { name: "Final state" }) as HTMLInputElement;
    expect([animated.checked, final.checked]).toEqual([true, false]);
    fireEvent.click(final);
    expect(useApp.getState().finalState).toBe(true);
    expect(final.checked).toBe(true);
    // Replaying plays them, so it leaves the final state too.
    const replay = inGroup("Animations", "Replay this slide's animations from their start");
    expect(replay.textContent).toBe("Replay animations");
    fireEvent.click(replay);
    expect(useApp.getState()).toMatchObject({ finalState: false, replayRev: 1 });
  });

  it("lists the deck's comments by slide, goes to one pressed, and sends the ticked ones from the chat", () => {
    const comment = (id: string, text: string) => ({ id, text, x: 0.5, y: 0.5 });
    useApp.setState({
      deck: deckFor(DECK_HTML),
      selected: "intro",
      comments: {
        intro: [comment("a", "Bigger title")],
        outro: [comment("b", "Thank them"), comment("c", "Add a link")],
      },
      commentsHeld: {},
      commentScope: "slide",
      commentAsked: null,
      sidebarTab: "files",
    });
    render(toolbar());
    fireEvent.click(inGroup("Review", "Comments (3)"));
    const list = within(screen.getByRole("dialog", { name: "Comments" }));
    expect(list.getByText("3 comments on 2 slides")).toBeTruthy();
    expect(within(list.getByRole("list", { name: "Slide 3" })).getAllByRole("checkbox")).toHaveLength(2);
    // What goes out: this slide's, as the composer says.
    const box = (text: string) => list.getByRole("checkbox", { name: `Send: ${text}` }) as HTMLInputElement;
    expect([box("Bigger title").checked, box("Thank them").checked, box("Add a link").checked]).toEqual([
      true,
      false,
      false,
    ]);
    fireEvent.click(box("Add a link"));
    expect(useApp.getState().commentScope).toBe("deck");
    expect([box("Bigger title").checked, box("Thank them").checked, box("Add a link").checked]).toEqual([
      true,
      false,
      true,
    ]);
    const send = list.getByRole("button", { name: /^Send 2 to the agent/ });
    expect(send.title).toMatch(/· asks the agent$/);

    fireEvent.click(list.getByRole("button", { name: "Add a link" }));
    expect(useApp.getState()).toMatchObject({ selected: "outro", commentAsked: { slide: "outro", id: "c" } });
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();

    fireEvent.click(inGroup("Review", "Comments (3)"));
    fireEvent.click(screen.getByRole("button", { name: /^Send 2 to the agent/ }));
    expect(useApp.getState().sidebarTab).toBe("chat");
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
    act(() => useApp.setState({ comments: {}, commentAsked: null, commentScope: "slide" }));
  });

  it("deletes a comment from the list, with Undo", () => {
    const comment = { id: "a", text: "Bigger title", x: 0.5, y: 0.5 };
    useApp.setState({ comments: { intro: [comment] }, toasts: [] });
    render(toolbar());
    fireEvent.click(inGroup("Review", "Comments (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    expect(useApp.getState().comments.intro).toEqual([]);
    const toast = useApp.getState().toasts.at(-1)!;
    expect(toast.text).toBe("Comment deleted");
    act(() => toast.action!.run());
    expect(useApp.getState().comments.intro).toEqual([comment]);
    act(() => useApp.setState({ comments: {} }));
  });

  it("marks sent comments, resolves them one by one or all, and sends one again", () => {
    const sent = (id: string, text: string) => ({ id, text, x: 0.5, y: 0.5, sent: true });
    useApp.setState({
      comments: {
        intro: [sent("a", "Bigger title"), { id: "b", text: "Not yet", x: 0, y: 0 }],
        outro: [sent("c", "Done")],
      },
      toasts: [],
    });
    render(toolbar());
    fireEvent.click(inGroup("Review", "Comments (3)"));
    const list = within(screen.getByRole("dialog", { name: "Comments" }));
    expect(list.getAllByText("Sent")).toHaveLength(2);
    expect(list.getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(list.getAllByRole("button", { name: "Send again with the next message" })[0]!);
    expect(useApp.getState().comments.intro![0]).toEqual({ id: "a", text: "Bigger title", x: 0.5, y: 0.5 });
    fireEvent.click(list.getByRole("button", { name: "Resolve: take this comment off the slide" }));
    expect(useApp.getState().comments.outro).toEqual([]);
    expect(useApp.getState().toasts.at(-1)!.text).toBe("Comment resolved");
    act(() => useApp.setState({ comments: { outro: [sent("c", "Done")] } }));
    fireEvent.click(list.getByRole("button", { name: "Resolve all sent" }));
    expect(useApp.getState().comments.outro).toEqual([]);
    act(() => useApp.setState({ comments: {} }));
  });

  it("says so when there is no comment yet, with nothing to send", () => {
    useApp.setState({ comments: {} });
    render(toolbar());
    fireEvent.click(inGroup("Review", "Comments (0)"));
    expect(screen.getByText("No comments yet")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Send to the agent/ }) as HTMLButtonElement).disabled).toBe(true);
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
    // Some sections give way to icons, the first ones keep their tools.
    expect(SECTIONS.filter((name) => collapsedButton(name)).length).toBeGreaterThan(0);
    expect(collapsedButton("Mark up")).toBeNull();

    widen(5000);
    for (const name of SECTIONS) expect(collapsedButton(name)).toBeNull();
  });

  it("closes a section's flyout when its tool is picked, to get out of the way of the slide", () => {
    const { rerender } = render(toolbar());
    widen(100);
    fireEvent.click(collapsedButton("Mark up")!);
    expect(collapsedButton("Mark up")!.getAttribute("aria-expanded")).toBe("true");
    rerender(toolbar({ annotations: annotations({ tool: "pen" }) }));
    expect(collapsedButton("Mark up")!.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(collapsedButton("Animations")!);
    fireEvent.click(screen.getByRole("radio", { name: "Final state" }));
    expect(collapsedButton("Animations")!.getAttribute("aria-expanded")).toBe("false");
  });
});
