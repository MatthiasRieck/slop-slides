import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
// The chat has its own tests; here only where it opens matters.
vi.mock("./ChatPanel", () => ({ ChatPanel: () => <div data-testid="stub-chat" /> }));

import { DECK_HTML, deckFor } from "../test/fixtures";

/** The device's screen, which the view fills. */
const SCREEN = { width: 1600, height: 900 };

const NoLayout = globalThis.ResizeObserver;

/** Reports the space for the slide, and for the slide's preview the slide's width, like a browser after layout. */
class MeasuringObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: HTMLElement) {
    observed.push(() => this.measure(target));
    this.measure(target);
  }
  private measure(target: HTMLElement) {
    const contentRect =
      target.dataset.testid === "device-stage"
        ? SCREEN
        : { width: parseFloat(target.closest<HTMLElement>("[data-testid=device-slide]")?.style.width ?? "") || 0, height: 0 };
    this.callback([{ target, contentRect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

const observed: (() => void)[] = [];

/** The view and the store as a device loads them (both read `isRemote` when imported). */
async function load() {
  window.__SLOPSLIDE_REMOTE__ = { base: "/s/tok" };
  vi.resetModules();
  const { useApp } = await import("../store");
  const { DeviceDeck } = await import("./DeviceDeck");
  useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", sketches: {}, reviewVisible: true, running: false });
  return { useApp, DeviceDeck };
}

let app: Awaited<ReturnType<typeof load>>;

beforeEach(async () => {
  observed.length = 0;
  globalThis.ResizeObserver = MeasuringObserver as unknown as typeof ResizeObserver;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, SCREEN.width, SCREEN.height));
  app = await load();
});

afterEach(() => {
  globalThis.ResizeObserver = NoLayout;
  delete window.__SLOPSLIDE_REMOTE__;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const show = () => render(<app.DeviceDeck />);
const stage = () => screen.getByTestId("device-stage");
const slideBox = () => screen.getByTestId("device-slide");
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const selected = () => app.useApp.getState().selected;

/** Fires pointer events at the view; points are screen pixels. */
const pointer = (type: "down" | "move" | "up", id: number, x: number, y: number, target: Element = stage()) => {
  const init = { pointerId: id, clientX: x, clientY: y, button: 0, buttons: type === "up" ? 0 : 1 };
  if (type === "down") fireEvent.pointerDown(target, init);
  else if (type === "move") fireEvent.pointerMove(target, init);
  else fireEvent.pointerUp(target, init);
};

describe("DeviceDeck", () => {
  it("shows only the current slide, as one page the size it is shown", () => {
    const { container } = show();
    const frames = container.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.getAttribute("src")).toContain("slide=intro");
    // No pasteboard, and not a 1920×1080 page scaled down: that is what iOS kills the page over.
    expect(frames[0]!.getAttribute("src")).not.toMatch(/&pan|&edit=/);
    // Without the fade and entrance animations, a slide is all there the moment it is shown.
    expect(frames[0]!.getAttribute("src")).toContain("&static");
    expect(frames[0]!.style.width).toBe("1600px");
    expect(slideBox().style.width).toBe("1600px");
    expect(slideBox().style.height).toBe("900px");
    expect(button("All slides").textContent).toBe("1 / 3");
  });

  it("keeps the stack flat: nothing between the screen and the slide's page is transformed", () => {
    const { container } = show();
    const frame = container.querySelector("iframe")!;
    for (let el: HTMLElement | null = frame; el; el = el.parentElement) {
      expect(el.style.transform, el.outerHTML.slice(0, 80)).toBe("");
    }
    // The tools sit in their own bar, not blurred over the slide.
    expect(container.querySelector("[class*=backdrop-blur]")).toBeNull();
    expect(stage().contains(screen.getByRole("toolbar", { name: "Sketch tools" }))).toBe(false);
  });

  it("keeps one page for the deck and switches slides in it, without loading the deck again", () => {
    const { container } = show();
    const frame = container.querySelector("iframe")!;
    const src = frame.getAttribute("src");
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.click(button("Next slide"));
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(container.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("src")).toBe(src);
    expect(post).toHaveBeenLastCalledWith({ type: "slop:show", slide: "#2" }, "*");
    // A page that finishes loading is told the slide to show, in case it changed meanwhile.
    fireEvent.load(frame);
    expect(post).toHaveBeenLastCalledWith({ type: "slop:show", slide: "#2" }, "*");
  });

  it("loads the deck again when it changes, starting on the slide shown", () => {
    const { container } = show();
    fireEvent.click(button("Next slide"));
    const before = container.querySelector("iframe")!.getAttribute("src");
    act(() => app.useApp.setState({ deck: deckFor(DECK_HTML, "2") }));
    const urls = [...container.querySelectorAll("iframe")].map((f) => f.getAttribute("src"));
    const next = urls.find((url) => url !== before)!;
    expect(next).toContain("slide=%232");
    expect(next).not.toContain("slide=intro");
  });

  it("moves between slides with the buttons and the keyboard", () => {
    show();
    expect(button("Previous slide")).toHaveProperty("disabled", true);
    fireEvent.click(button("Next slide"));
    expect(selected()).toBe("#2");
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(selected()).toBe("outro");
    expect(button("Next slide")).toHaveProperty("disabled", true);
    fireEvent.keyDown(document.body, { key: "PageUp" });
    expect(selected()).toBe("#2");
    // Not while typing, e.g. in the chat.
    const input = document.body.appendChild(document.createElement("textarea"));
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(selected()).toBe("#2");
    input.remove();
  });

  it("jumps to a slide from the list", () => {
    show();
    fireEvent.click(button("All slides"));
    const dialog = screen.getByRole("dialog", { name: "Slides" });
    expect(dialog.querySelector("[aria-current]")?.textContent).toContain("intro");
    fireEvent.click(screen.getByRole("button", { name: /outro/ }));
    expect(selected()).toBe("outro");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("swipes to the next and previous slide", () => {
    show();
    pointer("down", 1, 900, 450);
    pointer("move", 1, 700, 460);
    pointer("up", 1, 700, 460);
    expect(selected()).toBe("#2");
    pointer("down", 1, 700, 450);
    pointer("up", 1, 900, 450);
    expect(selected()).toBe("intro");
  });

  it("does not swipe with two fingers", () => {
    show();
    pointer("down", 1, 900, 450);
    pointer("down", 2, 1000, 450);
    pointer("up", 1, 600, 450);
    pointer("up", 2, 700, 450);
    expect(selected()).toBe("intro");
  });

  it("does not change slides on a mostly vertical drag", () => {
    show();
    pointer("down", 1, 800, 200);
    pointer("up", 1, 740, 600);
    expect(selected()).toBe("intro");
  });

  it("draws review marks on the slide with the pen, and does not swipe while drawing", () => {
    show();
    fireEvent.click(button("Draw on the slide"));
    const layer = screen.getByTestId("annotation-layer");
    pointer("down", 1, 900, 450, layer);
    pointer("move", 1, 500, 450, layer);
    pointer("up", 1, 500, 450, layer);
    expect(selected()).toBe("intro");
    const marks = app.useApp.getState().sketches.intro!;
    expect(marks).toHaveLength(1);
    expect(marks[0]!.tool).toBe("pen");
    expect(marks[0]!.points).toEqual([
      [0.5625, 0.5],
      [0.3125, 0.5],
    ]);
    fireEvent.click(button("Undo mark"));
    expect(app.useApp.getState().sketches.intro).toEqual([]);
  });

  it("keeps a touch stroke going when Safari reports the finger leaving the layer", () => {
    show();
    fireEvent.click(button("Draw on the slide"));
    const layer = screen.getByTestId("annotation-layer");
    pointer("down", 1, 800, 450, layer);
    fireEvent.pointerLeave(layer, { pointerId: 1, pointerType: "touch" });
    pointer("move", 1, 900, 450, layer);
    pointer("move", 1, 1000, 450, layer);
    pointer("up", 1, 1000, 450, layer);
    const marks = app.useApp.getState().sketches.intro!;
    expect(marks).toHaveLength(1);
    expect(marks[0]!.points).toHaveLength(3);
  });

  it("records every position a pencil reports between frames", () => {
    show();
    fireEvent.click(button("Draw on the slide"));
    const layer = screen.getByTestId("annotation-layer");
    pointer("down", 1, 800, 450, layer);
    const move = new PointerEvent("pointermove", { pointerId: 1, clientX: 960, clientY: 450, bubbles: true });
    const between = [880, 920, 960].map((x) => new PointerEvent("pointermove", { clientX: x, clientY: 450 }));
    Object.assign(move, { getCoalescedEvents: () => between });
    act(() => void layer.dispatchEvent(move));
    pointer("up", 1, 960, 450, layer);
    expect(app.useApp.getState().sketches.intro![0]!.points.map(([x]) => x)).toEqual([0.5, 0.55, 0.575, 0.6]);
  });

  it("draws the stroke in progress on a canvas, a segment per move, and the finished one in the SVG", () => {
    const calls: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) => (key in target ? target[key] : (...args: unknown[]) => calls.push(`${key}(${args.join(",")})`)),
      set: (target, key: string, value) => ((target[key] = value), true),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      (ctx as { canvas?: HTMLCanvasElement }).canvas = this;
      return ctx as unknown as CanvasRenderingContext2D;
    });
    show();
    fireEvent.click(button("Draw on the slide"));
    const layer = screen.getByTestId("annotation-layer");
    const svg = layer.querySelector("svg")!;
    pointer("down", 1, 800, 450, layer);
    pointer("move", 1, 900, 450, layer);
    pointer("move", 1, 1000, 450, layer);
    // Nothing is rendered for the stroke while it is drawn: the canvas gets just the new segments.
    expect(svg.children).toHaveLength(0);
    expect(calls.filter((c) => c.startsWith("lineTo"))).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith("stroke("))).toHaveLength(2);
    pointer("up", 1, 1000, 450, layer);
    expect(svg.querySelectorAll("[data-stroke]")).toHaveLength(1);
    expect(calls.at(-1)).toMatch(/^clearRect/);
  });

  it("keeps Safari from taking a drag on the slide over", () => {
    show();
    const drag = new Event("touchmove", { cancelable: true, bubbles: true });
    stage().dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
  });

  it("opens the chat over the slide and shows when the agent is working", () => {
    show();
    expect(screen.queryByTestId("agent-running")).toBeNull();
    act(() => app.useApp.setState({ running: true }));
    expect(screen.getByTestId("agent-running")).toBeTruthy();
    fireEvent.click(button("Chat"));
    expect(screen.getByRole("dialog", { name: "Chat" }).contains(screen.getByTestId("stub-chat"))).toBe(true);
    fireEvent.click(button("Close chat"));
    expect(screen.queryByTestId("stub-chat")).toBeNull();
  });

  it("goes back to the deck list", () => {
    const closeDeck = vi.fn(async () => {});
    app.useApp.setState({ closeDeck });
    show();
    fireEvent.click(button("All decks"));
    expect(closeDeck).toHaveBeenCalledOnce();
  });

  it("asks for slides when the deck has none", () => {
    app.useApp.setState({ deck: { ...deckFor(DECK_HTML), slides: [] }, selected: null });
    show();
    expect(screen.getByText(/No slides yet/)).toBeTruthy();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});
