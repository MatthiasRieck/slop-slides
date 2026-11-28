import { invoke } from "@tauri-apps/api/core";
import { fireEvent, act as reactAct, render as renderPage, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Deck } from "../lib/api";
import { dropCovered } from "../lib/drop";
import { FRAME_LOAD_LIMIT } from "../lib/frameLoads";
import { flushReviewSave, GRID_MAX, useApp } from "../store";
import { lastError, toastTexts } from "../store/errors";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { Stage } from "./Stage";

/** The size the stage's area is laid out at; a test changes it with `resize`. */
let area = { width: 960, height: 540 };
/** What has every observed box measured again. */
let measure: (() => void)[] = [];
const NoLayout = globalThis.ResizeObserver;

/**
 * The size of an observed box: a slide's is as wide as the cell it is in (which the stage sizes
 * with a style), in the slide's shape; anything else is the stage's area.
 */
function sizeOf(target: Element) {
  const width = Number.parseFloat((target.parentElement as HTMLElement | null)?.style.width ?? "");
  return Number.isNaN(width) ? area : { width, height: (width * 9) / 16 };
}

/**
 * Measures every observed box again, as a browser does by itself when one changed: the area
 * first, then the slides, which are sized by what the area measured.
 */
function layOut() {
  for (const _pass of [1, 2]) {
    reactAct(() => {
      for (const run of measure) run();
    });
  }
}

/** `act`, with the layout that follows what it did. */
function act(run: () => void) {
  reactAct(run);
  layOut();
}

/** The same for what takes its time. */
async function acting(run: () => Promise<void>) {
  await reactAct(run);
  layOut();
}

/** Renders, laid out. */
function render(page: ReactElement) {
  const utils = renderPage(page);
  layOut();
  return utils;
}

/** Lays the area out anew at `width` × `height`. */
function resize(width: number, height: number) {
  area = { width, height };
  layOut();
}

beforeEach(() => {
  area = { width: 960, height: 540 };
  measure = [];
  globalThis.ResizeObserver = class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      const report = () =>
        this.callback(
          [{ target, contentRect: sizeOf(target) } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      measure.push(report);
      report();
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  useApp.setState({
    deck: deckFor(DECK_HTML),
    selected: "intro",
    railSelected: ["intro", "outro"],
    presenting: false,
    sketches: {},
    comments: {},
    reviewVisible: true,
    finalState: false,
    editing: false,
    slideMode: "view",
    running: false,
    toasts: [],
    replayRev: 0,
  });
});

afterEach(async () => {
  globalThis.ResizeObserver = NoLayout;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(invoke).mockReset();
  await flushReviewSave();
});

const cell = (container: HTMLElement, slide: string) =>
  container.querySelector<HTMLElement>(`[data-stage-cell="${slide}"]`)!;
const framesOf = (container: HTMLElement, slide: string) => [...cell(container, slide).querySelectorAll("iframe")];
/** The newest preview of `slide`: the one loading, if one is. */
const frameOf = (container: HTMLElement, slide: string) => framesOf(container, slide).at(-1)!;
const srcOf = (frame: HTMLIFrameElement) => frame.getAttribute("src") ?? "";
const fromFrame = (frame: HTMLIFrameElement, data: unknown) =>
  act(() => void window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow })));
const edit = () => act(() => useApp.getState().setMode("edit"));
/** Lets what waits on promises that are settled already go on. */
const flush = () =>
  acting(async () => {
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  });
/** The deck with `slide`'s hash changed, as a save or an undo of it answers. */
const withHash = (slide: string, hash: string): Deck => {
  const deck = useApp.getState().deck!;
  return { ...deck, slides: deck.slides.map((s) => (s.id === slide ? { ...s, hash } : s)) };
};
const withMarks = (slide: string, marks: { locked?: boolean; hidden?: boolean }): Deck => {
  const deck = useApp.getState().deck!;
  return { ...deck, slides: deck.slides.map((s) => (s.id === slide ? { ...s, ...marks } : s)) };
};
const picks = () => useApp.getState().railSelected;
const selected = () => useApp.getState().selected;

/** The stage in Edit mode with the picked slides side by side and the current one's editor loaded. */
function editing() {
  const utils = render(<Stage />);
  edit();
  const frame = frameOf(utils.container, "intro");
  fireEvent.load(frame);
  return { ...utils, frame };
}

