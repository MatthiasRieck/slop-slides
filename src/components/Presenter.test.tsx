import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calls, emit, invoke, listen } from "../test/tauri";

const setFullscreen = vi.fn(async () => {});
const listeners = new Map<string, (event: { payload: unknown }) => void>();
listen.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => {
  listeners.set(name, handler);
  return () => listeners.delete(name);
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setFullscreen }) }));
const playNarration = vi.fn();
vi.mock("../lib/narrationAudio", () => ({ playNarration: (...args: unknown[]) => playNarration(...args) }));
// Counted, to tell when the show's bar renders: its buttons are these.
vi.mock("./Button", async (original) => {
  const actual = await original<typeof import("./Button")>();
  return { ...actual, ToolButton: vi.fn(actual.ToolButton) };
});

import { LASER_SIZE, TRAIL_FADE_MS, TRAIL_GLOW, TRAIL_HOLD_MS } from "../lib/ink";
import { saveVideoOptions } from "../lib/video";
import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { lastError } from "../store/errors";
import { fakeCanvas2D } from "../test/fakeCanvas";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ToolButton } from "./Button";
import { Presenter } from "./Presenter";
import { fitWidth } from "./PresenterPanel";
import { PresenterWindow } from "./PresenterWindow";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  emit.mockClear();
  listeners.clear();
  localStorage.removeItem("slopslide.presenterBudget");
  localStorage.removeItem("slopslide.presenterPanel");
  localStorage.removeItem("slopslide.presenterNotesSize");
  setFullscreen.mockClear();
  useApp.setState({
    deck: deckFor(DECK_HTML),
    selected: "outro",
    presenting: true,
    screens: null,
    presentFrom: "current",
    revealRev: 0,
    toasts: [],
  });
});

const frame = () => screen.getByTitle("Presentation") as HTMLIFrameElement;

function fromFrame(data: unknown, source: MessageEventSource | null = frame().contentWindow) {
  act(() => void window.dispatchEvent(new MessageEvent("message", { data, source })));
}

