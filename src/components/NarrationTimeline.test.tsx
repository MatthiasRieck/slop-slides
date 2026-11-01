import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("../lib/timelinePlayback", () => ({ playTimeline: vi.fn() }));

import type { Deck, RailEdit, Slide } from "../lib/api";
import { formatDuration } from "../lib/narrationAudio";
import { playTimeline } from "../lib/timelinePlayback";
import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { NarrationTimeline, rulerStep } from "./NarrationTimeline";

const play = playTimeline as unknown as Mock;

function deckOf(changes: Record<string, Partial<Slide>> = {}): Deck {
  const deck = deckFor(DECK_HTML);
  return { ...deck, slides: deck.slides.map((s) => ({ ...s, ...changes[s.id] })) };
}

/** Three five-second slides by default; the first has narration of three seconds. */
function open(changes: Record<string, Partial<Slide>> = { intro: { narration: "Hello" } }) {
  const deck = deckOf(changes);
  useApp.setState({ deck, selected: "intro", deckUndo: [], deckRedo: [] });
  useNarration.setState({
    audioDeck: deck.id,
    audio: { intro: { slide: "intro", state: "ready", seconds: 3 } },
  });
  invoke.mockImplementation(async (command: string) => {
    if (command === "narration_peaks") return [0.5, 1];
    if (command === "set_slide_timing") return { deck, previous: "a", source: "b", created: [] } satisfies RailEdit;
    return null;
  });
  return render(<NarrationTimeline />);
}

const timingCalls = () =>
  invoke.mock.calls.filter(([command]: unknown[]) => command === "set_slide_timing").map(([, a]) => a);

beforeEach(() => {
  invoke.mockReset();
  play.mockReset();
  localStorage.clear();
});

afterEach(() => {
  useApp.setState({ deck: null, selected: null });
  useNarration.setState({ audio: {}, audioDeck: null });
});

