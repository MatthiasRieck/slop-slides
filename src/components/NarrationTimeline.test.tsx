import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { invoke } from "../test/tauri";

vi.mock("../lib/timelinePlayback", () => ({ playTimeline: vi.fn() }));

import type { Deck, RailEdit, Slide } from "../lib/api";
import { formatDuration } from "../lib/narrationAudio";
import { getSlideClock } from "../lib/slideClock";
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
  useApp.setState({ deck, selected: "intro" });
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
    const clip = screen.getByRole("button", { name: "Narration of intro" });
    expect(clip.style.left).not.toBe("");
    expect(clip.querySelector("path")?.getAttribute("d")).toBe("M0 0.5V1.5M1 0V2");
    expect(invoke).toHaveBeenCalledWith("narration_peaks", { id: deckOf().id, slide: "intro" });
  });

  it("shows when each word of timed audio is said", async () => {
    open();
    await act(async () => {});
    const clip = () => screen.getByRole("button", { name: "Narration of intro" });
    expect(clip().querySelector("[data-word]")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("narration_words", expect.anything());
    invoke.mockImplementation(async (command: string) => {
      if (command === "narration_peaks") return [0.5, 1];
      if (command === "narration_words")
        return [
          { text: "Hello,", start: 0.3, end: 0.9 },
          { text: "world.", start: 1.5, end: 2.4 },
        ];
      return null;
    });
    act(() => useNarration.setState({ audio: { intro: { slide: "intro", state: "ready", seconds: 3, timed: true } } }));
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("narration_words", { id: deckOf().id, slide: "intro" });
    const words = [...clip().querySelectorAll<HTMLElement>("[data-word]")];
    expect(words.map((w) => w.textContent)).toEqual(["Hello,", "world."]);
    // Each word starts where it is said and reaches to the next.
    expect(words.map((w) => [w.style.left, w.style.width])).toEqual([
      ["10%", "40%"],
      ["50%", "50%"],
    ]);

    // Out-of-date audio's words are not shown.
    act(() => useNarration.setState({ audio: { intro: { slide: "intro", state: "stale", seconds: 3, timed: true } } }));
    await act(async () => {});
    const stale = screen.getByRole("button", { name: "Narration of intro, out of date" });
    expect(stale.querySelector("[data-word]")).toBeNull();
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
    expect(screen.getByRole("button", { name: "Narration of intro, out of date" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Narration of outro, not spoken yet" })).toBeTruthy();
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

  it("changes only the slide whose edge moves with the arrow keys", async () => {
    open();
    fireEvent.keyDown(screen.getByRole("button", { name: "End of slide 1" }), { key: "ArrowRight", shiftKey: true });
    await act(async () => {});
    expect(timingCalls()).toEqual([
      { id: deckOf().id, timing: [{ slide: "intro", duration: 6, narrationStart: null }] },
    ]);
  });

  it("drags an edge, the slides after it following, saving once when it is let go", async () => {
    open({ intro: { narration: "Hello" }, outro: { narration: "Bye" } });
    const edge = screen.getByRole("button", { name: "End of slide 1" });
    const outro = screen.getByRole("button", { name: /^Narration of outro/ });
    const before = outro.style.left;
    fireEvent.pointerDown(edge, { clientX: 100, button: 0 });
    fireEvent.pointerMove(edge, { clientX: 101 });
    expect(screen.getByRole("button", { name: /^Narration of outro/ }).style.left).toBe(before);
    // Not wide yet in the test, so a pixel is the whole timeline.
    fireEvent.pointerMove(edge, { clientX: 110 });
    expect(screen.getByRole("button", { name: /^Narration of outro/ }).style.left).not.toBe(before);
    expect(timingCalls()).toEqual([]);
    fireEvent.pointerUp(edge, { clientX: 110 });
    await act(async () => {});
    expect(timingCalls()).toHaveLength(1);
    expect(timingCalls()[0].timing).toHaveLength(1);
    expect(timingCalls()[0].timing[0]).toMatchObject({ slide: "intro", narrationStart: null });
  });

  it("keeps a moved edge in place until it is saved", async () => {
    open();
    let saved = (_: RailEdit) => {};
    const edit = {
      deck: deckOf({ intro: { narration: "Hello", duration: 6 } }),
      previous: "a",
      source: "b",
      created: [],
    };
    invoke.mockImplementation((command: string) =>
      command === "set_slide_timing" ? new Promise<RailEdit>((resolve) => (saved = resolve)) : Promise.resolve([]),
    );
    const slide = () => screen.getByRole("button", { name: "Slide 2" }).parentElement?.style.left;
    const before = slide();
    fireEvent.keyDown(screen.getByRole("button", { name: "End of slide 1" }), { key: "ArrowRight", shiftKey: true });
    await act(async () => {});
    expect(slide()).not.toBe(before);
    expect(screen.getByText("0:00 / 0:16")).toBeTruthy();
    const moved = slide();
    await act(async () => saved(edit));
    expect(slide()).toBe(moved);
  });

  it("goes back when saving fails", async () => {
    open();
    const before = screen.getByRole("button", { name: "Slide 2" }).parentElement?.style.left;
    invoke.mockImplementation(async (command: string) => {
      if (command === "set_slide_timing") throw new Error("nope");
      return [];
    });
    fireEvent.keyDown(screen.getByRole("button", { name: "End of slide 1" }), { key: "ArrowRight", shiftKey: true });
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Slide 2" }).parentElement?.style.left).toBe(before);
    expect(useApp.getState().error).toContain("nope");
    useApp.setState({ error: null });
  });

  it("adds up arrow keys pressed faster than they are saved", async () => {
    open();
    const edge = screen.getByRole("button", { name: "End of slide 1" });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(edge, { key: "ArrowRight" });
    await act(async () => {});
    expect(timingCalls().at(-1).timing).toEqual([{ slide: "intro", duration: 5.5, narrationStart: null }]);
  });

  it("keeps what is dragged under the pointer, the track growing with the timeline", async () => {
    open();
    const scrolled = vi.fn();
    const edge = screen.getByRole("button", { name: "End of slide 1" });
    edge.scrollIntoView = scrolled;
    const line = screen.getByTestId("ruler").parentElement as HTMLElement;
    line.getBoundingClientRect = () => ({ width: 1500 }) as DOMRect;
    fireEvent.pointerDown(edge, { clientX: 100, button: 0 });
    fireEvent.pointerMove(edge, { clientX: 250 });
    fireEvent.pointerMove(edge, { clientX: 400 });
    // 300 of 1500 pixels is a fifth of 15 seconds, and 18 seconds are a fifth wider.
    expect(line.style.width).toBe("120%");
    expect(screen.getByText("0:00 / 0:18")).toBeTruthy();
    expect(scrolled).toHaveBeenCalled();
    fireEvent.pointerUp(edge, { clientX: 400 });
    await act(async () => {});
    expect(line.style.width).toBe("100%");
    expect(timingCalls()[0].timing[0].duration).toBe(8);
  });

  it("never shows the playhead past the end of a shorter timeline", async () => {
    open();
    const ruler = screen.getByTestId("ruler");
    ruler.getBoundingClientRect = () => ({ left: 0, width: 300 }) as DOMRect;
    fireEvent.pointerDown(ruler, { clientX: 300 });
    const edge = screen.getByRole("button", { name: "End of slide 2" });
    fireEvent.pointerDown(edge, { clientX: 100, button: 0 });
    fireEvent.pointerMove(edge, { clientX: 90 });
    expect(screen.getByText("0:11 / 0:11")).toBeTruthy();
    fireEvent.pointerUp(edge, { clientX: 90 });
    await act(async () => {});
  });

  it("only selects a slide when pressed: its length changes at its edge", async () => {
    open();
    const slide = screen.getByRole("button", { name: "Slide 3" });
    fireEvent.pointerDown(slide, { clientX: 100, button: 0 });
    fireEvent.pointerMove(slide, { clientX: 90 });
    fireEvent.pointerUp(slide, { clientX: 90 });
    fireEvent.keyDown(slide, { key: "ArrowLeft" });
    fireEvent.click(slide);
    await act(async () => {});
    expect(timingCalls()).toEqual([]);
    expect(useApp.getState().selected).toBe("outro");
  });

  it("moves a narration with the arrow keys, keeping its slide's length", async () => {
    open();
    fireEvent.keyDown(screen.getByRole("button", { name: "Narration of intro" }), { key: "ArrowRight" });
    await act(async () => {});
    expect(timingCalls()[0].timing).toEqual([{ slide: "intro", duration: 5, narrationStart: 0.6 }]);
  });

  it("drags a narration, stopping at the next, and a press that stays put saves nothing", async () => {
    open({ intro: { narration: "Hello" }, outro: { narration: "Bye" } });
    const clip = screen.getByRole("button", { name: "Narration of intro" });
    fireEvent.pointerDown(clip, { clientX: 100, button: 0 });
    fireEvent.pointerUp(clip, { clientX: 101 });
    expect(timingCalls()).toEqual([]);
    fireEvent.pointerDown(clip, { clientX: 100, button: 0 });
    fireEvent.pointerMove(clip, { clientX: 110 });
    fireEvent.pointerUp(clip, { clientX: 110 });
    await act(async () => {});
    // The next narration, of about a second, starts at 10.5.
    expect(timingCalls()[0].timing).toEqual([{ slide: "intro", duration: 5, narrationStart: 7.5 }]);
  });

  it("does not move the narration of a locked slide", () => {
    open({ intro: { narration: "Hello", locked: true } });
    expect((screen.getByRole("button", { name: "Narration of intro" }) as HTMLButtonElement).disabled).toBe(true);
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

  it("does not change locked slides, but lets the one before move them", () => {
    open({ "#2": { locked: true } });
    const edge = (n: number) => screen.getByRole("button", { name: `End of slide ${n}` }) as HTMLButtonElement;
    expect(edge(1).disabled).toBe(false);
    expect(edge(2).disabled).toBe(true);
  });

  it("keeps the track clear of the resize handles on either side of its panel", () => {
    open();
    expect(screen.getByTestId("ruler").parentElement?.parentElement?.className).toContain("mx-1.5");
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

  it("keeps the showing slide's animations with the playhead", () => {
    play.mockReturnValue(vi.fn());
    open();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    const [, timeline, , events] = play.mock.calls[0] as [
      string,
      { slides: { id: string; start: number }[] },
      number,
      { tick: (t: number) => void },
    ];
    const outro = timeline.slides.find((s) => s.id === "outro")!;
    act(() => events.tick(outro.start + 1.5));
    expect(getSlideClock()).toEqual({ slide: "outro", at: 1.5, playing: true });
    expect(screen.getByText(`${formatDuration(outro.start + 1.5)} / ${formatDuration(15)}`)).toBeTruthy();
    // Paused, it holds there.
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(getSlideClock()).toEqual({ slide: "outro", at: 1.5, playing: false });
    // Played to the end, the slides run on their own again.
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    act(() => (play.mock.calls[1]![3] as { ended: () => void }).ended());
    expect(getSlideClock()).toBeNull();
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