describe("Presenter", () => {
  it("plays the whole deck from the selected slide", () => {
    render(<Presenter />);
    expect(frame().getAttribute("src")).toBe("/__deck/.file/decks/talk/deck.html?v=shell-1&show#outro");
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("encodes positional slide ids in the hash", () => {
    useApp.setState({ selected: "#2" });
    render(<Presenter />);
    expect(frame().getAttribute("src")).toBe("/__deck/.file/decks/talk/deck.html?v=shell-1&show#%232");
  });

  it("starts at the beginning without a selection", () => {
    useApp.setState({ selected: null });
    render(<Presenter />);
    expect(frame().getAttribute("src")).toBe("/__deck/.file/decks/talk/deck.html?v=shell-1&show");
  });

  it("starts on the first slide shown when presenting from the beginning", () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({ presentFrom: "start" });
    const { unmount } = render(<Presenter />);
    expect(frame().getAttribute("src")).toBe("/__deck/.file/decks/talk/deck.html?v=shell-1&show#intro");
    expect(screen.getByTestId("show-position").textContent).toBe("1 / 3");
    unmount();
    // A hidden first slide is not where the show begins.
    useApp.setState({ deck: { ...deck, slides: deck.slides.map((s, i) => ({ ...s, hidden: i === 0 })) } });
    render(<Presenter />);
    expect(frame().getAttribute("src")).toBe("/__deck/.file/decks/talk/deck.html?v=shell-1&show#%232");
  });

  it("leaves the editor's selection alone while it runs, and lands the editor on the slide it ended on", () => {
    const select = vi.fn(useApp.getState().select);
    const real = useApp.getState().select;
    useApp.setState({ select });
    try {
      const { unmount } = render(<Presenter />);
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      fromFrame({ type: "slop:slide", id: "#2", index: 1 });
      // The show knows its slide; the editor under it is not told, and loads and scrolls nothing.
      expect(screen.getByTestId("show-position").textContent).toBe("2 / 3");
      expect(useApp.getState().selected).toBe("outro");
      expect(useApp.getState().revealRev).toBe(0);
      expect(select).not.toHaveBeenCalled();
      expect(frame().getAttribute("src")).toContain("#outro");
      unmount();
      expect(select.mock.calls).toEqual([["#2"]]);
      expect(useApp.getState().selected).toBe("#2");
    } finally {
      useApp.setState({ select: real });
    }
  });

  it("selects nothing when it ends on the slide it started from, or before the player said one", () => {
    const first = render(<Presenter />);
    first.unmount();
    const second = render(<Presenter />);
    fromFrame({ type: "slop:slide", id: "intro", index: 0 });
    fromFrame({ type: "slop:slide", id: "outro", index: 2 });
    second.unmount();
    expect(useApp.getState().selected).toBe("outro");
    expect(useApp.getState().revealRev).toBe(0);
  });

  it("renders its bar neither for a zoom or pan of the slide nor as the time passes", () => {
    vi.useFakeTimers();
    try {
      render(<Presenter />);
      fireEvent.keyDown(document.body, { key: "n" });
      // The bar goes once the pointer rests; after that nothing of the show changes by itself.
      act(() => void vi.advanceTimersByTime(3000));
      vi.mocked(ToolButton).mockClear();
      for (let k = 1; k <= 30; k++) fromFrame({ type: "slop:zoom", x: -k, y: -k, k: 1 + k / 10 });
      expect(screen.getByTestId("annotation-zoom").style.width).toBe("400%");
      expect(screen.getByTitle(/fit to the screen/).textContent).toBe("400%");
      act(() => void vi.advanceTimersByTime(30_000));
      // The presenter view's clocks ran on meanwhile.
      expect(screen.getByRole("timer").textContent).toBe("0:33");
      expect(ToolButton).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes full screen for the show and back afterwards", () => {
    const { unmount } = render(<Presenter />);
    expect(setFullscreen).toHaveBeenCalledWith(true);
    unmount();
    expect(setFullscreen).toHaveBeenLastCalledWith(false);
  });

  it("Escape ends the show, from the app or from inside the slide", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useApp.getState().presenting).toBe(false);
    useApp.setState({ presenting: true });
    fromFrame({ type: "slop:key", key: "Escape" });
    expect(useApp.getState().presenting).toBe(false);
  });

  describe("the bar at the bottom", () => {
    const bar = () => screen.getByRole("toolbar", { name: "Show controls" });
    const shown = () => bar().dataset.visible === "true";

    it("holds everything that operates the show, in one place", () => {
      render(<Presenter />);
      const names = [...bar().querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
      expect(names).toEqual([
        "Pointer (Esc)",
        "Laser pointer (L)",
        "Pen (P)",
        "Highlighter (H)",
        "Eraser (E)",
        "Undo",
        "Redo",
        "Clear slide (C)",
        "Previous slide",
        "Next slide",
        "Play",
        "Presenter view",
        "End show",
      ]);
      expect(screen.getAllByRole("toolbar")).toHaveLength(1);
    });

    it("has one way out, called End show, that leaves the focus where it was", () => {
      render(<Presenter />);
      expect(screen.queryByText(/Exit presentation/)).toBeNull();
      const exits = screen.getAllByRole("button", { name: /End show|Exit/ });
      expect(exits).toHaveLength(1);
      expect(exits[0]!.title).toBe("End show (Esc)");
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      exits[0]!.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      fireEvent.click(exits[0]!);
      expect(useApp.getState().presenting).toBe(false);
    });

    it("says which slide is on screen, of the slides shown", () => {
      const deck = deckFor(DECK_HTML);
      useApp.setState({ deck: { ...deck, slides: deck.slides.map((s, i) => ({ ...s, hidden: i === 1 })) } });
      render(<Presenter />);
      expect(screen.getByTestId("show-position").textContent).toBe("2 / 2");
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      expect(screen.getByTestId("show-position").textContent).toBe("1 / 2");
    });

    it("names the keys of its buttons in their tooltips", () => {
      render(<Presenter />);
      expect(screen.getByLabelText("Previous slide").title).toBe("Previous slide (←)");
      expect(screen.getByLabelText("Next slide").title).toBe("Next slide (→)");
      expect(screen.getByLabelText("Undo").title).toBe("Nothing to undo on this slide");
      expect(screen.getByLabelText("Presenter view").title).toMatch(/\(N\)$/);
    });

    describe("coming and going", () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());
      const idles = (post: { mock: { calls: unknown[][] } }) =>
        post.mock.calls
          .map(([m]) => m as { type: string; idle?: boolean })
          .filter((m) => m.type === "slop:idle")
          .map((m) => m.idle);

      it("shows at the start and goes once the pointer rests, out of reach of pointer and keyboard", () => {
        render(<Presenter />);
        expect(shown()).toBe(true);
        expect(bar().hasAttribute("inert")).toBe(false);
        act(() => void vi.advanceTimersByTime(2400));
        expect(shown()).toBe(true);
        act(() => void vi.advanceTimersByTime(100));
        expect(shown()).toBe(false);
        expect(bar().hasAttribute("inert")).toBe(true);
        expect(bar().className).toContain("pointer-events-none");
        expect(bar().className).toContain("opacity-0");
        expect(bar().className).toContain("motion-reduce:transition-none");
      });

      it("comes back with any move of the pointer, over the slide or beside it", () => {
        render(<Presenter />);
        act(() => void vi.advanceTimersByTime(3000));
        expect(shown()).toBe(false);
        fromFrame({ type: "slop:pointer" });
        expect(shown()).toBe(true);
        act(() => void vi.advanceTimersByTime(2000));
        fireEvent.mouseMove(document.body);
        act(() => void vi.advanceTimersByTime(2000));
        expect(shown()).toBe(true);
        act(() => void vi.advanceTimersByTime(500));
        expect(shown()).toBe(false);
        // Not for a move reported by something that is not the show.
        fromFrame({ type: "slop:pointer" }, window);
        expect(shown()).toBe(false);
      });

      it("stays while the pointer is on it", () => {
        render(<Presenter />);
        fireEvent.mouseEnter(bar());
        act(() => void vi.advanceTimersByTime(10_000));
        expect(shown()).toBe(true);
        fireEvent.mouseLeave(bar());
        expect(shown()).toBe(false);
      });

      it("stays while a tool is picked", () => {
        render(<Presenter />);
        fireEvent.keyDown(document.body, { key: "l" });
        act(() => void vi.advanceTimersByTime(10_000));
        expect(shown()).toBe(true);
        fireEvent.keyDown(document.body, { key: "Escape" });
        expect(shown()).toBe(true);
        act(() => void vi.advanceTimersByTime(2500));
        expect(shown()).toBe(false);
      });

      it("shows briefly when a key changes something on it", () => {
        render(<Presenter />);
        act(() => void vi.advanceTimersByTime(3000));
        fireEvent.keyDown(document.body, { key: "c" });
        expect(shown()).toBe(true);
        act(() => void vi.advanceTimersByTime(2500));
        expect(shown()).toBe(false);
        fromFrame({ type: "slop:key", key: "c", mod: false });
        expect(shown()).toBe(true);
      });

      it("takes the cursor over the slide along with it", () => {
        render(<Presenter />);
        const post = vi.spyOn(frame().contentWindow!, "postMessage");
        act(() => void vi.advanceTimersByTime(2500));
        expect(idles(post)).toEqual([true]);
        fromFrame({ type: "slop:pointer" });
        expect(idles(post)).toEqual([true, false]);
        // A page that loads meanwhile is told where things stand.
        act(() => void vi.advanceTimersByTime(2500));
        post.mockClear();
        fireEvent.load(frame());
        expect(idles(post)).toEqual([true]);
      });
    });
  });

  it("hands other keys to the player", () => {
    render(<Presenter />);
    const focus = vi.spyOn(frame(), "focus");
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(focus).toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith({ type: "slop:go", key: "ArrowRight" }, "*");
    expect(useApp.getState().presenting).toBe(true);
  });

  it("hands on the keys presenters expect, with Shift where it means something", () => {
    render(<Presenter />);
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    const sent = () => post.mock.calls.map(([m]) => m).filter((m) => (m as { type: string }).type === "slop:go");
    for (const key of ["Enter", "Backspace", "b", "w", ".", "3"]) fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(document.body, { key: " ", shiftKey: true });
    expect(sent()).toEqual([
      { type: "slop:go", key: "Enter" },
      { type: "slop:go", key: "Backspace" },
      { type: "slop:go", key: "b" },
      { type: "slop:go", key: "w" },
      { type: "slop:go", key: "." },
      { type: "slop:go", key: "3" },
      { type: "slop:go", key: " ", shift: true },
    ]);
  });

  it("leaves keys with a modifier to the system, and does not take them from the page", () => {
    render(<Presenter />);
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    const focus = vi.spyOn(frame(), "focus");
    for (const held of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      const event = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true, ...held });
      act(() => void document.body.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    fireEvent.keyDown(document.body, { key: "f", metaKey: true });
    // Alt with a tool's letter picks no tool either, here or in the slide's page.
    fireEvent.keyDown(document.body, { key: "p", altKey: true });
    fromFrame({ type: "slop:key", key: "p", mod: false, shift: false, alt: true });
    expect(screen.getByRole("button", { name: /^Pointer/ }).getAttribute("aria-pressed")).toBe("true");
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:go" }), "*");
    expect(focus).not.toHaveBeenCalled();
  });

  it("leaves Tab, and Enter and Space on a button, to the bar's own buttons", () => {
    render(<Presenter />);
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    const focus = vi.spyOn(frame(), "focus");
    fireEvent.keyDown(document.body, { key: "Tab" });
    const next = screen.getByLabelText("Next slide");
    fireEvent.keyDown(next, { key: "Enter" });
    fireEvent.keyDown(next, { key: " " });
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:go" }), "*");
    expect(focus).not.toHaveBeenCalled();
    // The arrows still move the slides from there.
    fireEvent.keyDown(next, { key: "ArrowLeft" });
    expect(post).toHaveBeenCalledWith({ type: "slop:go", key: "ArrowLeft" }, "*");
  });

  describe("the show's keys, listed", () => {
    const list = () => screen.queryByRole("dialog", { name: "Keys while presenting" });

    it("? opens them, from the app or from inside the slide, and Escape closes them, not the show", () => {
      render(<Presenter />);
      expect(list()).toBeNull();
      fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
      expect(list()!.textContent).toContain("Next slide");
      expect(list()!.textContent).toContain("Blank the screen");
      // Only the show's keys, not the editor's.
      expect(list()!.textContent).not.toContain("Duplicate");
      fireEvent.keyDown(list()!, { key: "Escape" });
      expect(list()).toBeNull();
      expect(useApp.getState().presenting).toBe(true);
      fromFrame({ type: "slop:key", key: "?", mod: false, shift: true });
      expect(list()).toBeTruthy();
      fromFrame({ type: "slop:key", key: "Escape" });
      expect(list()).toBeNull();
      expect(useApp.getState().presenting).toBe(true);
    });

    it("keeps the keys to itself while open", () => {
      render(<Presenter />);
      const post = vi.spyOn(frame().contentWindow!, "postMessage");
      fireEvent.keyDown(document.body, { key: "?" });
      post.mockClear();
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      fireEvent.keyDown(document.body, { key: "p" });
      expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:go" }), "*");
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.getByRole("button", { name: /^Pointer/ }).getAttribute("aria-pressed")).toBe("true");
    });

    it("opens from the presenter view too", () => {
      localStorage.setItem("slopslide.presenterPanel", "true");
      render(<Presenter />);
      fireEvent.click(screen.getByRole("button", { name: "Keys while presenting (?)" }));
      expect(list()).toBeTruthy();
    });
  });

  it("has previous and next buttons that drive the player", () => {
    render(<Presenter />);
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    fireEvent.click(screen.getByLabelText("Next slide"));
    expect(post).toHaveBeenLastCalledWith({ type: "slop:go", key: "ArrowRight" }, "*");
    fireEvent.click(screen.getByLabelText("Previous slide"));
    expect(post).toHaveBeenLastCalledWith({ type: "slop:go", key: "ArrowLeft" }, "*");
  });

  describe("playing by itself", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      playNarration.mockReset();
      useNarration.setState({ audio: {}, audioDeck: null });
      saveVideoOptions({
        secondsPerSlide: 3,
        fps: 30,
        animate: true,
        narration: true,
        pauseBefore: 0.5,
        pauseAfter: 1,
      });
    });
    afterEach(() => {
      vi.useRealTimers();
      localStorage.clear();
    });
    const nexts = (post: { mock: { calls: unknown[][] } }) =>
      post.mock.calls.filter(([m]) => (m as { key?: string }).key === "ArrowRight").length;

    it("shows each slide for the set time, then moves on, stopping after the last", async () => {
      render(<Presenter />);
      const post = vi.spyOn(frame().contentWindow!, "postMessage");
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      fireEvent.click(screen.getByLabelText("Play"));
      await act(async () => vi.advanceTimersByTime(2900));
      expect(nexts(post)).toBe(0);
      await act(async () => vi.advanceTimersByTime(100));
      expect(nexts(post)).toBe(1);
      fromFrame({ type: "slop:slide", id: "outro", index: 2 });
      await act(async () => vi.advanceTimersByTime(3000));
      expect(nexts(post)).toBe(1);
      expect(screen.getByLabelText("Play")).toBeTruthy();
      expect(playNarration).not.toHaveBeenCalled();
    });

    it("speaks a slide's narration between its pauses, staying until they end", async () => {
      const stop = vi.fn();
      playNarration.mockImplementation(async () => ({ ended: new Promise<void>(() => {}), stop }));
      useNarration.setState({
        audioDeck: deckFor(DECK_HTML).id,
        audio: { intro: { slide: "intro", state: "ready", seconds: 10 } },
      });
      render(<Presenter />);
      const post = vi.spyOn(frame().contentWindow!, "postMessage");
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      fireEvent.click(screen.getByLabelText("Play"));
      await act(async () => vi.advanceTimersByTime(400));
      expect(playNarration).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(100));
      expect(playNarration).toHaveBeenCalledWith(deckFor(DECK_HTML).id, "intro", expect.any(Function));
      // Loaded at once, it starts at its start.
      expect(playNarration.mock.lastCall?.[2]()).toBeCloseTo(0, 5);
      // Longer than the set time: the slide waits for the narration and the pause after it.
      await act(async () => vi.advanceTimersByTime(10_900));
      expect(nexts(post)).toBe(0);
      await act(async () => vi.advanceTimersByTime(100));
      expect(nexts(post)).toBe(1);
    });

    it("keeps the slide's animations with the narration, from the slide's start", async () => {
      playNarration.mockImplementation(async () => ({ ended: new Promise<void>(() => {}), stop: vi.fn() }));
      useNarration.setState({
        audioDeck: deckFor(DECK_HTML).id,
        audio: { intro: { slide: "intro", state: "ready", seconds: 10 } },
      });
      render(<Presenter />);
      const post = vi.spyOn(frame().contentWindow!, "postMessage");
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      const clocks = () =>
        post.mock.calls.map(([data]) => data as { type: string }).filter((data) => data.type === "slop:clock");
      fireEvent.click(screen.getByLabelText("Play"));
      expect(clocks()[0]).toEqual({ type: "slop:clock", slide: "intro", at: 0 });
      await act(async () => vi.advanceTimersByTime(1500));
      const last = clocks().at(-1) as unknown as { at: number };
      expect(last.at).toBeCloseTo(1.5, 1);
      // Paused, nothing more is sent: the slide's animations run on, none left frozen.
      const sent = clocks().length;
      fireEvent.click(screen.getByLabelText("Pause"));
      await act(async () => vi.advanceTimersByTime(1000));
      expect(clocks().length).toBe(sent);
    });

    it("keeps to the timeline's timing, the narration carrying on over the next slide", async () => {
      const stop = vi.fn();
      playNarration.mockImplementation(async () => ({ ended: new Promise<void>(() => {}), stop }));
      const base = deckFor(DECK_HTML);
      useApp.setState({
        deck: { ...base, slides: base.slides.map((s) => (s.id === "intro" ? { ...s, duration: 2 } : s)) },
      });
      useNarration.setState({
        audioDeck: base.id,
        audio: { intro: { slide: "intro", state: "ready", seconds: 10 } },
      });
      render(<Presenter />);
      const post = vi.spyOn(frame().contentWindow!, "postMessage");
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      fireEvent.click(screen.getByLabelText("Play"));
      await act(async () => vi.advanceTimersByTime(2000));
      expect(nexts(post)).toBe(1);
      fromFrame({ type: "slop:slide", id: "#2", index: 1 });
      await act(async () => vi.advanceTimersByTime(100));
      expect(stop).not.toHaveBeenCalled();
      expect(playNarration).toHaveBeenCalledTimes(1);
    });

    it("goes on from a slide someone else moved to", async () => {
      useNarration.setState({ audioDeck: null, audio: {} });
      render(<Presenter />);
      const post = vi.spyOn(frame().contentWindow!, "postMessage");
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      fireEvent.click(screen.getByLabelText("Play"));
      await act(async () => vi.advanceTimersByTime(2000));
      fromFrame({ type: "slop:slide", id: "#2", index: 1 });
      await act(async () => vi.advanceTimersByTime(2000));
      expect(nexts(post)).toBe(0);
      await act(async () => vi.advanceTimersByTime(1000));
      expect(nexts(post)).toBe(1);
    });

    it("pausing stops the narration and the show stays", async () => {
      const stop = vi.fn();
      playNarration.mockImplementation(async () => ({ ended: new Promise<void>(() => {}), stop }));
      useNarration.setState({
        audioDeck: deckFor(DECK_HTML).id,
        audio: { intro: { slide: "intro", state: "ready", seconds: 10 } },
      });
      render(<Presenter />);
      const post = vi.spyOn(frame().contentWindow!, "postMessage");
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      fireEvent.click(screen.getByLabelText("Play"));
      await act(async () => vi.advanceTimersByTime(600));
      fireEvent.click(screen.getByLabelText("Pause"));
      expect(stop).toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(nexts(post)).toBe(0);
    });

    it("speaks the narration whatever the video export was last set to", async () => {
      // A video exported without narration leaves that choice stored; it is the video's, not the show's.
      saveVideoOptions({
        secondsPerSlide: 3,
        fps: 30,
        animate: true,
        narration: false,
        pauseBefore: 0.5,
        pauseAfter: 1,
      });
      playNarration.mockImplementation(async () => ({ ended: new Promise<void>(() => {}), stop: vi.fn() }));
      useNarration.setState({
        audioDeck: deckFor(DECK_HTML).id,
        audio: { intro: { slide: "intro", state: "ready", seconds: 10 } },
      });
      render(<Presenter />);
      const post = vi.spyOn(frame().contentWindow!, "postMessage");
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      expect(screen.getByLabelText("Play").title).toMatch(/speak each slide's narration/);
      fireEvent.click(screen.getByLabelText("Play"));
      await act(async () => vi.advanceTimersByTime(500));
      expect(playNarration).toHaveBeenCalledWith(deckFor(DECK_HTML).id, "intro", expect.any(Function));
      // The slide waits for its narration, as the timeline has it.
      await act(async () => vi.advanceTimersByTime(10_900));
      expect(nexts(post)).toBe(0);
      await act(async () => vi.advanceTimersByTime(100));
      expect(nexts(post)).toBe(1);
    });

    it("leaves out-of-date audio unspoken", async () => {
      useNarration.setState({
        audioDeck: deckFor(DECK_HTML).id,
        audio: { intro: { slide: "intro", state: "stale", seconds: 10 } },
      });
      render(<Presenter />);
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      fireEvent.click(screen.getByLabelText("Play"));
      await act(async () => vi.advanceTimersByTime(5000));
      expect(playNarration).not.toHaveBeenCalled();
    });
  });

  it("ignores messages that are not from the show", () => {
    render(<Presenter />);
    fromFrame({ type: "slop:key", key: "Escape" }, window);
    fromFrame({ type: "slop:slide", id: "intro" }, null);
    fromFrame({ type: "slop:slide", id: null });
    fromFrame("not an object");
    expect(useApp.getState().presenting).toBe(true);
    expect(useApp.getState().selected).toBe("outro");
  });

  it("keeps the ink on the slide as it is zoomed and panned, ignoring nonsense", () => {
    render(<Presenter />);
    const zoom = () => {
      const { left, top, width, height, transform } = screen.getByTestId("annotation-zoom").style;
      return { left, top, width, height, transform };
    };
    expect(zoom()).toEqual({ left: "0px", top: "0px", width: "100%", height: "100%", transform: "" });
    fromFrame({ type: "slop:zoom", x: -100, y: -50, k: 2 });
    // Laid out at the zoomed size, not CSS-scaled, so the ink is not stretched blurry.
    expect(zoom()).toEqual({ left: "-100px", top: "-50px", width: "200%", height: "200%", transform: "" });
    fromFrame({ type: "slop:zoom", x: "a", y: 0, k: 1 });
    fromFrame({ type: "slop:zoom", x: 0, y: 0, k: 1 }, window);
    expect(zoom()).toEqual({ left: "-100px", top: "-50px", width: "200%", height: "200%", transform: "" });
  });

  it("0 fits the slide to the screen again, from the app too", () => {
    render(<Presenter />);
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    fireEvent.keyDown(document.body, { key: "0" });
    expect(post).toHaveBeenCalledWith({ type: "slop:camera", home: true }, "*");
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:go" }), "*");
  });

  it("offers to fit the slide again once it is zoomed or panned", () => {
    render(<Presenter />);
    const recenter = () => screen.queryByTitle(/fit to the screen/);
    expect(recenter()).toBeNull();
    fromFrame({ type: "slop:zoom", x: 10, y: 0, k: 1 });
    expect(recenter()!.textContent).toBe("100%");
    fromFrame({ type: "slop:zoom", x: -100, y: -50, k: 2 });
    expect(recenter()!.textContent).toBe("200%");
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    fireEvent.click(recenter()!);
    expect(post).toHaveBeenCalledWith({ type: "slop:camera", home: true }, "*");
    fromFrame({ type: "slop:zoom", x: 0, y: 0, k: 1 });
    expect(recenter()).toBeNull();
  });

  it("stops listening after the show", () => {
    const { unmount } = render(<Presenter />);
    unmount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useApp.getState().presenting).toBe(true);
  });

  it("renders nothing without a deck", () => {
    useApp.setState({ deck: null });
    render(<Presenter />);
    expect(screen.queryByTitle("Presentation")).toBeNull();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});