describe("NarrationTimeline", () => {
  it("shows the slides above the audio, with its waveform", async () => {
    open();
    await act(async () => {});
    for (const n of [1, 2, 3]) expect(screen.getByRole("button", { name: `Slide ${n}` })).toBeTruthy();
    const clip = screen.getByRole("img", { name: "Narration of intro" });
    expect(clip.style.left).not.toBe("");
    expect(clip.querySelector("path")?.getAttribute("d")).toBe("M0 0.5V1.5M1 0V2");
    expect(invoke).toHaveBeenCalledWith("narration_peaks", { id: deckOf().id, slide: "intro" });
  });

  it("marks narration not spoken yet and out-of-date audio", async () => {
    open({ intro: { narration: "Hello" }, outro: { narration: "Bye" } });
    act(() =>
      useNarration.setState({
        audio: {
          intro: { slide: "intro", state: "stale", seconds: 3 },
          outro: { slide: "outro", state: "missing", seconds: null },
        },
      }),
    );
    await act(async () => {});
    expect(screen.getByRole("img", { name: "Narration of intro, out of date" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Narration of outro, not spoken yet" })).toBeTruthy();
  });

  it("leaves hidden slides out, as the video does", () => {
    open({ "#2": { hidden: true } });
    expect(screen.queryByRole("button", { name: "Slide 3" })).toBeNull();
  });

  it("shows nothing when every slide is hidden", () => {
    const { container } = open({
      intro: { hidden: true },
      "#2": { hidden: true },
      outro: { hidden: true },
    });
    expect(container.textContent).toBe("");
  });

  it("selects a slide when it is clicked", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Slide 2" }));
    expect(useApp.getState().selected).toBe("#2");
    expect(screen.getByRole("button", { name: "Slide 2" }).getAttribute("aria-current")).toBe("true");
  });

  it("moves the edge between two slides with the arrow keys, keeping the audio in place", async () => {
    open();
    fireEvent.keyDown(screen.getByRole("button", { name: "End of slide 1" }), { key: "ArrowRight", shiftKey: true });
    await act(async () => {});
    expect(timingCalls()).toEqual([
      {
        id: deckOf().id,
        timing: [
          { slide: "intro", duration: 6, narrationStart: 0.5 },
          { slide: "#2", duration: 4, narrationStart: null },
        ],
      },
    ]);
    expect(useApp.getState().deckUndo).toHaveLength(1);
  });

  it("moves a slide across the audio with the arrow keys", async () => {
    open();
    fireEvent.keyDown(screen.getByRole("button", { name: "Slide 2" }), { key: "ArrowLeft" });
    await act(async () => {});
    expect(timingCalls()[0].timing).toEqual([
      { slide: "intro", duration: 4.9, narrationStart: 0.5 },
      { slide: "#2", duration: 5, narrationStart: null },
      { slide: "outro", duration: 5.1, narrationStart: null },
    ]);
  });

  it("drags an edge across the audio, saving once when it is let go", async () => {
    open();
    const edge = screen.getByRole("button", { name: "End of slide 1" });
    fireEvent.pointerDown(edge, { clientX: 100, button: 0 });
    // Not wide yet in the test, so a pixel is the whole timeline: it stops at the shortest slide.
    fireEvent.pointerMove(edge, { clientX: 101 });
    fireEvent.pointerMove(edge, { clientX: 110 });
    expect(timingCalls()).toEqual([]);
    fireEvent.pointerUp(edge, { clientX: 110 });
    await act(async () => {});
    expect(timingCalls()).toHaveLength(1);
    expect(timingCalls()[0].timing).toEqual([
      { slide: "intro", duration: 9.5, narrationStart: 0.5 },
      { slide: "#2", duration: 0.5, narrationStart: null },
    ]);
  });

  it("drags a slide, but a press that stays put only selects it", async () => {
    open();
    const slide = screen.getByRole("button", { name: "Slide 3" });
    fireEvent.pointerDown(slide, { clientX: 100, button: 0 });
    fireEvent.pointerUp(slide, { clientX: 101 });
    fireEvent.click(slide);
    expect(timingCalls()).toEqual([]);
    expect(useApp.getState().selected).toBe("outro");
    fireEvent.pointerDown(slide, { clientX: 100, button: 0 });
    fireEvent.pointerMove(slide, { clientX: 90 });
    fireEvent.pointerUp(slide, { clientX: 90 });
    await act(async () => {});
    expect(timingCalls()[0].timing).toEqual([
      { slide: "#2", duration: 0.5, narrationStart: null },
      { slide: "outro", duration: 5, narrationStart: null },
    ]);
  });

  it("ignores a press with another button", () => {
    open();
    const edge = screen.getByRole("button", { name: "End of slide 1" });
    fireEvent.pointerDown(edge, { clientX: 100, button: 2 });
    fireEvent.pointerMove(edge, { clientX: 150 });
    fireEvent.pointerUp(edge, { clientX: 150 });
    expect(timingCalls()).toEqual([]);
  });

  it("moves the playhead from the ruler, the stage following", () => {
    open();
    const ruler = screen.getByTestId("ruler");
    ruler.getBoundingClientRect = () => ({ left: 0, width: 300 }) as DOMRect;
    fireEvent.pointerDown(ruler, { clientX: 150 });
    expect(useApp.getState().selected).toBe("#2");
    expect(screen.getByTestId("playhead").style.left).toBe("50%");
    expect(screen.getByText("0:08 / 0:15")).toBeTruthy();
  });

  it("does not move locked slides or their neighbours", () => {
    open({ "#2": { locked: true } });
    const edge = screen.getByRole("button", { name: "End of slide 1" }) as HTMLButtonElement;
    expect(edge.disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("button", { name: "Slide 3" }), { key: "ArrowLeft" });
    expect(timingCalls()).toEqual([]);
  });

  it("keeps the last edge inside the track, so a track that fits does not scroll", () => {
    open();
    expect(screen.getByRole("button", { name: "End of slide 1" }).className).toContain("-right-1");
    expect(screen.getByRole("button", { name: "End of slide 3" }).className).toContain("right-0");
  });

  it("leaves other keys alone", () => {
    open();
    fireEvent.keyDown(screen.getByRole("button", { name: "End of slide 1" }), { key: "Tab" });
    expect(timingCalls()).toEqual([]);
  });

  it("offers to reset the timing only when there is some", async () => {
    const { unmount } = open();
    expect(screen.queryByRole("button", { name: "Reset timing" })).toBeNull();
    unmount();
    open({ intro: { duration: 2, narrationStart: 1 }, "#2": { locked: true, duration: 2 } });
    fireEvent.click(screen.getByRole("button", { name: "Reset timing" }));
    await act(async () => {});
    expect(timingCalls()[0].timing).toEqual([{ slide: "intro", duration: null, narrationStart: null }]);
  });

  it("plays from the playhead, the stage following the slides, and pauses", () => {
    const stop = vi.fn();
    play.mockReturnValue(stop);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    const [deck, timeline, from, events] = play.mock.calls[0] as [
      string,
      unknown,
      number,
      { slide: (i: number) => void },
    ];
    expect(deck).toBe(deckOf().id);
    expect(timeline).toMatchObject({ end: 15 });
    expect(from).toBe(0);
    act(() => events.slide(2));
    expect(useApp.getState().selected).toBe("outro");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(stop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("goes back to the start when it ends", () => {
    play.mockReturnValue(vi.fn());
    open();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    const events = play.mock.calls[0]?.[3] as { ended: () => void };
    act(() => events.ended());
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(screen.getByText(`0:00 / ${formatDuration(15)}`)).toBeTruthy();
  });

  it("stops playing when the deck changes or it goes away", () => {
    const stop = vi.fn();
    play.mockReturnValue(stop);
    const { unmount } = open();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    act(() => useApp.setState({ deck: deckOf({ intro: { narration: "Hello again" } }) }));
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    unmount();
  });

  it("zooms in steps", () => {
    open();
    const out = screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement;
    expect(out.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(out.disabled).toBe(false);
  });
});

describe("rulerStep", () => {
  it("picks a round step for about a dozen marks", () => {
    expect(rulerStep(10)).toBe(1);
    expect(rulerStep(60)).toBe(5);
    expect(rulerStep(600)).toBe(60);
    expect(rulerStep(100_000)).toBe(1200);
  });
});
