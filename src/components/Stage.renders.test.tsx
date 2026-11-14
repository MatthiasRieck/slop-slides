import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What tells how often the stage and its toolbars render: each calls its hook once per render.
vi.mock("./stage/useSlideKeyboard", async (original) => {
  const actual = await original<typeof import("./stage/useSlideKeyboard")>();
  return { ...actual, useSlideKeyboard: vi.fn(actual.useSlideKeyboard) };
});
vi.mock("./Ribbon", async (original) => {
  const actual = await original<typeof import("./Ribbon")>();
  return { ...actual, useRibbonFit: vi.fn(actual.useRibbonFit) };
});
// The row under the slide renders its deck check, and the notes under the slide their planned time, each time they render.
vi.mock("./LintStatus", async (original) => {
  const actual = await original<typeof import("./LintStatus")>();
  return { ...actual, LintStatus: vi.fn(actual.LintStatus) };
});
vi.mock("./SlideTime", async (original) => {
  const actual = await original<typeof import("./SlideTime")>();
  return { ...actual, SlideTime: vi.fn(actual.SlideTime) };
});

import { parseSelection } from "../lib/editTools";
import { flushReviewSave, useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { countRenders } from "../test/renderCounts";
import { LintStatus } from "./LintStatus";
import { useRibbonFit } from "./Ribbon";
import { SlideTime } from "./SlideTime";
import { Stage } from "./Stage";
import { useEditorState } from "./stage/editorState";
import { useStageView } from "./stage/stageView";
import { useSlideKeyboard } from "./stage/useSlideKeyboard";

/** How often the stage has rendered so far, its toolbar (Edit's or View's), the row under the slide and the notes. */
const renders = () => ({
  stage: vi.mocked(useSlideKeyboard).mock.calls.length,
  toolbar: vi.mocked(useRibbonFit).mock.calls.length,
  footer: vi.mocked(LintStatus).mock.calls.length,
  notes: vi.mocked(SlideTime).mock.calls.length,
});

/** The observers of the laid-out stage, each reporting the size a test hands it. */
let observers: { target: Element; report: (width: number, height: number) => void }[] = [];
const NoLayout = globalThis.ResizeObserver;
/** The frames asked for and not yet run. */
let frames: FrameRequestCallback[] = [];
const nextFrame = () =>
  act(() => {
    const due = frames;
    frames = [];
    for (const run of due) run(0);
  });

const stageFrame = (container: HTMLElement) => [...container.querySelectorAll("iframe")].at(-1)!;
const fromFrame = (frame: HTMLIFrameElement, data: unknown) =>
  act(() => void window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow })));