describe("Presenter tools", () => {
  const layer = () => screen.getByTestId("annotation-layer");
  const tool = (name: RegExp) => screen.getByRole("button", { name });
  const pressed = (name: RegExp) => tool(name).getAttribute("aria-pressed") === "true";
  const strokes = () => layer().querySelectorAll("[data-stroke]");

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 500));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function draw(points: [number, number][]) {
    const [first, ...rest] = points;
    fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: first![0], clientY: first![1], pointerId: 1 });
    for (const [x, y] of rest) fireEvent.pointerMove(layer(), { buttons: 1, clientX: x, clientY: y, pointerId: 1 });
    fireEvent.pointerUp(layer(), { pointerId: 1 });
  }

  it("starts with the slide clickable and no tool", () => {
    render(<Presenter />);
    expect(pressed(/^Pointer/)).toBe(true);
    expect(layer().style.pointerEvents).toBe("none");
  });

  it("keyboard shortcuts pick tools, and the same key puts the tool away", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "p" });
    expect(pressed(/^Pen/)).toBe(true);
    expect(layer().style.pointerEvents).toBe("auto");
    fireEvent.keyDown(document.body, { key: "H" });
    expect(pressed(/^Highlighter/)).toBe(true);
    fireEvent.keyDown(document.body, { key: "e" });
    expect(pressed(/^Eraser/)).toBe(true);
    fireEvent.keyDown(document.body, { key: "l" });
    expect(pressed(/^Laser/)).toBe(true);
    fireEvent.keyDown(document.body, { key: "l" });
    expect(pressed(/^Pointer/)).toBe(true);
  });

  it("shortcuts also work while the slide has focus", () => {
    render(<Presenter />);
    fromFrame({ type: "slop:key", key: "p", mod: false });
    expect(pressed(/^Pen/)).toBe(true);
  });

  it("tool shortcuts are not passed on to the player", () => {
    render(<Presenter />);
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    fireEvent.keyDown(document.body, { key: "p" });
    expect(post).not.toHaveBeenCalled();
  });

  it("Escape puts the tool away first, then ends the show", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "p" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(pressed(/^Pointer/)).toBe(true);
    expect(useApp.getState().presenting).toBe(true);
    fromFrame({ type: "slop:key", key: "Escape" });
    expect(useApp.getState().presenting).toBe(false);
  });

  it("toolbar buttons pick tools and end the show", () => {
    render(<Presenter />);
    fireEvent.click(tool(/^Highlighter/));
    expect(pressed(/^Highlighter/)).toBe(true);
    fireEvent.click(tool(/^End show/));
    expect(useApp.getState().presenting).toBe(false);
  });

  it("the pen draws strokes in fractions of the screen", () => {
    render(<Presenter />);
    fireEvent.click(tool(/^Pen/));
    draw([
      [100, 100],
      [200, 150],
      [300, 250],
    ]);
    expect(strokes()).toHaveLength(1);
    const path = strokes()[0]!;
    expect(path.getAttribute("d")).toBe("M100 100L150 125Q200 150 300 250");
    expect(path.getAttribute("stroke")).toBe("#ef4444");
    expect(path.getAttribute("stroke-width")).toBe("4");
  });

  /** A move that also carries the samples the browser coalesced into it, the event's own last. */
  function moveThrough(samples: [number, number][]) {
    const [x, y] = samples[samples.length - 1]!;
    const event = createEvent.pointerMove(layer(), { buttons: 1, clientX: x, clientY: y, pointerId: 1 });
    const coalesced = samples.map(([clientX, clientY]) => ({ clientX, clientY }));
    Object.assign(event, { getCoalescedEvents: () => coalesced });
    fireEvent(layer(), event);
  }

  it("the pen keeps every sample of a fast move, not just one per frame", () => {
    render(<Presenter />);
    fireEvent.click(tool(/^Pen/));
    fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 1 });
    moveThrough([
      [200, 100],
      [200, 200],
      [100, 200],
    ]);
    fireEvent.pointerUp(layer(), { pointerId: 1 });
    expect(strokes()[0]!.getAttribute("d")).toBe("M100 100L150 100Q200 100 200 150Q200 200 100 200");
  });

  it("draws ink as vectors at the zoomed size, thickening with the slide", () => {
    const resized: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    render(<Presenter />);
    fireEvent.click(tool(/^Pen/));
    draw([
      [100, 100],
      [200, 150],
    ]);
    fireEvent.keyDown(document.body, { key: "h" });
    draw([[300, 200]]);
    // The layer now measures twice the size, as it would once laid out at 200%.
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(-100, -50, 2000, 1000));
    fromFrame({ type: "slop:zoom", x: -100, y: -50, k: 2 });
    // Redrawn right in the resize callback, before the browser paints, so zooming doesn't flicker.
    for (const callback of resized) callback();
    const [pen, dot] = strokes();
    expect(pen!.getAttribute("d")).toBe("M200 200L400 300");
    expect(pen!.getAttribute("stroke-width")).toBe("8");
    expect(dot!.getAttribute("r")).toBe("28");
    expect(layer().querySelector("svg")!.style.transform).toBe("");
  });

  it("the highlighter draws wide, translucent strokes", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "h" });
    draw([
      [0, 0],
      [500, 250],
    ]);
    const path = strokes()[0]!;
    expect(path.getAttribute("stroke")).toBe("#facc15");
    expect(path.getAttribute("stroke-width")).toBe("28");
    expect(path.getAttribute("stroke-opacity")).toBe("0.4");
  });

  it("a tap leaves a dot the size of the tool, not a highlighted screen", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "h" });
    draw([[300, 200]]);
    expect(layer().querySelector("path")).toBeNull();
    const dot = strokes()[0]!;
    expect(dot.tagName).toBe("circle");
    expect(dot.getAttribute("cx")).toBe("300");
    expect(dot.getAttribute("cy")).toBe("200");
    expect(dot.getAttribute("r")).toBe("14");
    expect(dot.getAttribute("fill")).toBe("#facc15");
    expect(dot.getAttribute("fill-opacity")).toBe("0.4");
    fireEvent.keyDown(document.body, { key: "p" });
    draw([[10, 10]]);
    expect(strokes()[1]!.getAttribute("r")).toBe("2");
  });

  it("draws in pixels so strokes keep their width, and follows resizes", () => {
    const resized: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "p" });
    draw([
      [100, 100],
      [500, 250],
    ]);
    const svg = layer().querySelector("svg")!;
    expect(svg.hasAttribute("viewBox")).toBe(false);
    expect(strokes()[0]!.hasAttribute("vector-effect")).toBe(false);
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 2000, 1000));
    act(() => {
      for (const callback of resized) callback();
    });
    expect(strokes()[0]!.getAttribute("d")).toBe("M200 200L1000 500");
  });

  it("colors apply to the active ink tool", () => {
    render(<Presenter />);
    expect(screen.queryByRole("button", { name: /^Red$/ })).toBeNull();
    fireEvent.click(tool(/^Pen/));
    // Named, not numbered, for those who hear or hover them.
    expect(["Red", "Yellow", "Green", "Blue", "White"].map((name) => tool(new RegExp(`^${name}$`)).title)).toEqual([
      "Red",
      "Yellow",
      "Green",
      "Blue",
      "White",
    ]);
    expect(screen.queryByRole("button", { name: /#/ })).toBeNull();
    fireEvent.click(tool(/^Blue$/));
    expect(tool(/^Blue$/).getAttribute("aria-pressed")).toBe("true");
    draw([
      [10, 10],
      [20, 20],
    ]);
    expect(strokes()[0]!.getAttribute("stroke")).toBe("#3b82f6");
    fireEvent.click(tool(/^Highlighter/));
    expect(tool(/^Yellow$/).getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores right clicks and moves without a press", () => {
    render(<Presenter />);
    fireEvent.click(tool(/^Pen/));
    fireEvent.pointerDown(layer(), { button: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(layer(), { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(layer());
    expect(strokes()).toHaveLength(0);
  });

  it("undo removes the last stroke, clear removes them all", () => {
    render(<Presenter />);
    expect((tool(/^Undo/) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(tool(/^Pen/));
    draw([[10, 10]]);
    draw([[20, 20]]);
    draw([[30, 30]]);
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    expect(strokes()).toHaveLength(2);
    fromFrame({ type: "slop:key", key: "z", mod: true });
    expect(strokes()).toHaveLength(1);
    fireEvent.click(tool(/^Undo/));
    expect(strokes()).toHaveLength(0);
    draw([[10, 10]]);
    draw([[20, 20]]);
    fireEvent.keyDown(document.body, { key: "c" });
    expect(strokes()).toHaveLength(0);
    draw([[10, 10]]);
    fireEvent.click(tool(/^Clear slide/));
    expect(strokes()).toHaveLength(0);
  });

  it("undo brings back what clear removed, and redo clears again", () => {
    render(<Presenter />);
    const disabled = (name: RegExp) => (tool(name) as HTMLButtonElement).disabled;
    fireEvent.click(tool(/^Pen/));
    draw([[10, 10]]);
    draw([[20, 20]]);
    expect(disabled(/^Redo/)).toBe(true);
    fireEvent.keyDown(document.body, { key: "c" });
    expect(strokes()).toHaveLength(0);
    // An empty slide still has its clearing to undo.
    expect(disabled(/^Undo/)).toBe(false);
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    expect(strokes()).toHaveLength(2);
    expect(disabled(/^Redo/)).toBe(false);
    fireEvent.keyDown(document.body, { key: "z", metaKey: true, shiftKey: true });
    expect(strokes()).toHaveLength(0);
    fromFrame({ type: "slop:key", key: "z", mod: true, shift: false });
    expect(strokes()).toHaveLength(2);
    fromFrame({ type: "slop:key", key: "Z", mod: true, shift: true });
    expect(strokes()).toHaveLength(0);
    fireEvent.click(tool(/^Undo/));
    expect(strokes()).toHaveLength(2);
    fireEvent.click(tool(/^Redo/));
    expect(strokes()).toHaveLength(0);
    expect(tool(/^Redo/).title).toBe("Nothing to redo on this slide");
  });

  it("undo brings back a stroke the eraser took, where it was", () => {
    render(<Presenter />);
    fireEvent.click(tool(/^Pen/));
    draw([[10, 10]]);
    draw([[20, 20]]);
    draw([[30, 30]]);
    const middle = strokes()[1]!.getAttribute("cx");
    fireEvent.click(tool(/^Eraser/));
    fireEvent.pointerDown(strokes()[1]!, { button: 0, buttons: 1 });
    expect(strokes()).toHaveLength(2);
    fireEvent.click(tool(/^Undo/));
    expect(strokes()).toHaveLength(3);
    expect(strokes()[1]!.getAttribute("cx")).toBe(middle);
  });

  it("the eraser dragged over several strokes takes each, and each comes back in turn", () => {
    render(<Presenter />);
    fireEvent.click(tool(/^Pen/));
    draw([[10, 10]]);
    draw([[20, 20]]);
    draw([[30, 30]]);
    fireEvent.click(tool(/^Eraser/));
    // Two moves before the next render: the second builds on the first.
    act(() => {
      fireEvent.pointerMove(strokes()[0]!, { buttons: 1 });
      fireEvent.pointerMove(strokes()[0]!, { buttons: 1 });
    });
    expect(strokes()).toHaveLength(1);
    fireEvent.click(tool(/^Undo/));
    expect(strokes()).toHaveLength(2);
    fireEvent.click(tool(/^Undo/));
    expect(strokes()).toHaveLength(3);
  });

  it("keeps each slide's ink history to that slide", () => {
    render(<Presenter />);
    fromFrame({ type: "slop:slide", id: "intro", index: 0 });
    fireEvent.click(tool(/^Pen/));
    draw([[10, 10]]);
    fireEvent.keyDown(document.body, { key: "c" });
    fromFrame({ type: "slop:slide", id: null, index: 1 });
    expect((tool(/^Undo/) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    expect(strokes()).toHaveLength(0);
    fromFrame({ type: "slop:slide", id: "intro", index: 0 });
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    expect(strokes()).toHaveLength(1);
  });

  it("the laser has a pointer's icon, not the wand that means the agent elsewhere", () => {
    render(<Presenter />);
    expect(
      tool(/^Laser/)
        .querySelector("svg")!
        .getAttribute("class"),
    ).toContain("lucide-circle-dot");
  });

  it("modifier shortcuts other than undo are left alone", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "p", metaKey: true });
    expect(pressed(/^Pointer/)).toBe(true);
  });

  it("the eraser removes the strokes it touches", () => {
    render(<Presenter />);
    fireEvent.click(tool(/^Pen/));
    draw([[10, 10]]);
    draw([[20, 20]]);
    draw([[30, 30]]);
    fireEvent.click(tool(/^Eraser/));
    fireEvent.pointerDown(strokes()[1]!, { button: 0, buttons: 1 });
    expect(strokes()).toHaveLength(2);
    fireEvent.pointerMove(strokes()[0]!, { buttons: 0 });
    expect(strokes()).toHaveLength(2);
    fireEvent.pointerMove(strokes()[0]!, { buttons: 1 });
    expect(strokes()).toHaveLength(1);
    fireEvent.pointerDown(layer(), { button: 0, buttons: 1 });
    expect(strokes()).toHaveLength(1);
  });

  it("keeps ink with the slide it was drawn on", () => {
    render(<Presenter />);
    fromFrame({ type: "slop:slide", id: "intro", index: 0 });
    fireEvent.click(tool(/^Pen/));
    draw([[10, 10]]);
    fromFrame({ type: "slop:slide", id: null, index: 1 });
    expect(strokes()).toHaveLength(0);
    draw([[20, 20]]);
    draw([[30, 30]]);
    fromFrame({ type: "slop:slide", id: "intro", index: 0 });
    expect(strokes()).toHaveLength(1);
    fromFrame({ type: "slop:slide", id: null, index: 1 });
    expect(strokes()).toHaveLength(2);
  });

  it("the laser shows a dot that follows the pointer", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "l" });
    expect(layer().style.cursor).toBe("none");
    expect(screen.queryByTestId("laser")).toBeNull();
    fireEvent.pointerMove(layer(), { clientX: 120, clientY: 80 });
    const dot = screen.getByTestId("laser");
    // Moved, not laid out again: the layer does not render as the pointer goes.
    expect(dot.style.transform).toBe("translate(120px, 80px)");
    fireEvent.pointerMove(layer(), { clientX: 300, clientY: 40 });
    expect(screen.getByTestId("laser")).toBe(dot);
    expect(dot.style.transform).toBe("translate(300px, 40px)");
    fireEvent.pointerDown(layer(), { button: 0, clientX: 120, clientY: 80 });
    fireEvent.pointerUp(layer());
    expect(strokes()).toHaveLength(0);
    fireEvent.pointerLeave(layer());
    expect(screen.queryByTestId("laser")).toBeNull();
  });

  /** Records what is painted on the laser trail's canvas. */
  function paintedTrail() {
    const painted = { strokes: [] as number[], images: [] as { shadowBlur: number; shadowColor: string }[] };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      const ctx = fakeCanvas2D(this);
      // The visible canvas is in the document; the scratch canvas the trail is drawn on first is not.
      if (this.isConnected) {
        const clear = ctx.clearRect;
        ctx.clearRect = () => {
          clear();
          painted.strokes = ctx.strokes;
          painted.images = ctx.images;
        };
      } else {
        ctx.clearRect = () => {
          ctx.strokes = [];
          painted.strokes = ctx.strokes;
        };
      }
      return ctx as unknown as CanvasRenderingContext2D;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext);
    return painted;
  }

  function dragLaser() {
    fireEvent.keyDown(document.body, { key: "l" });
    // Just moving the laser leaves no trail.
    fireEvent.pointerMove(layer(), { buttons: 0, clientX: 100, clientY: 100 });
    expect(screen.queryByTestId("laser-trail")).toBeNull();
    fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(layer(), { buttons: 1, clientX: 200, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(layer(), { buttons: 1, clientX: 300, clientY: 150, pointerId: 1 });
    fireEvent.pointerUp(layer(), { pointerId: 1 });
  }

  it("dragging the laser leaves a trail that lingers, then fades away", () => {
    vi.useFakeTimers();
    try {
      const painted = paintedTrail();
      render(<Presenter />);
      dragLaser();
      expect(screen.getByTestId("laser-trail")).toBeTruthy();
      expect(painted.strokes).toEqual([LASER_SIZE, LASER_SIZE]);
      expect(strokes()).toHaveLength(0);
      act(() => void vi.advanceTimersByTime(TRAIL_HOLD_MS - 100));
      expect(painted.strokes).toEqual([LASER_SIZE, LASER_SIZE]);
      act(() => void vi.advanceTimersByTime(100 + TRAIL_FADE_MS / 2));
      expect(painted.strokes).toHaveLength(2);
      for (const width of painted.strokes) {
        expect(width).toBeGreaterThan(0);
        expect(width).toBeLessThan(LASER_SIZE);
      }
      act(() => void vi.advanceTimersByTime(TRAIL_FADE_MS));
      expect(screen.queryByTestId("laser-trail")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the laser trail keeps every sample of a fast move", () => {
    const painted = paintedTrail();
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "l" });
    fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 1 });
    moveThrough([
      [200, 100],
      [200, 200],
      [100, 200],
    ]);
    expect(painted.strokes).toEqual([LASER_SIZE, LASER_SIZE, LASER_SIZE]);
  });

  it("a fresh laser trail is as wide as the dot and glows like it", () => {
    const painted = paintedTrail();
    render(<Presenter />);
    dragLaser();
    fireEvent.pointerMove(layer(), { buttons: 0, clientX: 300, clientY: 150 });
    const dot = screen.getByTestId("laser");
    expect(`${painted.strokes[0]}px`).toBe(dot.style.width);
    const colors = (css: string) => css.match(/rgb\([^)]*\)/g)!.map((c) => c.replace(/\s+/g, " "));
    const glow = painted.images.filter((i) => i.shadowBlur > 0).map((i) => i.shadowColor);
    expect(new Set(glow)).toEqual(new Set(colors(dot.style.boxShadow)));
  });

  it("a zoomed-in laser trail only gets a canvas around the trail, inside the screen", () => {
    paintedTrail();
    const zoomed = { left: -1000, top: -500, width: window.innerWidth * 4, height: window.innerHeight * 4 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      ...zoomed,
      x: zoomed.left,
      y: zoomed.top,
    } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(zoomed.width);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(zoomed.height);
    render(<Presenter />);
    dragLaser();
    const canvas = screen.getByTestId("laser-trail") as HTMLCanvasElement;
    const box = ["left", "top", "width", "height"].map((side) =>
      Number.parseFloat(canvas.style.getPropertyValue(side)),
    );
    const [left, top, width, height] = box as [number, number, number, number];
    // The trail runs from (100, 100) to (300, 150) on screen, which is (1100, 600) to (1300, 650)
    // on the layer: the canvas reaches around it by the glow, and no further than the screen.
    expect(left).toBeGreaterThanOrEqual(1000);
    expect(top).toBeGreaterThanOrEqual(500);
    expect(left).toBeLessThanOrEqual(1100 - TRAIL_GLOW);
    expect(top).toBeLessThanOrEqual(600 - TRAIL_GLOW);
    expect(left + width).toBeGreaterThanOrEqual(1300 + TRAIL_GLOW);
    expect(top + height).toBeGreaterThanOrEqual(650 + TRAIL_GLOW);
    expect(width).toBeLessThan(window.innerWidth);
    expect(height).toBeLessThan(window.innerHeight);
    const scale = window.devicePixelRatio || 1;
    expect([canvas.width, canvas.height]).toEqual([width * scale, height * scale]);
  });

  it("putting the laser away clears its trail", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "l" });
    fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(layer(), { buttons: 1, clientX: 200, clientY: 100, pointerId: 1 });
    expect(screen.queryByTestId("laser-trail")).not.toBeNull();
    fireEvent.keyDown(document.body, { key: "l" });
    expect(screen.queryByTestId("laser-trail")).toBeNull();
  });

  it("toolbar buttons do not steal focus from the slide", () => {
    render(<Presenter />);
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    tool(/^Pen/).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("presenter view", () => {
  const panel = () => screen.queryByRole("complementary", { name: "Presenter view" });
  const notes = () => screen.getByTestId("presenter-notes").textContent;
  const deck = (hidden: string[] = []) => {
    const base = deckFor(DECK_HTML);
    return {
      ...base,
      slides: base.slides.map((s) => ({ ...s, notes: `Notes of ${s.id}`, hidden: hidden.includes(s.id) })),
    };
  };
  /** Starts the show with the presenter view open. */
  const showPanel = () => {
    const view = render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "n" });
    return view;
  };
  /** Opens the timer's settings, where the times to count down are set. */
  const openTimerSettings = () => fireEvent.click(screen.getByRole("button", { name: "Timer settings" }));
  const totalField = () => screen.getByLabelText("Total time in minutes") as HTMLInputElement;
  const perSlideField = () => screen.getByLabelText("Per slide in minutes") as HTMLInputElement;
  beforeEach(() => useApp.setState({ deck: deck(), selected: "intro" }));
  afterEach(() => vi.useRealTimers());

  it("stays closed until asked for, then remembers", () => {
    const { unmount } = render(<Presenter />);
    expect(panel()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Presenter view" }));
    expect(panel()).toBeTruthy();
    unmount();
    render(<Presenter />);
    expect(panel()).toBeTruthy();
  });

  it("N toggles it, from the app or from inside the slide", () => {
    showPanel();
    expect(panel()).toBeTruthy();
    fromFrame({ type: "slop:key", key: "N" });
    expect(panel()).toBeNull();
    fireEvent.keyDown(document.body, { key: "n", metaKey: true });
    expect(panel()).toBeNull();
  });

  it("shows the notes of the slide on screen and follows the show", () => {
    showPanel();
    expect(notes()).toBe("Notes of intro");
    fromFrame({ type: "slop:slide", id: "outro", index: 2 });
    expect(notes()).toBe("Notes of outro");
  });

  it("says when a slide has no notes", () => {
    useApp.setState({ deck: deckFor(DECK_HTML) });
    showPanel();
    expect(notes()).toBe("No notes for this slide.");
  });

  it("previews the next shown slide, skipping hidden ones, and says when there is none", () => {
    useApp.setState({ deck: deck(["#2"]) });
    showPanel();
    expect(screen.getByText("Slide 1 of 2")).toBeTruthy();
    fromFrame({ type: "slop:slide", id: "outro", index: 1 });
    expect(screen.getByText("Slide 2 of 2")).toBeTruthy();
    expect(screen.getByText("The end of the show.")).toBeTruthy();
  });

  it("counts the time since the show started, even while closed, and restarts", () => {
    vi.useFakeTimers();
    render(<Presenter />);
    act(() => void vi.advanceTimersByTime(65_000));
    fireEvent.keyDown(document.body, { key: "n" });
    expect(screen.getByRole("timer").textContent).toBe("1:05");
    act(() => void vi.advanceTimersByTime(2_000));
    expect(screen.getByRole("timer").textContent).toBe("1:07");
    fireEvent.click(screen.getByRole("button", { name: "Restart the timer" }));
    expect(screen.getByRole("timer").textContent).toBe("0:00");
    act(() => void vi.advanceTimersByTime(3_000));
    expect(screen.getByRole("timer").textContent).toBe("0:03");
  });

  it("shows the time left against the total time and the time on the slide against its own", () => {
    vi.useFakeTimers();
    showPanel();
    openTimerSettings();
    fireEvent.change(totalField(), { target: { value: "1" } });
    fireEvent.change(perSlideField(), { target: { value: "0.5" } });
    act(() => void vi.advanceTimersByTime(20_000));
    expect(screen.getByTestId("total-left").textContent).toBe("0:40 left");
    expect(screen.getByTestId("slide-time").textContent).toBe("slide0:20 / 0:30");
    act(() => void vi.advanceTimersByTime(50_000));
    expect(screen.getByTestId("total-left").textContent).toBe("+0:10 over");
    // A new slide starts its own time, the show's keeps running.
    fromFrame({ type: "slop:slide", index: 1, id: "outro" });
    expect(screen.getByTestId("slide-time").textContent).toBe("slide0:00 / 0:30");
    expect(screen.getByRole("timer").textContent).toBe("1:10");
    expect(JSON.parse(localStorage.getItem("slopslide.presenterBudget") ?? "")).toEqual({ total: 1, perSlide: 0.5 });
  });

  it("remembers the times and shows no budget without one", () => {
    localStorage.setItem("slopslide.presenterBudget", JSON.stringify({ total: 20, perSlide: -3 }));
    showPanel();
    expect(screen.getByTestId("total-left").textContent).toBe("20:00 left");
    openTimerSettings();
    expect(totalField().value).toBe("20");
    expect(perSlideField().value).toBe("");
  });

  it("keeps the times to count down behind a button, not in a row of their own", () => {
    showPanel();
    const settings = screen.getByRole("button", { name: "Timer settings" });
    expect(screen.queryByLabelText("Total time in minutes")).toBeNull();
    expect(settings.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(settings);
    expect(settings.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Timer settings" }).contains(totalField())).toBe(true);
    // Escape closes the settings, not the show.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Timer settings" })).toBeNull();
    expect(useApp.getState().presenting).toBe(true);
  });

  it("typing a time moves no slide and picks no tool", () => {
    showPanel();
    openTimerSettings();
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    for (const key of ["1", "p", "ArrowRight", " "]) fireEvent.keyDown(totalField(), { key });
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:go" }), "*");
    expect(screen.getByRole("button", { name: /^Pointer/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("says where a countdown comes from when its field is empty", () => {
    const base = deckFor(DECK_HTML);
    const slides = base.slides.map((s) => ({ ...s, time: s.id === "intro" ? 90 : s.id === "outro" ? 660 : 0 }));
    useApp.setState({ deck: { ...base, slides }, selected: "intro" });
    showPanel();
    // 12:30 left shows with both fields empty: they say why.
    expect(screen.getByTestId("total-left").textContent).toBe("12:30 left");
    openTimerSettings();
    expect(totalField().placeholder).toBe("12:30 from slide times");
    expect(perSlideField().placeholder).toBe("1:30 from this slide's time");
    // The presenter's own total replaces the slides'.
    fireEvent.change(totalField(), { target: { value: "20" } });
    expect(screen.getByTestId("total-left").textContent).toBe("20:00 left");
    // A time per slide does not replace a slide's own, and that is said.
    fireEvent.change(perSlideField(), { target: { value: "5" } });
    expect(screen.getByTestId("slide-time").textContent).toBe("slide0:00 / 1:30");
    expect(screen.getByRole("dialog", { name: "Timer settings" }).textContent).toContain(
      "This slide counts down its own time instead: 1:30 from this slide's time.",
    );
  });

  it("has plain placeholders without times on the slides", () => {
    showPanel();
    openTimerSettings();
    expect(totalField().placeholder).toBe("min");
    expect(perSlideField().placeholder).toBe("min");
  });

  it("pauses the timer and runs it on from where it stopped", () => {
    vi.useFakeTimers();
    showPanel();
    act(() => void vi.advanceTimersByTime(10_000));
    fireEvent.click(screen.getByRole("button", { name: "Pause the timer" }));
    expect(screen.getByTestId("timer-paused").textContent).toBe("Paused");
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("timer").textContent).toBe("0:10");
    expect(screen.getByTestId("slide-time").textContent).toBe("slide0:10");
    // A slide that comes on while paused waits at zero.
    fromFrame({ type: "slop:slide", index: 2, id: "outro" });
    act(() => void vi.advanceTimersByTime(5_000));
    expect(screen.getByTestId("slide-time").textContent).toBe("slide0:00");
    fireEvent.click(screen.getByRole("button", { name: "Resume the timer" }));
    expect(screen.queryByTestId("timer-paused")).toBeNull();
    act(() => void vi.advanceTimersByTime(5_000));
    expect(screen.getByRole("timer").textContent).toBe("0:15");
    expect(screen.getByTestId("slide-time").textContent).toBe("slide0:05");
    // Restarting a paused timer sets it running.
    fireEvent.click(screen.getByRole("button", { name: "Pause the timer" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart the timer" }));
    act(() => void vi.advanceTimersByTime(2_000));
    expect(screen.getByRole("timer").textContent).toBe("0:02");
  });

  it("keeps the time on the slide while the presenter view is closed", () => {
    vi.useFakeTimers();
    showPanel();
    act(() => void vi.advanceTimersByTime(40_000));
    fireEvent.keyDown(document.body, { key: "n" });
    act(() => void vi.advanceTimersByTime(5_000));
    fireEvent.keyDown(document.body, { key: "n" });
    expect(screen.getByTestId("slide-time").textContent).toBe("slide0:45");
    expect(screen.getByRole("timer").textContent).toBe("0:45");
  });

  it("shows the time of day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 14, 7, 30));
    showPanel();
    expect(screen.getByTestId("wall-clock").textContent).toMatch(/^(14|2)[:.]07/);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.getByTestId("wall-clock").textContent).toMatch(/^(14|2)[:.]08/);
  });

  it("makes the notes smaller and larger, and remembers the size", () => {
    const { unmount } = showPanel();
    const size = () => screen.getByTestId("presenter-notes").className.match(/text-(sm|base|lg|xl|2xl|3xl|4xl)/)?.[0];
    const smaller = () => screen.getByRole("button", { name: "Smaller notes" }) as HTMLButtonElement;
    const larger = () => screen.getByRole("button", { name: "Larger notes" }) as HTMLButtonElement;
    expect(size()).toBe("text-base");
    fireEvent.click(larger());
    fireEvent.click(larger());
    expect(size()).toBe("text-xl");
    unmount();
    // The panel is remembered open, and its notes at the size picked.
    render(<Presenter />);
    expect(size()).toBe("text-xl");
    fireEvent.click(smaller());
    fireEvent.click(smaller());
    fireEvent.click(smaller());
    expect(size()).toBe("text-sm");
    expect(smaller().disabled).toBe(true);
    expect(smaller().title).toBe("The notes are as small as they get");
    for (let i = 0; i < 8; i++) fireEvent.click(larger());
    expect(size()).toBe("text-4xl");
    expect(larger().disabled).toBe(true);
  });

  it("pressing the next slide's picture moves the show on to it", () => {
    showPanel();
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    const next = screen.getByRole("button", { name: "Go to the next slide" });
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    next.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.click(next);
    expect(post).toHaveBeenCalledWith({ type: "slop:go", key: "ArrowRight" }, "*");
    fromFrame({ type: "slop:slide", id: "outro", index: 2 });
    expect(screen.queryByRole("button", { name: "Go to the next slide" })).toBeNull();
  });

  it("counts down the time set on the slide, and the slides' times added up", () => {
    localStorage.setItem("slopslide.presenterBudget", JSON.stringify({ total: 0, perSlide: 5 }));
    const deck = deckFor(DECK_HTML);
    const slides = deck.slides.map((s) => ({ ...s, time: s.id === "intro" ? 90 : 0 }));
    useApp.setState({ deck: { ...deck, slides }, selected: "intro" });
    showPanel();
    expect(screen.getByTestId("slide-time").textContent).toBe("slide0:00 / 1:30");
    expect(screen.getByTestId("total-left").textContent).toBe("1:30 left");
    // A slide without a time of its own has the time per slide.
    fromFrame({ type: "slop:slide", index: 1, id: "outro" });
    expect(screen.getByTestId("slide-time").textContent).toBe("slide0:00 / 5:00");
  });

  it("shows notes as formatted Markdown, without links that would leave the app", () => {
    useApp.setState({
      deck: {
        ...deck(),
        slides: deck().slides.map((s) =>
          s.id === "intro" ? { ...s, notes: "Say **this**\nthen [that](https://a.b)\n\n- One" } : s,
        ),
      },
    });
    showPanel();
    const box = screen.getByTestId("presenter-notes");
    expect(box.querySelector("strong")?.textContent).toBe("this");
    expect(box.querySelector("li")?.textContent).toBe("One");
    expect(box.querySelector("a")).toBeNull();
    expect(box.textContent).toContain("then that");
  });

  describe("recording narration", () => {
    const model = { modelReady: true, modelBytes: 190_000_000, downloading: false, recording: false };
    const record = (name: RegExp) => screen.getByRole("button", { name });
    const text = () => record(/recording the text|narration as text/i);
    const audio = () => record(/recording the audio|narration as audio/i);
    const open = () => {
      render(<Presenter />);
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      fireEvent.keyDown(document.body, { key: "n" });
    };

    beforeEach(() => {
      invoke.mockImplementation(async (name: string) => (name === "voice_status" ? model : undefined));
    });

    it("records text from the slide on screen, and tells the backend each slide as it comes", async () => {
      open();
      await act(async () => fireEvent.click(text()));
      expect(calls("start_narration_recording")).toEqual([{ id: deck().id, slide: "intro", mode: "text" }]);
      expect(text().getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("status").textContent).toContain("Recording text");
      await act(async () => fromFrame({ type: "slop:slide", id: "outro", index: 2 }));
      await act(async () => fromFrame({ type: "slop:slide", id: "intro", index: 0 }));
      expect(calls("narration_recording_slide").map((a) => (a as { slide: string }).slide)).toEqual([
        "intro",
        "outro",
        "intro",
      ]);
      await act(async () => fireEvent.click(text()));
      expect(calls("stop_narration_recording")).toHaveLength(1);
      expect(text().getAttribute("aria-pressed")).toBe("false");
    });

    it("shows the narration growing while recording text", async () => {
      open();
      await act(async () => fireEvent.click(text()));
      expect(notes()).toBe("What you say over this slide shows up here.");
      useApp.setState({
        deck: {
          ...deck(),
          slides: deck().slides.map((s) => (s.id === "intro" ? { ...s, narration: "Um, hello." } : s)),
        },
      });
      await act(async () => {});
      expect(notes()).toBe("Um, hello.");
    });

    it("records audio without the speech model", async () => {
      invoke.mockImplementation(async (name: string) =>
        name === "voice_status" ? { ...model, modelReady: false } : undefined,
      );
      open();
      await act(async () => fireEvent.click(audio()));
      expect(calls("voice_status")).toHaveLength(0);
      expect(calls("start_narration_recording")).toEqual([{ id: deck().id, slide: "intro", mode: "audio" }]);
      expect(screen.getByRole("status").textContent).toContain("Recording audio");
    });

    it("offers the speech model first when recording text, and records once it is there", async () => {
      invoke.mockImplementation(async (name: string) =>
        name === "voice_status" ? { ...model, modelReady: false } : undefined,
      );
      open();
      await act(async () => fireEvent.click(text()));
      expect(screen.getByText(/transcribed on this computer/)).toBeTruthy();
      expect(calls("start_narration_recording")).toHaveLength(0);
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Download" })));
      expect(calls("download_voice_model")).toHaveLength(1);
      expect(calls("start_narration_recording")).toHaveLength(1);
    });

    it("uses the microphone for one thing at a time, and says what to stop first", async () => {
      open();
      const teleprompter = () => screen.getByRole("button", { name: /teleprompter/i }) as HTMLButtonElement;
      await act(async () => fireEvent.click(text()));
      expect((audio() as HTMLButtonElement).disabled).toBe(true);
      expect(audio().title).toBe("Stop the other recording first");
      expect(teleprompter().disabled).toBe(true);
      expect(teleprompter().title).toBe("Stop recording first");
      await act(async () => fireEvent.click(text()));
      expect(audio().title).toMatch(/^Record the narration as audio/);
      await act(async () => fireEvent.click(teleprompter()));
      expect((text() as HTMLButtonElement).disabled).toBe(true);
      expect((audio() as HTMLButtonElement).disabled).toBe(true);
      expect(text().title).toBe("Stop the teleprompter first");
      expect(audio().title).toBe("Stop the teleprompter first");
    });

    it("is red only while recording; the teleprompter shows in the primary color", async () => {
      open();
      const teleprompter = () => screen.getByRole("button", { name: /teleprompter/i });
      await act(async () => fireEvent.click(teleprompter()));
      expect(teleprompter().getAttribute("aria-pressed")).toBe("true");
      expect(teleprompter().className).toContain("text-primary");
      expect(teleprompter().className).not.toContain("destructive");
      await act(async () => fireEvent.click(teleprompter()));
      await act(async () => fireEvent.click(audio()));
      expect(audio().className).toContain("text-destructive");
    });

    it("goes on recording while the presenter view is closed, and says so over the slide", async () => {
      vi.useFakeTimers();
      open();
      expect(screen.queryByTestId("microphone-pill")).toBeNull();
      await act(async () => fireEvent.click(audio()));
      // Beside the slide the panel says it; no need to say it twice.
      expect(screen.queryByTestId("microphone-pill")).toBeNull();
      await act(async () => vi.advanceTimersByTime(65_000));
      await act(async () => fireEvent.keyDown(document.body, { key: "n" }));
      expect(calls("stop_narration_recording")).toHaveLength(0);
      const pill = screen.getByTestId("microphone-pill");
      expect(pill.getAttribute("role")).toBe("status");
      expect(pill.textContent).toBe("Recording1:05");
      expect(pill.className).toContain("text-destructive");
      // The slides it goes through are still told to the backend.
      await act(async () => fromFrame({ type: "slop:slide", id: "outro", index: 2 }));
      expect(calls("narration_recording_slide").at(-1)).toEqual({ slide: "outro" });
      // Open again, it is still recording, and stops when asked.
      await act(async () => fireEvent.keyDown(document.body, { key: "n" }));
      expect(audio().getAttribute("aria-pressed")).toBe("true");
      expect(screen.queryByTestId("microphone-pill")).toBeNull();
      await act(async () => fireEvent.click(audio()));
      expect(calls("stop_narration_recording")).toHaveLength(1);
    });

    it("shows how long the recording has run", async () => {
      vi.useFakeTimers();
      open();
      await act(async () => fireEvent.click(text()));
      expect(screen.getByTestId("recording-time").textContent).toBe("0:00");
      await act(async () => vi.advanceTimersByTime(83_000));
      expect(screen.getByTestId("recording-time").textContent).toBe("1:23");
      await act(async () => fireEvent.click(text()));
      expect(screen.queryByTestId("recording-time")).toBeNull();
    });

    it("keeps what was recorded when the show ends", async () => {
      const view = render(<Presenter />);
      fromFrame({ type: "slop:slide", id: "intro", index: 0 });
      fireEvent.keyDown(document.body, { key: "n" });
      await act(async () => fireEvent.click(audio()));
      await act(async () => view.unmount());
      expect(calls("stop_narration_recording")).toHaveLength(1);
      expect(invoke.mock.calls.map(([name]) => name)).not.toContain("cancel_recording");
    });

    it("shows what went wrong and ends the recording", async () => {
      open();
      await act(async () => fireEvent.click(text()));
      await act(async () => listeners.get("narration-record-failed")?.({ payload: "The microphone is silent." }));
      expect(screen.getByRole("alert").textContent).toBe("The microphone is silent.");
      expect(calls("stop_narration_recording")).toHaveLength(1);
      expect(text().getAttribute("aria-pressed")).toBe("false");
    });

    it("says when it cannot start", async () => {
      invoke.mockImplementation(async (name: string) => {
        if (name === "start_narration_recording") throw "Already recording.";
        return name === "voice_status" ? model : undefined;
      });
      open();
      await act(async () => fireEvent.click(audio()));
      expect(screen.getByRole("alert").textContent).toBe("Already recording.");
    });

    it("warns that nothing is kept on a locked slide", async () => {
      useApp.setState({
        deck: { ...deck(), slides: deck().slides.map((s) => (s.id === "intro" ? { ...s, locked: true } : s)) },
      });
      open();
      await act(async () => fireEvent.click(text()));
      expect(screen.getByRole("status").textContent).toContain("locked");
    });

    it("shows how loud the microphone is", async () => {
      open();
      await act(async () => fireEvent.click(audio()));
      await act(async () => listeners.get("voice-level")?.({ payload: 0.5 }));
      expect(screen.getByTestId("recording-level").style.transform).toBe("scale(1.5)");
    });
  });

  describe("teleprompter", () => {
    const button = () => screen.getByRole("button", { name: /teleprompter/i });
    const said = () =>
      [...screen.getByTestId("presenter-notes").querySelectorAll("[data-said]")].map((e) => e.textContent).join("");
    const script = "Welcome everyone to the quarterly results. Revenue grew in every region this year.";
    const slides = (narration?: string) =>
      deck().slides.map((s) => (s.id === "intro" ? { ...s, notes: script, narration } : s));
    const model = { modelReady: true, modelBytes: 190_000_000, downloading: false, recording: false };
    const commands = () => invoke.mock.calls.map(([name]) => name);

    beforeEach(() => {
      invoke.mockImplementation(async (name: string) => (name === "voice_status" ? model : undefined));
      useApp.setState({ deck: { ...deck(), slides: slides() } });
    });
    async function turnOn() {
      showPanel();
      await act(async () => fireEvent.click(button()));
    }
    const hear = (text: string) => act(() => listeners.get("voice-heard")?.({ payload: text }));

    it("follows through formatted text, keeping the formatting and leaving the marks out", async () => {
      useApp.setState({
        deck: {
          ...deck(),
          slides: deck().slides.map((s) =>
            s.id === "intro" ? { ...s, narration: "## Welcome everyone\n\n- to the **quarterly** results" } : s,
          ),
        },
      });
      await turnOn();
      hear("welcome everyone to the quarterly results");
      const box = screen.getByTestId("presenter-notes");
      expect(box.querySelector("h2")?.textContent).toBe("Welcome everyone");
      expect(box.querySelector("li strong [data-said]")?.textContent).toBe("quarterly");
      expect(said()).toBe("Welcome everyoneto the quarterly results");
      expect(box.textContent).not.toContain("*");
    });

    it("leaves the microphone alone until asked, and turns it off again", async () => {
      await act(async () => void render(<Presenter />));
      fireEvent.keyDown(document.body, { key: "n" });
      expect(commands()).not.toContain("follow_speech");
      await act(async () => fireEvent.click(button()));
      expect(commands()).toContain("follow_speech");
      expect(button().getAttribute("aria-pressed")).toBe("true");
      await act(async () => fireEvent.click(button()));
      expect(commands()).toContain("cancel_recording");
      expect(button().getAttribute("aria-pressed")).toBe("false");
    });

    it("fades what was said without marking it, keeping the text as it is", async () => {
      await turnOn();
      hear("welcome everyone to the quarterly results");
      expect(notes()).toBe(script);
      expect(said()).toBe("Welcome everyone to the quarterly results");
      const spoken = [...screen.getByTestId("presenter-notes").querySelectorAll("span")];
      for (const span of spoken) {
        expect(span.className).toBe(span.hasAttribute("data-said") ? "text-foreground/40" : "");
      }
    });

    it("scrolls the speaker's line into place", async () => {
      const scrollTo = vi.fn();
      Object.assign(HTMLElement.prototype, { scrollTo });
      await turnOn();
      hear("welcome everyone to the quarterly results");
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
    });

    it("follows the narration when the slide has one", async () => {
      useApp.setState({ deck: { ...deck(), slides: slides("Good morning and thanks for coming.") } });
      await turnOn();
      expect(notes()).toBe("Good morning and thanks for coming.");
    });

    it("starts over on each slide and keeps listening", async () => {
      await turnOn();
      hear("welcome everyone to the quarterly results");
      fromFrame({ type: "slop:slide", id: "outro", index: 2 });
      expect(notes()).toBe("Notes of outro");
      expect(said()).toBe("");
      expect(commands()).not.toContain("cancel_recording");
    });

    it("goes on listening while the presenter view is closed, and says so over the slide", async () => {
      await turnOn();
      fireEvent.keyDown(document.body, { key: "n" });
      expect(commands()).not.toContain("cancel_recording");
      const pill = screen.getByTestId("microphone-pill");
      expect(pill.textContent).toBe("Teleprompter listening");
      expect(pill.className).toContain("text-primary");
      fireEvent.keyDown(document.body, { key: "n" });
      expect(button().getAttribute("aria-pressed")).toBe("true");
    });

    it("turns the microphone off when the show ends", async () => {
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = render(<Presenter />);
      });
      fireEvent.keyDown(document.body, { key: "n" });
      await act(async () => fireEvent.click(button()));
      await act(async () => view.unmount());
      expect(commands()).toContain("cancel_recording");
    });

    it("offers the speech model first and goes on to listen once it is there", async () => {
      invoke.mockImplementation(async (name: string) =>
        name === "voice_status" ? { ...model, modelReady: false } : undefined,
      );
      await turnOn();
      expect(screen.getByText("Download the speech model?")).toBeTruthy();
      expect(commands()).not.toContain("follow_speech");
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Download" })));
      expect(commands()).toEqual(expect.arrayContaining(["download_voice_model", "follow_speech"]));
    });

    it("says why when it cannot listen", async () => {
      invoke.mockImplementation(async (name: string) => {
        if (name === "follow_speech") throw "Already recording.";
        return name === "voice_status" ? model : undefined;
      });
      await turnOn();
      expect(screen.getByRole("alert").textContent).toBe("Already recording.");
      expect(button().getAttribute("aria-pressed")).toBe("false");
    });

    it("gives up and says why when listening fails", async () => {
      await turnOn();
      act(() => listeners.get("voice-follow-failed")?.({ payload: "The microphone only delivered silence." }));
      expect(screen.getByRole("alert").textContent).toBe("The microphone only delivered silence.");
      expect(commands()).toContain("cancel_recording");
      expect(button().getAttribute("aria-pressed")).toBe("false");
    });
  });

  it("keeps the slide's focus when its buttons are pressed", () => {
    showPanel();
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    screen.getByRole("button", { name: "Restart the timer" }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("Presenter on several screens", () => {
  const choice = { audience: 1, presenter: 0 };

  it("moves the show to its screen before going full screen, and closes the presenter view after", async () => {
    useApp.setState({ screens: choice });
    const { unmount } = render(<Presenter />);
    expect(setFullscreen).not.toHaveBeenCalled();
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("present_on", { audience: 1, presenter: 0 });
    expect(setFullscreen).toHaveBeenCalledWith(true);
    unmount();
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("close_presenter_view");
  });

  it("opens the presenter view once under StrictMode's double-mounted effects", async () => {
    useApp.setState({ screens: choice });
    render(
      <StrictMode>
        <Presenter />
      </StrictMode>,
    );
    await act(async () => {});
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["present_on"]);
  });

  it("places and closes in the order asked, however long each takes", async () => {
    useApp.setState({ screens: choice });
    let finishPlacing = () => {};
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => (finishPlacing = resolve)));
    const { unmount } = render(<Presenter />);
    await act(async () => {});
    unmount();
    render(<Presenter />);
    await act(async () => {});
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["present_on"]);
    await act(async () => finishPlacing());
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["present_on", "close_presenter_view", "present_on"]);
  });

  it("stays out of full screen when the show ends while it is being placed", async () => {
    useApp.setState({ screens: choice });
    let finishPlacing = () => {};
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => (finishPlacing = resolve)));
    const { unmount } = render(<Presenter />);
    await act(async () => {});
    unmount();
    await act(async () => finishPlacing());
    expect(setFullscreen).not.toHaveBeenCalledWith(true);
  });

  it("keeps the presenter view off the audience's screen and feeds it to its own window", async () => {
    useApp.setState({ screens: choice });
    localStorage.setItem("slopslide.presenterPanel", "true");
    render(<Presenter />);
    await act(async () => {});
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(emit).toHaveBeenCalledWith("presenter:state", expect.objectContaining({ slide: "outro" }));
    fromFrame({ type: "slop:slide", index: 0, id: "intro" });
    expect(emit).toHaveBeenLastCalledWith("presenter:state", expect.objectContaining({ slide: "intro" }));
    emit.mockClear();
    listeners.get("presenter:ready")?.({ payload: null });
    expect(emit).toHaveBeenCalledWith("presenter:state", expect.objectContaining({ slide: "intro" }));
  });

  it("takes keys and the end of the show from the presenter view", async () => {
    useApp.setState({ screens: choice });
    render(<Presenter />);
    await act(async () => {});
    const post = vi.spyOn(frame().contentWindow as Window, "postMessage");
    const key = (key: string, shift = false) =>
      act(() => listeners.get("presenter:key")?.({ payload: { key, shift } }));
    key("ArrowRight");
    expect(post).toHaveBeenCalledWith({ type: "slop:go", key: "ArrowRight" }, "*");
    key(" ", true);
    expect(post).toHaveBeenCalledWith({ type: "slop:go", key: " ", shift: true }, "*");
    act(() => listeners.get("presenter:exit")?.({ payload: null }));
    expect(useApp.getState().presenting).toBe(false);
  });

  it("acts on the tools' keys pressed in the presenter view as on its own", async () => {
    useApp.setState({ screens: choice });
    render(<Presenter />);
    await act(async () => {});
    const post = vi.spyOn(frame().contentWindow as Window, "postMessage");
    const key = (key: string) => act(() => listeners.get("presenter:key")?.({ payload: { key, shift: false } }));
    const pressed = (name: RegExp) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
    key("l");
    expect(pressed(/^Laser/)).toBe("true");
    // Escape puts the tool away before it ends the show.
    key("Escape");
    expect(pressed(/^Pointer/)).toBe("true");
    expect(useApp.getState().presenting).toBe(true);
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "slop:go" }), "*");
    key("Escape");
    expect(useApp.getState().presenting).toBe(false);
  });

  it("plays and pauses when the presenter view asks, and tells it which", async () => {
    vi.useFakeTimers();
    try {
      useApp.setState({ screens: choice });
      render(<Presenter />);
      await act(async () => {});
      fromFrame({ type: "slop:slide", index: 0, id: "intro" });
      expect(emit).toHaveBeenLastCalledWith("presenter:state", expect.objectContaining({ playing: false }));
      act(() => listeners.get("presenter:play")?.({ payload: null }));
      expect(screen.getByLabelText("Pause")).toBeTruthy();
      expect(emit).toHaveBeenLastCalledWith("presenter:state", expect.objectContaining({ playing: true }));
      act(() => listeners.get("presenter:play")?.({ payload: null }));
      expect(emit).toHaveBeenLastCalledWith("presenter:state", expect.objectContaining({ playing: false }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("has no panel to open beside the slides, and its button says where the presenter view is", async () => {
    useApp.setState({ screens: choice });
    render(<Presenter />);
    await act(async () => {});
    const button = screen.getByRole("button", { name: "Presenter view" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("The presenter view is in a window of its own");
  });

  it("without a presenter view only moves the show", async () => {
    useApp.setState({ screens: { audience: 1, presenter: null } });
    render(<Presenter />);
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("present_on", { audience: 1, presenter: null });
    expect(emit).not.toHaveBeenCalled();
  });

  it("goes full screen where it is when presenting on one screen", () => {
    render(<Presenter />);
    expect(invoke).not.toHaveBeenCalled();
    expect(setFullscreen).toHaveBeenCalledWith(true);
  });
});

describe("Presenter in windows", () => {
  beforeEach(() => useApp.setState({ screens: "windows", toasts: [] }));

  it("opens the presenter view in a window and leaves the show's window as it is", async () => {
    localStorage.setItem("slopslide.presenterPanel", "true");
    const { unmount } = render(<Presenter />);
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("present_in_windows");
    expect(invoke).not.toHaveBeenCalledWith("present_on", expect.anything());
    expect(setFullscreen).not.toHaveBeenCalled();
    // The notes are in their own window, not beside the slides being shared.
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(emit).toHaveBeenCalledWith("presenter:state", expect.objectContaining({ slide: "outro" }));
    unmount();
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("close_presenter_view");
    expect(setFullscreen).not.toHaveBeenCalled();
  });

  it("is driven and ended from the presenter view", async () => {
    render(<Presenter />);
    await act(async () => {});
    const post = vi.spyOn(frame().contentWindow as Window, "postMessage");
    act(() => listeners.get("presenter:key")?.({ payload: { key: "ArrowRight", shift: false } }));
    expect(post).toHaveBeenCalledWith({ type: "slop:go", key: "ArrowRight" }, "*");
    act(() => listeners.get("presenter:exit")?.({ payload: null }));
    expect(useApp.getState().presenting).toBe(false);
  });

  it("opens the presenter view once under StrictMode's double-mounted effects", async () => {
    render(
      <StrictMode>
        <Presenter />
      </StrictMode>,
    );
    await act(async () => {});
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["present_in_windows"]);
  });

  it("says so when the presenter view can't be opened", async () => {
    invoke.mockRejectedValueOnce("cannot open the presenter view: no");
    render(<Presenter />);
    await act(async () => {});
    expect(lastError(useApp.getState())).toContain("cannot open the presenter view");
  });
});

describe("PresenterWindow", () => {
  /** The window with the show's state sent to it: the deck on its first slide unless told otherwise. */
  async function opened(state: { slide?: string; playing?: boolean } = {}) {
    const deck = deckFor(DECK_HTML);
    render(<PresenterWindow />);
    await act(async () => {});
    const send = (next: { slide?: string; playing?: boolean }) =>
      act(() =>
        listeners.get("presenter:state")?.({
          payload: { deck, slide: next.slide ?? deck.slides[0]?.id, playing: next.playing ?? false },
        }),
      );
    send(state);
    return { deck, send };
  }

  it("asks for the show and displays the slide, notes and next slide it is sent", async () => {
    const { deck } = await opened();
    expect(emit).toHaveBeenCalledWith("presenter:ready");
    expect(screen.getByRole("complementary")).toBeTruthy();
    expect(screen.getByText("Now")).toBeTruthy();
    expect(screen.getAllByText("Next").length).toBeGreaterThan(0);
    expect(screen.getByTestId("presenter-notes").textContent).toBe(deck.slides[0]?.notes || "No notes for this slide.");
  });

  it("has a row that operates the show: previous, next, play and end", async () => {
    const { send } = await opened();
    const row = screen.getByRole("toolbar", { name: "Show controls" });
    expect([...row.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Previous",
      "Next",
      "Play",
      "End show",
    ]);
    emit.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(emit).toHaveBeenLastCalledWith("presenter:key", { key: "ArrowLeft", shift: false });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(emit).toHaveBeenLastCalledWith("presenter:key", { key: "ArrowRight", shift: false });
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(emit).toHaveBeenLastCalledWith("presenter:play");
    // The show says it plays; the button turns to Pause.
    send({ playing: true });
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End show" }));
    expect(emit).toHaveBeenLastCalledWith("presenter:exit");
  });

  it("keeps the next slide's picture as the show moves on to it, loading only the one after", async () => {
    const { deck, send } = await opened();
    const [, next] = screen.getAllByTestId("fitted-slide");
    expect(next?.closest("div.flex-col")?.textContent).toContain("Next");
    send({ slide: deck.slides[1]?.id });
    const [now, after] = screen.getAllByTestId("fitted-slide");
    // The very element that was Next is Now: its page was not loaded again.
    expect(now).toBe(next);
    expect(now?.closest("div.flex-col")?.textContent).toContain("Now");
    expect(now?.querySelector("button")).toBeNull();
    expect(after).not.toBe(next);
    expect(after?.querySelector("button")?.getAttribute("aria-label")).toBe("Go to the next slide");
    // Going back, the slide on screen becomes the next one again, and stays as it is too.
    send({ slide: deck.slides[0]?.id });
    expect(screen.getAllByTestId("fitted-slide")[1]).toBe(now);
    // On the last slide there is no next one.
    send({ slide: deck.slides.at(-1)?.id });
    expect(screen.getAllByTestId("fitted-slide")).toHaveLength(1);
    expect(screen.getByText("The end of the show.")).toBeTruthy();
  });

  it("moves the show on when the next slide's picture is pressed", async () => {
    await opened();
    emit.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Go to the next slide" }));
    expect(emit).toHaveBeenCalledWith("presenter:key", { key: "ArrowRight", shift: false });
  });

  it("names its microphone buttons, where there is room for the words", async () => {
    await opened();
    expect(screen.getByRole("button", { name: /^Teleprompter/ }).textContent).toBe("Teleprompter");
    expect(screen.getByRole("button", { name: /narration as text/ }).textContent).toBe("Record text");
    expect(screen.getByRole("button", { name: /narration as audio/ }).textContent).toBe("Record audio");
  });

  it("reads the notes larger than the panel beside the slide does, at a size of its own", async () => {
    await opened();
    expect(screen.getByTestId("presenter-notes").className).toContain("text-2xl");
    fireEvent.click(screen.getByRole("button", { name: "Smaller notes" }));
    expect(screen.getByTestId("presenter-notes").className).toContain("text-xl");
    expect(JSON.parse(localStorage.getItem("slopslide.presenterNotesSize") ?? "{}")).toEqual({ panel: 1, window: 3 });
  });

  it("keeps the slide's time when the show moves on, and its clocks to itself", async () => {
    vi.useFakeTimers();
    try {
      const { deck, send } = await opened();
      act(() => void vi.advanceTimersByTime(30_000));
      expect(screen.getByRole("timer").textContent).toBe("0:30");
      send({ slide: deck.slides[1]?.id });
      act(() => void vi.advanceTimersByTime(5_000));
      expect(screen.getByTestId("slide-time").textContent).toBe("slide0:05");
      expect(screen.getByRole("timer").textContent).toBe("0:35");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sizes the slides by the room's height as well as its width", () => {
    expect(fitWidth({ width: 1920, height: 960 })).toBe("min(100cqw, 200cqh)");
    expect(fitWidth({ width: 1000, height: 2000 })).toBe("min(100cqw, 50cqh)");
  });

  it("sends the keys pressed in it to the show, Escape among them, and takes only those from the page", async () => {
    await opened();
    const press = (init: KeyboardEventInit, target: EventTarget = window) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      act(() => void target.dispatchEvent(event));
      return event;
    };
    expect(press({ key: "ArrowRight" }).defaultPrevented).toBe(true);
    expect(emit).toHaveBeenLastCalledWith("presenter:key", { key: "ArrowRight", shift: false });
    press({ key: " ", shiftKey: true });
    expect(emit).toHaveBeenLastCalledWith("presenter:key", { key: " ", shift: true });
    // The tools' keys go to the show too, and Escape puts a tool away there before it ends the show.
    press({ key: "l" });
    expect(emit).toHaveBeenLastCalledWith("presenter:key", { key: "l", shift: false });
    press({ key: "Escape" });
    expect(emit).toHaveBeenLastCalledWith("presenter:key", { key: "Escape", shift: false });
    expect(emit).not.toHaveBeenCalledWith("presenter:exit");
  });

  it("leaves keys with a modifier, and Tab, to the system", async () => {
    await opened();
    emit.mockClear();
    for (const init of [
      { key: "q", metaKey: true },
      { key: "w", ctrlKey: true },
      { key: "ArrowLeft", altKey: true },
      { key: "Tab" },
    ]) {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      act(() => void window.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps the keys typed in its own fields", async () => {
    await opened();
    fireEvent.click(screen.getByRole("button", { name: "Timer settings" }));
    emit.mockClear();
    fireEvent.keyDown(screen.getByLabelText("Total time in minutes"), { key: "5" });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("? lists the show's keys here, not on the audience's screen", async () => {
    await opened();
    emit.mockClear();
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(screen.getByRole("dialog", { name: "Keys while presenting" })).toBeTruthy();
    expect(emit).not.toHaveBeenCalled();
  });
});