describe("several slides on the stage", () => {
  it("shows one slide as ever when only one is picked", () => {
    useApp.setState({ railSelected: [] });
    const { container } = render(<Stage />);
    expect(container.querySelector("[data-stage-cell]")).toBeNull();
    expect(screen.queryByTestId("stage-grid")).toBeNull();
    expect(screen.queryByTestId("cell-label")).toBeNull();
    const box = container.querySelector<HTMLElement>("[data-sketch-target]")!;
    // The box around it is none in the layout: the slide is laid out as the area's own child.
    expect(box.parentElement!.className).toBe("contents");
    expect(box.parentElement!.parentElement).toBe(screen.getByTestId("stage-area"));
    expect(box.style.width).toBe("960px");
    expect(box.className).toBe("relative");
    expect(container.querySelectorAll("[data-sketch-target]")).toHaveLength(1);
    expect(screen.getAllByTestId("annotation-view")).toHaveLength(1);
    expect(box.contains(screen.getByTestId("annotation-view"))).toBe(true);
    const frame = container.querySelector("iframe")!;
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(frame.style.width).toBe("2048px");
    // Its pasteboard hears of no other slide.
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:neighbors" }), "*");
  });

  it("shows the picked slides side by side: the current one live, the others as stills", () => {
    const { container } = render(<Stage />);
    const cells = [...container.querySelectorAll<HTMLElement>("[data-stage-cell]")];
    expect(cells.map((each) => each.dataset.stageCell)).toEqual(["intro", "outro"]);
    // Each is as wide as two fit the 960 of the area with the gap between them.
    expect(cells.map((each) => [each.style.left, each.style.top, each.style.width])).toEqual([
      ["0px", "0px", "468px"],
      ["492px", "0px", "468px"],
    ]);
    // What is asked of "the slide on the stage" still finds one: the current one.
    expect(container.querySelectorAll("[data-sketch-target]")).toHaveLength(1);
    expect(cell(container, "intro").hasAttribute("data-sketch-target")).toBe(true);
    expect(screen.getAllByTestId("annotation-view")).toHaveLength(1);
    expect(cell(container, "intro").contains(screen.getByTestId("annotation-view"))).toBe(true);
    expect(cell(container, "intro").className).toContain("z-10");
    expect(cell(container, "outro").className).not.toContain("z-10");
    // Only the current one is on a pasteboard; the other is a still of its last frame.
    expect(srcOf(frameOf(container, "intro"))).toContain("&pan");
    expect(srcOf(frameOf(container, "intro"))).not.toContain("&static");
    expect(framesOf(container, "outro")).toHaveLength(1);
    expect(srcOf(frameOf(container, "outro"))).toContain("&static");
    expect(srcOf(frameOf(container, "outro"))).not.toMatch(/&pan|&edit=/);
    // Each says which slide of the deck it is.
    expect(screen.getAllByTestId("cell-label").map((label) => label.textContent)).toEqual(["1", "3"]);
  });

  it("edits only the current slide", () => {
    const { container } = render(<Stage />);
    edit();
    expect(srcOf(frameOf(container, "intro"))).toContain("&edit=");
    expect(cell(container, "intro").getAttribute("data-editing")).toBe("true");
    expect(framesOf(container, "outro").map(srcOf).join()).not.toMatch(/&pan|&edit=/);
    expect(cell(container, "outro").hasAttribute("data-editing")).toBe(false);
  });

  it("marks the locked and the hidden among them", () => {
    useApp.setState({ deck: withMarks("outro", { locked: true, hidden: true }) });
    render(<Stage />);
    const [first, second] = screen.getAllByTestId("cell-label");
    expect(first!.querySelector("svg")).toBeNull();
    expect(second!.querySelector('[aria-label="Locked slide"]')).not.toBeNull();
    expect(second!.querySelector('[aria-label="Hidden slide"]')).not.toBeNull();
  });

  it("has the current slide's pasteboard cover the whole area, over the other slides", () => {
    const { container } = render(<Stage />);
    const shownAt = (frame: HTMLIFrameElement) => {
      const scale = Number(/scale\((.+)\)/.exec(frame.style.transform)![1]);
      const px = (value: string) => Number.parseFloat(value);
      return {
        scale,
        left: px(frame.style.left),
        top: px(frame.style.top),
        width: px(frame.style.width) * scale,
        height: px(frame.style.height) * scale,
      };
    };
    // The area is 1024 × 604 with its padding. The left slide's middle is 266 from its left edge:
    // to reach the right edge, its pasteboard is the area and one slide and gap wide.
    const left = shownAt(frameOf(container, "intro"));
    expect(left.scale).toBeCloseTo(468 / 1920);
    expect(left.width).toBeCloseTo(1024 + 468 + 24);
    expect(left.height).toBeCloseTo(604);
    // Centered on its slide, which is 32 from the area's left edge, it ends at the area's right one.
    expect(left.left).toBeCloseTo((468 - 1516) / 2);
    expect(left.left + left.width).toBeCloseTo(1024 - 32);
    expect(left.top).toBeCloseTo((263.25 - 604) / 2);
    // The right slide's reaches as far the other way: to the area's left edge, 524 left of the slide.
    act(() => useApp.getState().activateSlide("outro"));
    const right = shownAt(frameOf(container, "outro"));
    expect(right.width).toBeCloseTo(1516);
    expect(right.left).toBeCloseTo(-(32 + 492));
  });

  it("tells the pasteboard where the other slides are, when it loads and whenever that changes", () => {
    const { container } = render(<Stage />);
    const frame = frameOf(container, "intro");
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const told = () =>
      post.mock.calls.map(([message]) => message).filter((message) => message.type === "slop:neighbors");
    expect(told()).toEqual([]);
    fireEvent.load(frame);
    // In the preview's own pixels: its slide starts at 2150, and the next one a gap after its 1920.
    expect(told()).toEqual([{ type: "slop:neighbors", cells: [{ slide: "outro", x: 4168, y: 699, locked: false }] }]);
    // A render that moves nothing says nothing.
    act(() => useApp.getState().setFinalState(true));
    expect(told()).toHaveLength(1);
    // The area resized: the slides are elsewhere.
    resize(1200, 540);
    expect(told()).toHaveLength(2);
    expect(told()[1].cells).toEqual([{ slide: "outro", x: 4101, y: 446, locked: false }]);
    // The other slide was locked: nothing can be dropped on it.
    act(() => useApp.getState().setDeck(withMarks("outro", { locked: true })));
    expect(told()).toHaveLength(3);
    expect(told()[2].cells).toEqual([{ slide: "outro", x: 4101, y: 446, locked: true }]);
    // A third slide picked: the pasteboard knows of two.
    act(() => useApp.setState({ railSelected: ["intro", "#2", "outro"] }));
    expect(told()).toHaveLength(4);
    expect(told()[3].cells.map((each: { slide: string }) => each.slide)).toEqual(["#2", "outro"]);
  });

  it("makes a slide the pasteboard says was clicked the current one, and keeps the others", () => {
    const { container } = render(<Stage />);
    const frame = frameOf(container, "intro");
    fireEvent.load(frame);
    // Not one of those shown, or said by a preview that is not the current slide's: nothing happens.
    fromFrame(frame, { type: "slop:activate", slide: "intro", to: "#2" });
    fromFrame(frame, { type: "slop:activate", slide: "outro", to: "intro" });
    expect(selected()).toBe("intro");
    fromFrame(frame, { type: "slop:activate", slide: "intro", to: "outro" });
    expect(selected()).toBe("outro");
    expect(picks()).toEqual(["intro", "outro"]);
    // The stage's marks moved with it.
    expect(cell(container, "outro").hasAttribute("data-sketch-target")).toBe(true);
    expect(cell(container, "intro").hasAttribute("data-sketch-target")).toBe(false);
    expect(cell(container, "outro").contains(screen.getByTestId("annotation-view"))).toBe(true);
    // Each loads what it is now behind what it showed: the clicked one its pasteboard, the other a still.
    expect(srcOf(frameOf(container, "outro"))).toContain("&pan");
    expect(srcOf(frameOf(container, "intro"))).toContain("&static");
    expect(srcOf(frameOf(container, "intro"))).not.toContain("&pan");
    // The new pasteboard is told of the slide that was the current one.
    const post = vi.spyOn(frameOf(container, "outro").contentWindow!, "postMessage");
    fireEvent.load(frameOf(container, "outro"));
    expect(post).toHaveBeenCalledWith(
      { type: "slop:neighbors", cells: [expect.objectContaining({ slide: "intro" })] },
      "*",
    );
  });

  it("does not take the still a slide showed for its preview, should it load once the slide is the current one", () => {
    const { container } = render(<Stage />);
    const still = frameOf(container, "outro");
    act(() => useApp.getState().activateSlide("outro"));
    expect(framesOf(container, "outro")).toHaveLength(2);
    const post = vi.spyOn(still.contentWindow!, "postMessage");
    fireEvent.load(still);
    expect(post).not.toHaveBeenCalled();
  });

  it("hands the stage a slide's preview again when the slide is the current one again before its still loaded", () => {
    const { container } = render(<Stage />);
    const first = frameOf(container, "intro");
    fireEvent.load(first);
    act(() => useApp.getState().activateSlide("outro"));
    const second = frameOf(container, "outro");
    fireEvent.load(second);
    // Back before the first slide's still has loaded: it keeps the pasteboard it shows, and loads nothing.
    const posted = vi.spyOn(first.contentWindow!, "postMessage");
    const elsewhere = vi.spyOn(second.contentWindow!, "postMessage");
    act(() => useApp.getState().activateSlide("intro"));
    expect(framesOf(container, "intro")).toEqual([first]);
    // The stage's preview is that pasteboard again: it hears where the other slide is from it now,
    expect(posted).toHaveBeenCalledWith(
      { type: "slop:neighbors", cells: [expect.objectContaining({ slide: "outro" })] },
      "*",
    );
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ type: "slop:canvas" }), "*");
    // and it is the one the stage's keys and buttons reach, not the other slide's on its way out.
    elsewhere.mockClear();
    fireEvent.keyDown(document.body, { key: "0" });
    expect(posted).toHaveBeenCalledWith({ type: "slop:camera", home: true }, "*");
    expect(elsewhere).not.toHaveBeenCalled();
  });

  it("hands the editor of such a slide what the toolbar says, as one that just loaded", () => {
    const { container, frame } = editing();
    act(() => useApp.getState().activateSlide("outro"));
    fireEvent.load(frameOf(container, "outro"));
    const posted = vi.spyOn(frame.contentWindow!, "postMessage");
    act(() => useApp.getState().activateSlide("intro"));
    expect(framesOf(container, "intro")).toEqual([frame]);
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-snap" }), "*");
    posted.mockClear();
    act(() => useApp.getState().setEditTool("rect"));
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-tool", tool: "rect" }), "*");
  });

  it("keeps the current slide's preview as other slides come to lie beside it, and as they go", () => {
    useApp.setState({ railSelected: [] });
    const { container } = render(<Stage />);
    const frame = container.querySelector("iframe")!;
    fireEvent.load(frame);
    const box = container.querySelector<HTMLElement>("[data-sketch-target]")!;
    const ink = screen.getByTestId("annotation-view");
    // Another slide picked with the current one kept: the same preview, in a smaller box.
    act(() => useApp.getState().extendRailSelection("outro", "range"));
    expect(container.querySelectorAll("[data-stage-cell]")).toHaveLength(3);
    expect(framesOf(container, "intro")).toEqual([frame]);
    expect(cell(container, "intro")).toBe(box);
    expect(screen.getByTestId("annotation-view")).toBe(ink);
    expect(Number.parseFloat(box.style.width)).toBeLessThan(960);
    // Back to it alone: still the same.
    act(() => useApp.getState().clearRailSelection());
    expect(container.querySelector("[data-stage-cell]")).toBeNull();
    expect([...container.querySelectorAll("iframe")]).toEqual([frame]);
    expect(container.querySelector("[data-sketch-target]")).toBe(box);
    expect(box.style.width).toBe("960px");
    expect(screen.getAllByTestId("annotation-view")).toEqual([ink]);
  });

  it("leaves the stills as they are when the current slide plays again", () => {
    const { container } = render(<Stage />);
    const still = srcOf(frameOf(container, "outro"));
    act(() => useApp.getState().replaySlide());
    expect(srcOf(frameOf(container, "intro"))).toContain(".r1");
    expect(framesOf(container, "outro").map(srcOf)).toEqual([still]);
  });

  it("goes back to one slide for a slide picked alone", () => {
    const { container } = render(<Stage />);
    act(() => useApp.getState().select("outro"));
    expect(container.querySelector("[data-stage-cell]")).toBeNull();
    expect(container.querySelector<HTMLElement>("[data-sketch-target]")!.style.width).toBe("960px");
    // The slide is the one that was beside the other: its preview loads behind the still it showed.
    fireEvent.load(container.querySelectorAll("iframe")[1]!);
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(srcOf(container.querySelector("iframe")!)).toContain("&pan");
  });

  it("says that it shows one slide when more are picked than fit side by side", () => {
    const deck = deckFor(DECK_HTML);
    const slides = Array.from({ length: GRID_MAX + 1 }, (_, i) => ({ ...deck.slides[0]!, id: `s${i}` }));
    useApp.setState({ deck: { ...deck, slides }, selected: "s2", railSelected: slides.map((s) => s.id) });
    const { container } = render(<Stage />);
    expect(screen.getByTestId("picked-note").textContent).toBe(`${GRID_MAX + 1} picked – showing one`);
    expect(container.querySelector("[data-stage-cell]")).toBeNull();
    act(() => useApp.getState().pickSlides(["s1", "s2"]));
    expect(screen.queryByTestId("picked-note")).toBeNull();
    expect(container.querySelectorAll("[data-stage-cell]")).toHaveLength(2);
  });

  it("takes dropped images on the current slide only", () => {
    const { container } = editing();
    screen.getByTestId("stage-area").getBoundingClientRect = () => new DOMRect(0, 0, 1024, 604);
    cell(container, "intro").getBoundingClientRect = () => new DOMRect(32, 170, 468, 263);
    expect(dropCovered({ x: 100, y: 200 })).toBe(true);
    // Over the other slide, which has no editor to put them on it.
    expect(dropCovered({ x: 700, y: 200 })).toBe(false);
    // Alone, the slide takes them anywhere on its pasteboard.
    act(() => useApp.getState().clearRailSelection());
    expect(dropCovered({ x: 700, y: 200 })).toBe(true);
  });
});