beforeEach(() => {
  observers = [];
  frames = [];
  // Lays everything out at 960 × 540, so the slide preview loads.
  globalThis.ResizeObserver = class {
    constructor(private callback: ResizeObserverCallback) {}
    report(target: Element, width: number, height: number) {
      this.callback(
        [{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    observe(target: Element) {
      observers.push({ target, report: (width, height) => this.report(target, width, height) });
      this.report(target, 960, 540);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((run) => frames.push(run));
  useApp.setState({
    deck: deckFor(DECK_HTML),
    selected: "intro",
    presenting: false,
    sketches: {},
    comments: {},
    reviewVisible: true,
    finalState: false,
    editing: false,
    slideMode: "view",
    running: false,
    lint: [],
    notesOpen: true,
  });
});

afterEach(async () => {
  globalThis.ResizeObserver = NoLayout;
  vi.restoreAllMocks();
  await flushReviewSave();
});

/** The stage in Edit mode with the editor loaded, one element selected at (`x`, `y`). */
function editing() {
  const utils = render(<Stage />);
  act(() => useApp.getState().setMode("edit"));
  const frame = stageFrame(utils.container);
  fireEvent.load(frame);
  fromFrame(frame, { type: "slop:edit-selection", slide: "intro", selection: { kind: "shape" } });
  fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry: geometry(10, 20) });
  return { ...utils, frame };
}

const geometry = (x: number, y: number) => ({ count: 1, x, y, w: 300, h: 200, rotation: 0 });
const field = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;

describe("what renders on the stage", () => {
  it("follows a drag in the position fields alone: neither the toolbar nor the stage renders", () => {
    const { frame } = editing();
    fireEvent.click(screen.getByRole("button", { name: "Position and size" }));
    expect(field("Distance from the slide's left edge")).toBe("10");
    const before = renders();
    // The editor reports where the selection is once per frame of the drag.
    for (let step = 1; step <= 10; step++) {
      fromFrame(frame, {
        type: "slop:edit-geometry",
        slide: "intro",
        geometry: geometry(10 + step * 7, 20 + step * 3),
      });
    }
    expect(field("Distance from the slide's left edge")).toBe("80");
    expect(field("Distance from the slide's top edge")).toBe("50");
    expect(renders()).toEqual(before);
  });

  it("renders nothing at all for a report that says what the last one said", () => {
    const { frame } = editing();
    fireEvent.click(screen.getByRole("button", { name: "Position and size" }));
    const before = renders();
    const notified = vi.fn();
    const stop = useEditorState.subscribe(notified);
    for (let i = 0; i < 10; i++) {
      fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry: geometry(10, 20) });
      fromFrame(frame, { type: "slop:edit-selection", slide: "intro", selection: { kind: "shape" } });
      fromFrame(frame, { type: "slop:edit-layers", slide: "intro", layers: [] });
      fromFrame(frame, { type: "slop:edit-overflow", slide: "intro", items: [] });
      fromFrame(frame, { type: "slop:edit-fonts", slide: "intro", fonts: [] });
      fromFrame(frame, { type: "slop:edit-colors", slide: "intro", colors: [] });
    }
    stop();
    expect(notified).not.toHaveBeenCalled();
    expect(renders()).toEqual(before);
  });

  it("renders the toolbar's sections for a new selection, and not the stage", () => {
    const { frame } = editing();
    const before = renders();
    fromFrame(frame, {
      type: "slop:edit-selection",
      slide: "intro",
      selection: { kind: "text", text: true, bold: true },
    });
    expect(screen.getByRole("button", { name: /^Bold/ }).getAttribute("aria-pressed")).toBe("true");
    expect(useEditorState.getState().report.selection).toEqual(
      parseSelection({ kind: "text", text: true, bold: true }),
    );
    // The sections showing the selection rendered; the ribbon around them and the stage did not.
    expect(renders()).toEqual(before);
  });

  it("shows what runs past the slide under it without rendering the stage", () => {
    const { frame } = editing();
    const before = renders();
    fromFrame(frame, { type: "slop:edit-overflow", slide: "intro", items: ["<h1> Hello"] });
    expect(screen.getByText("Overflow")).toBeTruthy();
    expect(renders()).toEqual(before);
  });

  it("opens the editor's menu without rendering the stage", () => {
    const { frame } = editing();
    const before = renders();
    fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 40, y: 50, element: null, elements: [] });
    expect(screen.getByRole("menu", { name: "Slide" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Select all/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(renders()).toEqual(before);
  });

  it("takes a pan or a zoom up once per frame, in the ink's box and the zoom level alone", () => {
    const { frame } = editing();
    const ink = () => screen.getByTestId("annotation-view").style;
    const before = renders();
    // The row under the slide and the notes are there, and are counted.
    expect(before.footer).toBeGreaterThan(0);
    expect(before.notes).toBeGreaterThan(0);
    // The pasteboard reports its view with every move of the wheel.
    for (let step = 1; step <= 20; step++) {
      fromFrame(frame, { type: "slop:view", slide: "intro", x: step * 2, y: -step, k: 1 + step / 8 });
    }
    // The first shows at once; the rest wait for the frame, which takes only the last.
    expect([ink().left, ink().width]).toEqual(["1px", "112.5%"]);
    nextFrame();
    expect([ink().left, ink().top, ink().width, ink().height]).toEqual(["20px", "-10px", "350%", "350%"]);
    expect(screen.getByRole("button", { name: /^Zoom: / }).textContent).toBe("175%");
    expect(renders()).toEqual(before);
  });

  it("does not render the ink for a pan, which only moves its box", () => {
    const { container } = render(<Stage />);
    const frame = stageFrame(container);
    fireEvent.load(frame);
    fireEvent.click(screen.getByRole("button", { name: "Draw on the slide" }));
    const layer = screen.getByTestId("annotation-layer");
    const svg = layer.querySelector("svg")!;
    const watch = new MutationObserver(() => {});
    watch.observe(layer, { childList: true, subtree: true, attributes: true });
    const before = renders();
    fromFrame(frame, { type: "slop:view", slide: "intro", x: 30, y: 40, k: 1 });
    nextFrame();
    fromFrame(frame, { type: "slop:view", slide: "intro", x: 60, y: 80, k: 1 });
    nextFrame();
    expect(screen.getByTestId("annotation-view").style.left).toBe("30px");
    expect(watch.takeRecords()).toEqual([]);
    watch.disconnect();
    expect(layer.querySelector("svg")).toBe(svg);
    expect(renders()).toEqual(before);
  });

  it("fits the slide to a resized area without rendering anything: the browser follows it in CSS", () => {
    const { container } = editing();
    const area = observers.find((observer) => observer.target === screen.getByTestId("stage-area"))!;
    const slideBox = container.querySelector<HTMLElement>("[data-sketch-target]")!;
    // As large as fits the area (a size container), in the slide's shape.
    expect(slideBox.style.width).toBe("min(100cqw, 1.7777777777777777*100cqh)");
    expect(screen.getByTestId("stage-area").style.containerType).toBe("size");
    expect(useStageView.getState().fitScale).toBe(0.5);
    const before = renders();
    const counts = countRenders();
    // A panel's separator dragged: the area narrows tick by tick.
    for (const width of [940, 920, 900, 900, 900.2]) act(() => area.report(width, 540));
    counts.stop();
    // What reads the size the slide fits at follows it.
    expect(useStageView.getState().fitScale).toBeCloseTo(900.2 / 1920);
    expect(renders()).toEqual(before);
    for (const name of ["StageArea", "CurrentSlide", "SlideFrame", "InkBox", "AnnotationLayer", "StageInk"]) {
      expect(counts.of(name), name).toBe(0);
    }
  });

  it("moves the ink with a panned slide as the area resizes, and only then", () => {
    const { frame } = editing();
    const area = observers.find((observer) => observer.target === screen.getByTestId("stage-area"))!;
    const ink = () => screen.getByTestId("annotation-view").style;
    fromFrame(frame, { type: "slop:view", slide: "intro", x: 100, y: 40, k: 2 });
    nextFrame();
    // 100 × 40 slide pixels at the 0.5 the slide fits at.
    expect([ink().left, ink().top, ink().width]).toEqual(["50px", "20px", "200%"]);
    const counts = countRenders();
    act(() => area.report(480, 540));
    counts.stop();
    expect([ink().left, ink().top, ink().width]).toEqual(["25px", "10px", "200%"]);
    expect(counts.of("InkBox")).toBe(1);
    expect(counts.of("StageArea")).toBe(0);
  });

  it("looks through the page for the preview at most once for a message, and not for the next from the same one", () => {
    const { frame } = editing();
    const inArea = vi.spyOn(screen.getByTestId("stage-area"), "querySelectorAll");
    const inPage = vi.spyOn(document, "querySelectorAll");
    for (let step = 1; step <= 60; step++) {
      fromFrame(frame, { type: "slop:edit-geometry", slide: "intro", geometry: geometry(step, step) });
      fromFrame(frame, { type: "slop:view", slide: "intro", x: step, y: step, k: 1 });
    }
    // The editor loaded and reported before: the stage knows the preview these come from.
    expect(inArea).not.toHaveBeenCalled();
    expect(inPage).not.toHaveBeenCalled();
  });

  it("does not put the tools away again with every render in Edit mode", () => {
    const setReviewVisible = vi.fn(useApp.getState().setReviewVisible);
    useApp.setState({ setReviewVisible });
    render(<Stage />);
    act(() => useApp.getState().setMode("edit"));
    const before = renders().stage;
    const updates = vi.fn();
    const stop = useApp.subscribe(updates);
    // The stage renders for other reasons, a tool picked say.
    act(() => useApp.setState({ editTool: "rect" }));
    act(() => useApp.setState({ editTool: "select" }));
    stop();
    expect(renders().stage).toBeGreaterThan(before);
    // Nothing followed from those renders: no tool put away again, no state set.
    expect(updates).toHaveBeenCalledTimes(2);
    expect(renders().stage - before).toBe(2);
  });
});
