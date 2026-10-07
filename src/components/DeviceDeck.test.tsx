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

/**
 * Reports the screen for the view, and for the slide's preview the width its page wrapper
 * sets, like a browser after layout.
 */
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
        : { width: parseFloat(target.parentElement?.style.width ?? "") || 0, height: 0 };
    this.callback([{ target, contentRect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

const observed: (() => void)[] = [];
/** Measures every observed element again, as a browser does once a size changes. */
const relayout = () => act(() => [...observed].forEach((measure) => measure()));

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

/** Two fingers spreading from 100 px apart to `spread` px apart, around the screen's center. */
const pinch = (spread: number, target?: Element) => {
  pointer("down", 1, 750, 450, target);
  pointer("down", 2, 850, 450, target);
  pointer("move", 1, 800 - spread / 2, 450, target);
  pointer("move", 2, 800 + spread / 2, 450, target);
  pointer("up", 1, 800 - spread / 2, 450, target);
  pointer("up", 2, 800 + spread / 2, 450, target);
};

describe("DeviceDeck", () => {
  it("shows only the current slide, as one page the size it is shown", () => {
    const { container } = show();
    const frames = container.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.getAttribute("src")).toContain("slide=intro");
    // No pasteboard, and not a 1920×1080 page scaled down: that is what iOS kills the page over.
    expect(frames[0]!.getAttribute("src")).not.toMatch(/&pan|&edit=/);
    expect(frames[0]!.style.width).toBe("1600px");
    expect(frames[0]!.style.transform).toBe("");
    expect(slideBox().style.width).toBe("1600px");
    expect(slideBox().style.height).toBe("900px");
    expect(button("All slides").textContent).toBe("1 / 3");
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

  it("does not change slides on a mostly vertical drag", () => {
    show();
    pointer("down", 1, 800, 200);
    pointer("up", 1, 740, 600);
    expect(selected()).toBe("intro");
  });

  it("pinches to zoom, then draws the page larger to stay sharp, but never past the known-safe size", () => {
    const { container } = show();
    pinch(200);
    expect(slideBox().style.transform).toBe("translate(0px, 0px) scale(2)");
    expect(button("Fit the slide to the screen").textContent).toBe("200%");
    // 2× the 1600 px slide would be a 3200 px page; it stops at 1920 px and is scaled up from there.
    const page = screen.getByTestId("device-page");
    expect(page.style.width).toBe("1920px");
    expect(page.style.transform).toBe(`scale(${1600 / 1920})`);
    relayout();
    expect(container.querySelector("iframe")!.style.width).toBe("1920px");
  });

  it("pans a zoomed slide instead of swiping, and fits it again on request", () => {
    show();
    pinch(200);
    pointer("down", 1, 800, 450);
    pointer("move", 1, 500, 300);
    pointer("up", 1, 500, 300);
    expect(selected()).toBe("intro");
    expect(slideBox().style.transform).toBe("translate(-300px, -150px) scale(2)");
    fireEvent.click(button("Fit the slide to the screen"));
    expect(slideBox().style.transform).toBe("translate(0px, 0px) scale(1)");
    expect(screen.getByTestId("device-page").style.width).toBe("1600px");
  });

  it("zooms in on a double tap and back out on the next one", () => {
    show();
    const tap = (x: number, y: number) => {
      pointer("down", 1, x, y);
      pointer("up", 1, x, y);
    };
    tap(1000, 450);
    tap(1000, 450);
    expect(slideBox().style.transform).toBe("translate(-300px, 0px) scale(2.5)");
    tap(1000, 450);
    tap(1000, 450);
    expect(slideBox().style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("hides and shows the bars on a single tap", () => {
    vi.useFakeTimers();
    show();
    const footer = () => screen.getByRole("toolbar", { name: "Sketch tools" }).closest("footer")!;
    pointer("down", 1, 800, 450);
    pointer("up", 1, 800, 450);
    expect(footer().className).not.toContain("opacity-0");
    act(() => vi.advanceTimersByTime(400));
    expect(footer().className).toContain("opacity-0");
    vi.advanceTimersByTime(1000);
    pointer("down", 1, 800, 450);
    pointer("up", 1, 800, 450);
    act(() => vi.advanceTimersByTime(400));
    expect(footer().className).not.toContain("opacity-0");
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

  it("turns a stroke into a pinch when a second finger lands, leaving no mark", () => {
    show();
    fireEvent.click(button("Highlight on the slide"));
    pinch(300, screen.getByTestId("annotation-layer"));
    expect(app.useApp.getState().sketches.intro ?? []).toEqual([]);
    expect(slideBox().style.transform).toBe("translate(0px, 0px) scale(3)");
    // The pen still works afterwards.
    const layer = screen.getByTestId("annotation-layer");
    pointer("down", 1, 800, 450, layer);
    pointer("move", 1, 820, 450, layer);
    pointer("up", 1, 820, 450, layer);
    expect(app.useApp.getState().sketches.intro).toHaveLength(1);
  });

  it("starts each slide fit to the screen", () => {
    show();
    pinch(200);
    fireEvent.click(button("Next slide"));
    expect(slideBox().style.transform).toBe("translate(0px, 0px) scale(1)");
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