describe("moving an element to another of the slides shown", () => {
  const CLIP = `<!--slopslides:{"slide":"intro","path":[0]}--><h1>Hello</h1>`;
  const WITHOUT = `<section class="slide" id="intro"></section>`;
  const WITH = `<section class="slide" id="outro"><h1>Hello</h1></section>`;
  const commit = { type: "slop:edit-commit", slide: "intro", markup: WITHOUT, select: null, group: "transfer:7" };
  const transfer = { type: "slop:edit-transfer", slide: "intro", to: "outro", html: CLIP, x: 300, y: 200 };
  const saves = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "update_slide")
      .map(([, args]) => args as { slide: string; group?: string });
  const ran = (command: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === command).length;

  it("saves its own slide without it first, then goes to the other slide and hands its editor the element", async () => {
    const { container, frame } = editing();
    let saved!: (deck: Deck) => void;
    vi.mocked(invoke).mockImplementation((command) =>
      command === "update_slide" ? new Promise((resolve) => (saved = resolve as typeof saved)) : Promise.resolve(),
    );
    fromFrame(frame, commit);
    fromFrame(frame, { ...transfer, group: "transfer:7" });
    await flush();
    expect(saves()).toEqual([expect.objectContaining({ slide: "intro", markup: WITHOUT, group: "transfer:7" })]);
    // The other slide's editor loads a deck that has the element off this slide: not before the save.
    expect(selected()).toBe("intro");
    expect(framesOf(container, "outro").map(srcOf).join()).not.toContain("&edit=");
    await acting(async () => saved(withHash("intro", "without")));
    await flush();
    expect(selected()).toBe("outro");
    expect(picks()).toEqual(["intro", "outro"]);
    const target = frameOf(container, "outro");
    expect(srcOf(target)).toContain("&edit=");
    // The still it showed is not its editor.
    const still = vi.spyOn(framesOf(container, "outro")[0]!.contentWindow!, "postMessage");
    fireEvent.load(framesOf(container, "outro")[0]!);
    expect(still).not.toHaveBeenCalled();
    const post = vi.spyOn(target.contentWindow!, "postMessage");
    fireEvent.load(target);
    expect(post).toHaveBeenCalledWith(
      { type: "slop:edit-paste", html: CLIP, x: 300, y: 200, space: "slide", group: "transfer:7" },
      "*",
    );
    // It is handed over once, however often the editor loads.
    post.mockClear();
    fireEvent.load(target);
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:edit-paste" }), "*");
    // The other slide's save is of the same group: one undo takes back both.
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "update_slide" ? withHash("outro", "with") : undefined,
    );
    fromFrame(target, { type: "slop:edit-commit", slide: "outro", markup: WITH, select: [0], group: "transfer:7" });
    await flush();
    expect(saves().at(-1)).toMatchObject({ slide: "outro", markup: WITH, group: "transfer:7" });
    expect(lastError(useApp.getState())).toBeNull();
  });

  it("hands over a copy dragged there, which left its own slide as it was, and one sent in place", async () => {
    const { container, frame } = editing();
    vi.mocked(invoke).mockResolvedValue(undefined);
    fromFrame(frame, { ...transfer, x: null, y: null, group: "transfer:8" });
    await flush();
    expect(saves()).toEqual([]);
    expect(selected()).toBe("outro");
    const target = frameOf(container, "outro");
    const post = vi.spyOn(target.contentWindow!, "postMessage");
    fireEvent.load(target);
    expect(post).toHaveBeenCalledWith(
      { type: "slop:edit-paste", html: CLIP, x: null, y: null, space: "slide", group: "transfer:8" },
      "*",
    );
  });

  it("ignores a move it cannot make sense of, or one from a slide that is not the current one", async () => {
    const { frame } = editing();
    fromFrame(frame, { ...transfer, html: undefined });
    fromFrame(frame, { ...transfer, to: 3 });
    fromFrame(frame, { ...transfer, slide: "outro", to: "intro" });
    await flush();
    expect(selected()).toBe("intro");
  });

  describe("that does not arrive", () => {
    const entry = { id: "e", source: "edit", label: "Edit slide", time: 0, group: "edit:transfer:7" };
    /** A backend that saves, and undoes the save of the first slide. */
    const backend = (newest = entry) =>
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === "update_slide") return withHash("intro", "without");
        if (command === "deck_history") return { undo: newest, redo: null, current: "v" };
        if (command === "undo_deck") {
          return { deck: withHash("intro", "back"), entry, status: { undo: null, redo: entry, current: "v" } };
        }
        return undefined;
      });
    const wait = async (ms: number) => {
      await acting(async () => void vi.advanceTimersByTime(ms));
      await flush();
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    it("puts the element back on its slide when the other slide's editor does not load", async () => {
      const { frame } = editing();
      backend();
      fromFrame(frame, commit);
      fromFrame(frame, { ...transfer, group: "transfer:7" });
      await flush();
      expect(selected()).toBe("outro");
      await wait(FRAME_LOAD_LIMIT - 1);
      expect(ran("undo_deck")).toBe(0);
      await wait(1);
      expect(ran("undo_deck")).toBe(1);
      // Undoing shows the slide that changed, among the same slides.
      expect(selected()).toBe("intro");
      expect(picks()).toEqual(["intro", "outro"]);
      expect(lastError(useApp.getState())).toContain("could not be moved");
    });

    it("puts it back when the other slide's editor took it and saved nothing", async () => {
      const { container, frame } = editing();
      backend();
      fromFrame(frame, commit);
      fromFrame(frame, { ...transfer, group: "transfer:7" });
      await flush();
      await wait(FRAME_LOAD_LIMIT - 1);
      // The editor loads just in time, and has as long again to save.
      fireEvent.load(frameOf(container, "outro"));
      await wait(FRAME_LOAD_LIMIT - 1);
      expect(ran("undo_deck")).toBe(0);
      await wait(1);
      expect(ran("undo_deck")).toBe(1);
      expect(selected()).toBe("intro");
    });

    it("leaves the deck alone once the other slide saved with it", async () => {
      const { container, frame } = editing();
      backend();
      fromFrame(frame, commit);
      fromFrame(frame, { ...transfer, group: "transfer:7" });
      await flush();
      const target = frameOf(container, "outro");
      fireEvent.load(target);
      fromFrame(target, { type: "slop:edit-commit", slide: "outro", markup: WITH, select: [0], group: "transfer:7" });
      await wait(2 * FRAME_LOAD_LIMIT);
      expect(ran("undo_deck")).toBe(0);
      expect(selected()).toBe("outro");
      expect(lastError(useApp.getState())).toBeNull();
    });

    it("undoes nothing for a copy, whose slide was not saved, nor when the deck changed since", async () => {
      const { frame } = editing();
      backend();
      fromFrame(frame, { ...transfer, group: "transfer:8" });
      await flush();
      await wait(FRAME_LOAD_LIMIT);
      expect(ran("undo_deck")).toBe(0);
      expect(lastError(useApp.getState())).toContain("could not be moved");
      // Something else is the deck's newest change by now: undoing that is not what is wanted.
      act(() => useApp.setState({ toasts: [] }));
      act(() => useApp.getState().activateSlide("intro"));
      const again = frameOf(document.body, "intro");
      fireEvent.load(again);
      backend({ ...entry, label: "Move slides" });
      fromFrame(again, commit);
      fromFrame(again, { ...transfer, group: "transfer:7" });
      await flush();
      await wait(FRAME_LOAD_LIMIT);
      expect(ran("undo_deck")).toBe(0);
      expect(lastError(useApp.getState())).toContain("cannot be undone");
    });

    it("moves nothing when its slide could not be saved without it", async () => {
      const { frame } = editing();
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === "update_slide") throw "The slide changed while you were editing it";
        return undefined;
      });
      fromFrame(frame, commit);
      fromFrame(frame, { ...transfer, group: "transfer:7" });
      await flush();
      expect(selected()).toBe("intro");
      await wait(2 * FRAME_LOAD_LIMIT);
      expect(ran("undo_deck")).toBe(0);
      expect(lastError(useApp.getState())).toContain("changed while you were editing");
    });
  });

  describe("that cannot get there any more", () => {
    type Entry = { id: string; source: string; label: string; time: number; group: string | null };
    const OLDER: Entry = { id: "older", source: "edit", label: "Edit slide", time: 0, group: null };
    /** What a step of the backend waits for, if anything. */
    let held: Record<string, Promise<void>> = {};
    /**
     * A backend that keeps a history, as the real one does: every save of a slide is a change
     * labelled alike, the saves of one group are one, and undo takes back the newest and changes
     * the first slide. It starts with a change made before any move. `refuse` is a slide it will not save.
     */
    const history = (refuse?: string) => {
      const done = [OLDER];
      const undone: Entry[] = [];
      let version = 0;
      const status = () => ({ undo: done.at(-1) ?? null, redo: undone.at(-1) ?? null, current: `v${version}` });
      vi.mocked(invoke).mockImplementation(async (command, given) => {
        await held[command];
        if (command === "deck_history") return status();
        if (command === "update_slide") {
          const { slide, group } = given as { slide: string; group?: string };
          if (slide === refuse) throw "The slide changed while you were editing it.";
          const of = group ? `edit:${group}` : null;
          if (!of || done.at(-1)?.group !== of) {
            done.push({ id: `save${++version}`, source: "edit", label: "Edit slide", time: 0, group: of });
          }
          undone.length = 0;
          return withHash(slide, `saved${++version}`);
        }
        if (command === "undo_deck") {
          const entry = done.pop()!;
          undone.push(entry);
          return { deck: withHash("intro", `undone${++version}`), entry, status: status() };
        }
        return undefined;
      });
      return { changes: () => done.map((each) => each.id), undone: () => undone.map((each) => each.id) };
    };
    /** Holds `command` up until what this gives back is called. */
    const hold = (command: string) => {
      let release!: () => void;
      held[command] = new Promise((resolve) => (release = resolve));
      return async () => {
        await acting(async () => release());
        await flush();
      };
    };
    const wait = async (ms: number) => {
      await acting(async () => void vi.advanceTimersByTime(ms));
      await flush();
    };
    /** The element dropped on the other slide, which is the current one now and loading its editor. */
    const dropped = async () => {
      const utils = editing();
      const log = history();
      fromFrame(utils.frame, commit);
      fromFrame(utils.frame, { ...transfer, group: "transfer:7" });
      await flush();
      expect(selected()).toBe("outro");
      expect(log.changes()).toEqual(["older", "save1"]);
      return { ...utils, log };
    };
    const pastes = (frame: HTMLIFrameElement) => {
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      return () => post.mock.calls.filter(([message]) => message.type === "slop:edit-paste").length;
    };
    const errors = () =>
      useApp
        .getState()
        .toasts.filter((toast) => toast.kind === "error")
        .map((toast) => toast.text);

    beforeEach(() => {
      held = {};
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    it("leaves the change before it alone when the user undid the move while the other slide loaded", async () => {
      const { container, log } = await dropped();
      await acting(() => useApp.getState().undo());
      await flush();
      // The user's undo took the element back to its slide, and shows that.
      expect(log.changes()).toEqual(["older"]);
      expect(selected()).toBe("intro");
      // The other slide does not get it as well, should it be worked on again and load.
      act(() => useApp.getState().activateSlide("outro"));
      const target = frameOf(container, "outro");
      const pasted = pastes(target);
      fireEvent.load(target);
      expect(pasted()).toBe(0);
      // And nothing is undone for it in the end: what is the newest change now was made before it.
      await wait(2 * FRAME_LOAD_LIMIT);
      expect(ran("undo_deck")).toBe(1);
      expect(log.changes()).toEqual(["older"]);
      expect(errors()).toEqual([]);
    });

    it("puts the element back at once when the user goes to another slide, and does not wait to undo what they do there", async () => {
      const { log } = await dropped();
      act(() => useApp.getState().select("#2"));
      await flush();
      expect(log.changes()).toEqual(["older"]);
      expect(errors()).toEqual(["The element could not be moved to the other slide; it is where it was."]);
      // The slide it is back on shows.
      expect(selected()).toBe("intro");
      await wait(2 * FRAME_LOAD_LIMIT);
      expect(ran("undo_deck")).toBe(1);
    });

    it("puts it back when the deck leaves edit mode", async () => {
      const { log } = await dropped();
      act(() => useApp.getState().setMode("view"));
      await flush();
      expect(log.changes()).toEqual(["older"]);
      expect(errors()).toHaveLength(1);
    });

    it("undoes nothing in another deck opened meanwhile, and says where the element is", async () => {
      const { log } = await dropped();
      act(() => useApp.setState({ deck: { ...useApp.getState().deck!, id: "/decks/other/deck.html" } }));
      await flush();
      await wait(2 * FRAME_LOAD_LIMIT);
      expect(ran("undo_deck")).toBe(0);
      expect(log.changes()).toEqual(["older", "save1"]);
      expect(errors()).toEqual([
        "The element did not get to the other slide before its deck closed. Undo in that deck puts it back.",
      ]);
    });

    it("puts it back when the stage goes away while the other slide loads", async () => {
      const { unmount, log } = await dropped();
      unmount();
      await flush();
      expect(log.changes()).toEqual(["older"]);
      expect(errors()).toEqual(["The element could not be moved to the other slide; it is where it was."]);
    });

    it("puts it back when the stage goes away while its own slide is still being saved without it", async () => {
      const { frame, unmount } = editing();
      const log = history();
      const save = hold("update_slide");
      fromFrame(frame, commit);
      fromFrame(frame, { ...transfer, group: "transfer:7" });
      await flush();
      unmount();
      await flush();
      expect(ran("undo_deck")).toBe(0);
      await save();
      expect(log.changes()).toEqual(["older"]);
      expect(log.undone()).toEqual(["save1"]);
      expect(selected()).toBe("intro");
      expect(errors()).toHaveLength(1);
    });

    it("puts it back when the other slide could not be saved with it", async () => {
      const { container, frame } = editing();
      const log = history("outro");
      fromFrame(frame, commit);
      fromFrame(frame, { ...transfer, group: "transfer:7" });
      await flush();
      const target = frameOf(container, "outro");
      fireEvent.load(target);
      fromFrame(target, { type: "slop:edit-commit", slide: "outro", markup: WITH, select: [0], group: "transfer:7" });
      await flush();
      // The save that took it off its slide is undone: nothing else would bring it back.
      expect(saves().map((save) => save.slide)).toEqual(["intro", "outro"]);
      expect(log.changes()).toEqual(["older"]);
      expect(selected()).toBe("intro");
      expect(errors()).toEqual([
        "The slide changed while you were editing it.",
        "The element could not be moved to the other slide; it is where it was.",
      ]);
      await wait(2 * FRAME_LOAD_LIMIT);
      expect(ran("undo_deck")).toBe(1);
    });

    it("is not done before the other slide is saved with it: leaving meanwhile undoes nothing", async () => {
      const { container, log } = await dropped();
      const target = frameOf(container, "outro");
      fireEvent.load(target);
      const save = hold("update_slide");
      fromFrame(target, { type: "slop:edit-commit", slide: "outro", markup: WITH, select: [0], group: "transfer:7" });
      await flush();
      // The save decides, whatever the stage is on by then: undoing now would take back a move that is made.
      act(() => useApp.getState().select("#2"));
      await save();
      await wait(2 * FRAME_LOAD_LIMIT);
      expect(ran("undo_deck")).toBe(0);
      expect(log.changes()).toEqual(["older", "save1"]);
      expect(saves().map((each) => each.slide)).toEqual(["intro", "outro"]);
      expect(errors()).toEqual([]);
    });

    it("does not save it on the other slide too when an undo on its way took it back as it landed", async () => {
      const { container, log } = await dropped();
      const target = frameOf(container, "outro");
      const undo = hold("undo_deck");
      act(() => void useApp.getState().undo());
      // The other slide's editor loads and takes the element while the deck is being undone.
      fireEvent.load(target);
      fromFrame(target, { type: "slop:edit-commit", slide: "outro", markup: WITH, select: [0], group: "transfer:7" });
      await undo();
      expect(saves().map((each) => each.slide)).toEqual(["intro"]);
      expect(log.changes()).toEqual(["older"]);
      expect(selected()).toBe("intro");
      await wait(2 * FRAME_LOAD_LIMIT);
      expect(ran("undo_deck")).toBe(1);
      expect(errors()).toEqual([]);
    });

    it("sends a second element back to its slide while the first is on its way", async () => {
      const { frame } = editing();
      const log = history();
      fromFrame(frame, commit);
      fromFrame(frame, { ...transfer, group: "transfer:7" });
      fromFrame(frame, { ...commit, group: "transfer:9" });
      fromFrame(frame, { ...transfer, group: "transfer:9" });
      await flush();
      await flush();
      // Neither is lost: each save that took one off the slide is undone, the newest first.
      expect(log.changes()).toEqual(["older"]);
      expect(log.undone()).toEqual(["save3", "save1"]);
      expect(selected()).toBe("intro");
    });
  });

  it("says why nothing moved onto a locked slide", () => {
    const { frame } = editing();
    fromFrame(frame, { type: "slop:edit-transfer-refused", slide: "intro", to: "outro" });
    expect(toastTexts(useApp.getState(), "info")).toEqual(["Slide 3 is locked: nothing can be moved onto it."]);
    expect(selected()).toBe("intro");
  });

  describe("from the menu", () => {
    const ELEMENT = { path: "#intro > h1:nth-child(1)", markup: "<h1>Hi</h1>", name: '<h1> "Hi"', added: true };
    const openMenu = (frame: HTMLIFrameElement) =>
      fromFrame(frame, { type: "slop:edit-menu", slide: "intro", x: 100, y: 50, element: ELEMENT });
    const moveTo = () => screen.queryByRole("menuitem", { name: "Move to slide" });

    it("offers the other slides shown that are not locked, and tells the editor which was picked", async () => {
      useApp.setState({ deck: withMarks("outro", { locked: true }), railSelected: ["intro", "#2", "outro"] });
      const { frame } = editing();
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      openMenu(frame);
      fireEvent.click(moveTo()!);
      const targets = await screen.findByRole("menu", { name: "Move to slide" });
      expect([...targets.querySelectorAll("[role=menuitem]")].map((item) => item.textContent)).toEqual(["Slide 2"]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Slide 2" }));
      expect(post).toHaveBeenCalledWith({ type: "slop:edit-move-to", to: "#2" }, "*");
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("offers no move with one slide shown, or when the others are all locked", () => {
      useApp.setState({ deck: withMarks("outro", { locked: true }) });
      const { frame } = editing();
      openMenu(frame);
      expect(screen.getByRole("menu", { name: "Element" })).toBeTruthy();
      expect(moveTo()).toBeNull();
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      act(() => useApp.getState().clearRailSelection());
      const alone = document.querySelector("iframe")!;
      fireEvent.load(alone);
      openMenu(alone);
      expect(screen.getByRole("menu", { name: "Element" })).toBeTruthy();
      expect(moveTo()).toBeNull();
    });
  });
});
