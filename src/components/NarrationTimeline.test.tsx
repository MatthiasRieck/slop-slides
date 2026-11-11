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

/**
 * Three five-second slides by default; the first has narration of three seconds. In Edit mode,
 * where the timing changes, unless `editing` says View.
 */
function open(changes: Record<string, Partial<Slide>> = { intro: { narration: "Hello" } }, editing = true) {
  const deck = deckOf(changes);
  useApp.setState({ deck, selected: "intro", editing });
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

/** The same in View mode, which only plays and scrubs. */
const watch = (changes?: Record<string, Partial<Slide>>) => open(changes, false);

const timingCalls = () =>
  invoke.mock.calls.filter(([command]: unknown[]) => command === "set_slide_timing").map(([, a]) => a);

beforeEach(() => {
  invoke.mockReset();
  play.mockReset();
  localStorage.clear();
});

afterEach(() => {
  useApp.setState({ deck: null, selected: null, editing: false, comments: {} });
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

  it("moves the playhead from the ruler, the stage following, frozen at that moment", () => {
    watch();
    const ruler = screen.getByTestId("ruler");
    ruler.getBoundingClientRect = () => ({ left: 0, width: 300 }) as DOMRect;
    fireEvent.pointerDown(ruler, { clientX: 150 });
    expect(useApp.getState().selected).toBe("#2");
    expect(screen.getByTestId("playhead").style.left).toBe("50%");
    expect(screen.getByText("0:08 / 0:15")).toBeTruthy();
    // The second slide starts at 5 s: it shows as it is 2.5 s in, and stays so.
    expect(getSlideClock()).toEqual({ slide: "#2", at: 2.5, paused: true });
  });

  it("scrubs along the ruler while the button is down, and not past its ends", () => {
    watch();
    const ruler = screen.getByTestId("ruler");
    ruler.getBoundingClientRect = () => ({ left: 0, width: 300 }) as DOMRect;
    // Passing over it without pressing moves nothing.
    fireEvent.pointerMove(ruler, { clientX: 150, buttons: 0 });
    expect(getSlideClock()).toBeNull();
    fireEvent.pointerDown(ruler, { clientX: 20, button: 2 });
    expect(getSlideClock()).toBeNull();
    fireEvent.pointerDown(ruler, { clientX: 20 });
    expect(getSlideClock()).toEqual({ slide: "intro", at: 1, paused: true });
    fireEvent.pointerMove(ruler, { clientX: 220, buttons: 1 });
    expect(getSlideClock()).toEqual({ slide: "outro", at: 1, paused: true });
    expect(useApp.getState().selected).toBe("outro");
    fireEvent.pointerMove(ruler, { clientX: -50, buttons: 1 });
    expect(getSlideClock()).toEqual({ slide: "intro", at: 0, paused: true });
    expect(screen.getByTestId("playhead").style.left).toBe("0%");
  });

  it("has step back, play and step forward together in the middle of the bar", () => {
    open();
    const transport = screen.getByTestId("transport");
    expect([...transport.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(
      ["Step back", "Play", "Step forward"],
    );
    const bar = transport.parentElement!;
    expect(bar.className).toContain("grid-cols-[1fr_auto_1fr]");
    expect([...bar.children].indexOf(transport)).toBe(1);
  });

  it("steps a tenth of a second back and forward, a second with Shift, the slide frozen there", () => {
    const stop = vi.fn();
    play.mockReturnValue(stop);
    watch();
    const back = screen.getByRole("button", { name: "Step back" }) as HTMLButtonElement;
    const forward = screen.getByRole("button", { name: "Step forward" }) as HTMLButtonElement;
    const at = () => getSlideClock()?.at.toFixed(1);
    expect(back.disabled).toBe(true);
    fireEvent.click(forward);
    expect(getSlideClock()).toMatchObject({ slide: "intro", paused: true });
    expect(at()).toBe("0.1");
    fireEvent.click(forward, { shiftKey: true });
    expect(at()).toBe("1.1");
    expect(back.disabled).toBe(false);
    fireEvent.click(back);
    expect(at()).toBe("1.0");
    // Across a slide change, the stage follows.
    const ruler = screen.getByTestId("ruler");
    ruler.getBoundingClientRect = () => ({ left: 0, width: 300 }) as DOMRect;
    fireEvent.pointerDown(ruler, { clientX: 100 });
    expect(getSlideClock()).toEqual({ slide: "#2", at: 0, paused: true });
    fireEvent.click(back);
    expect(getSlideClock()).toMatchObject({ slide: "intro", paused: true });
    expect(at()).toBe("4.9");
    expect(useApp.getState().selected).toBe("intro");
    // Not before the start or past the end.
    fireEvent.pointerDown(ruler, { clientX: 300 });
    expect(forward.disabled).toBe(true);
    fireEvent.pointerDown(ruler, { clientX: 0 });
    fireEvent.click(back, { shiftKey: true });
    expect(at()).toBe("0.0");
    // Stepping while it plays stops it there.
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    fireEvent.click(forward);
    expect(stop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(at()).toBe("0.1");
  });

  it("does not change locked slides, but lets the one before move them", () => {
    open({ "#2": { locked: true } });
    const edge = (n: number) => screen.getByRole("button", { name: `End of slide ${n}` }) as HTMLButtonElement;
    expect(edge(1).disabled).toBe(false);
    expect(edge(2).disabled).toBe(true);
  });

  it("changes no timing in View: the edges and the narration stay put, and nothing resets", () => {
    watch({ intro: { narration: "Hello", duration: 2, narrationStart: 1 } });
    const edge = screen.getByRole("button", { name: "End of slide 1" }) as HTMLButtonElement;
    const clip = screen.getByRole("button", { name: "Narration of intro" }) as HTMLButtonElement;
    expect([edge.disabled, clip.disabled]).toEqual([true, true]);
    expect(edge.title).toBe("Switch to Edit to change the timing");
    expect(screen.queryByRole("button", { name: "Reset timing" })).toBeNull();
    // Where a disabled button still hears the pointer or a key, they move nothing either.
    for (const handle of [edge, clip]) {
      fireEvent.pointerDown(handle, { clientX: 100 });
      fireEvent.pointerMove(handle, { clientX: 160 });
      fireEvent.pointerUp(handle);
      fireEvent.keyDown(handle, { key: "ArrowRight" });
    }
    expect(timingCalls()).toEqual([]);
    // Edit mode has them back.
    act(() => useApp.setState({ editing: true }));
    expect([edge.disabled, clip.disabled]).toEqual([false, false]);
    expect(screen.getByRole("button", { name: "Reset timing" })).toBeTruthy();
  });

  it("leaves the stage to the editor in Edit: scrubbing moves the playhead without freezing the slide", () => {
    open();
    const ruler = screen.getByTestId("ruler");
    ruler.getBoundingClientRect = () => ({ left: 0, width: 300 }) as DOMRect;
    fireEvent.pointerDown(ruler, { clientX: 150 });
    expect(useApp.getState().selected).toBe("#2");
    expect(screen.getByTestId("playhead").style.left).toBe("50%");
    expect(getSlideClock()).toBeNull();
    // Back in View the stage is at the playhead again, and entering Edit hands it back.
    act(() => useApp.setState({ editing: false }));
    expect(getSlideClock()).toEqual({ slide: "#2", at: 2.5, paused: true });
    act(() => useApp.setState({ editing: true }));
    expect(getSlideClock()).toBeNull();
  });

  it("plays in Edit too, and gives the stage back when paused", () => {
    play.mockReturnValue(vi.fn());
    open();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    const events = play.mock.calls[0]?.[3] as { tick: (t: number) => void };
    act(() => events.tick(1.5));
    expect(getSlideClock()).toEqual({ slide: "intro", at: 1.5 });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(getSlideClock()).toBeNull();
    expect(screen.getByText(`0:02 / ${formatDuration(15)}`)).toBeTruthy();
  });

  it("folds away from its own bar", () => {
    useApp.setState({ timelineOpen: true });
    watch();
    fireEvent.click(screen.getByRole("button", { name: "Hide timeline" }));
    expect(useApp.getState().timelineOpen).toBe(false);
  });

  describe("comments made at a moment", () => {
    const comment = (id: string, time?: number) => ({ id, text: `About ${id}`, x: 0.5, y: 0.5, time });
    const marks = () => screen.queryAllByTestId("comment-mark");

    it("marks them on the ruler, and goes back to their moment when pressed", () => {
      useApp.setState({
        reviewVisible: true,
        comments: { "#2": [comment("whenever"), comment("then", 2.5)], intro: [comment("early", 1)] },
      });
      watch();
      // Only those made at a moment, in the order they come; the slides are 5 s each of 15 s.
      expect(marks().map((m) => m.getAttribute("aria-label"))).toEqual([
        "Comment 1 on slide 1",
        "Comment 2 on slide 2",
      ]);
      expect(marks().map((m) => m.style.left)).toEqual([`${(1 / 15) * 100}%`, "50%"]);
      expect(marks()[1]!.title).toBe("Comment 2 on slide 2: About then");
      // They lie over the ruler, not in it: a press on one is not a press on the ruler.
      expect(screen.getByTestId("ruler").contains(marks()[1]!)).toBe(false);
      fireEvent.click(marks()[1]!);
      expect(useApp.getState().selected).toBe("#2");
      expect(getSlideClock()).toEqual({ slide: "#2", at: 2.5, paused: true });
      expect(screen.getByTestId("playhead").style.left).toBe("50%");
    });

    it("keeps a mark within its slide when the slide has since got shorter, and hides them with the review", () => {
      useApp.setState({ reviewVisible: true, comments: { intro: [comment("late", 60)] } });
      watch();
      expect(marks().map((m) => m.style.left)).toEqual([`${(5 / 15) * 100}%`]);
      act(() => useApp.setState({ reviewVisible: false }));
      expect(marks()).toEqual([]);
    });
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
    watch();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    const [, timeline, , events] = play.mock.calls[0] as [
      string,
      { slides: { id: string; start: number }[] },
      number,
      { tick: (t: number) => void },
    ];
    const outro = timeline.slides.find((s) => s.id === "outro")!;
    act(() => events.tick(outro.start + 1.5));
    expect(getSlideClock()).toEqual({ slide: "outro", at: 1.5 });
    expect(screen.getByText(`${formatDuration(outro.start + 1.5)} / ${formatDuration(15)}`)).toBeTruthy();
    // Paused, the slide stays frozen where it got to.
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(getSlideClock()).toEqual({ slide: "outro", at: 1.5, paused: true });
    // Playing on from there runs it again.
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(play.mock.calls[1]![2]).toBe(outro.start + 1.5);
    act(() => (play.mock.calls[1]![3] as { tick: (t: number) => void }).tick(outro.start + 2));
    expect(getSlideClock()).toEqual({ slide: "outro", at: 2 });
    // Played to the end, the slides run on their own again.
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

describe("the slides as strips of film", () => {
  const sizes: Record<string, [string, number]> = {
    track: ["clientWidth", 1500],
    scroller: ["clientWidth", 600],
    filmstrip: ["clientHeight", 90],
  };
  const descriptors = ["clientWidth", "clientHeight"].map(
    (name) => [name, Object.getOwnPropertyDescriptor(Element.prototype, name)] as const,
  );

  /** The track 1500 pixels wide with 600 of them in sight, and slides 90 pixels tall: pictures of 160. */
  beforeEach(() => {
    for (const name of ["clientWidth", "clientHeight"]) {
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        get(this: HTMLElement) {
          const kind =
            this.dataset.testid === "filmstrip"
              ? "filmstrip"
              : this.className.includes("overflow-x-auto")
                ? "scroller"
                : "track";
          const [measure, size] = sizes[kind] ?? ["", 0];
          return measure === name ? size : 0;
        },
      });
    }
  });

  afterEach(() => {
    for (const [name, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(Element.prototype, name, descriptor);
  });

  const frames = (n: number) =>
    [...screen.getByRole("button", { name: `Slide ${n}` }).querySelectorAll<HTMLElement>("[data-frame]")].map((f) => [
      f.dataset.frame,
      f.style.left,
      f.style.width,
    ]);

  it("fills each slide with its picture, over and over, as far as is in sight", () => {
    open();
    // Three slides of 500 pixels each: the first shows whole, the second up to the 800th pixel.
    expect(frames(1)).toEqual([
      ["0", "0px", "160px"],
      ["1", "160px", "160px"],
      ["2", "320px", "160px"],
      ["3", "480px", "160px"],
    ]);
    expect(frames(2)).toEqual([
      ["0", "0px", "160px"],
      ["1", "160px", "160px"],
    ]);
    expect(frames(3)).toEqual([]);
    // Each slide says which it is, over its pictures.
    expect(screen.getByRole("button", { name: "Slide 2" }).textContent).toBe("2");
  });

  it("shows the pictures scrolled to", () => {
    open();
    const scroller = screen.getByTestId("ruler").parentElement?.parentElement as HTMLElement;
    Object.defineProperty(scroller, "scrollLeft", { configurable: true, value: 900 });
    fireEvent.scroll(scroller);
    expect(frames(1)).toEqual([]);
    expect(frames(2).map(([frame]) => frame)).toEqual(["1", "2", "3"]);
    expect(frames(3).map(([frame]) => frame)).toEqual(["0", "1", "2", "3"]);
  });

  it("has no pictures before the track is measured", () => {
    sizes.filmstrip = ["clientHeight", 0];
    open();
    expect(frames(1)).toEqual([]);
    sizes.filmstrip = ["clientHeight", 90];
  });
});
