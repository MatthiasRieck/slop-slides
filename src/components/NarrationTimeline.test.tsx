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
import { lastError } from "../store/errors";
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
    const clip = screen.getByRole("button", { name: "Narration of slide 1" });
    expect(clip.style.left).not.toBe("");
    expect(clip.querySelector("path")?.getAttribute("d")).toBe("M0 0.5V1.5M1 0V2");
    expect(invoke).toHaveBeenCalledWith("narration_peaks", { id: deckOf().id, slide: "intro" });
  });

  it("shows when each word of timed audio is said", async () => {
    open();
    await act(async () => {});
    const clip = () => screen.getByRole("button", { name: "Narration of slide 1" });
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
    const stale = screen.getByRole("button", { name: "Narration of slide 1, out of date" });
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
    expect(screen.getByRole("button", { name: "Narration of slide 1, out of date" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Narration of slide 3, not spoken yet" })).toBeTruthy();
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
    const outro = screen.getByRole("button", { name: /^Narration of slide 3/ });
    const before = outro.style.left;
    fireEvent.pointerDown(edge, { clientX: 100, button: 0 });
    fireEvent.pointerMove(edge, { clientX: 101 });
    expect(screen.getByRole("button", { name: /^Narration of slide 3/ }).style.left).toBe(before);
    // Not wide yet in the test, so a pixel is the whole timeline.
    fireEvent.pointerMove(edge, { clientX: 110 });
    expect(screen.getByRole("button", { name: /^Narration of slide 3/ }).style.left).not.toBe(before);
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
    expect(screen.getByText("0:00.0 / 0:16")).toBeTruthy();
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
    expect(lastError(useApp.getState())).toContain("nope");
    useApp.setState({ toasts: [] });
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
    expect(screen.getByText("0:00.0 / 0:18")).toBeTruthy();
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
    // The playhead was at 0:15; the timeline now ends before that, and the playhead with it.
    const [at, end] = screen.getByTestId("timeline-time").textContent!.split(" / ");
    expect(end).toBe("0:11");
    expect(at).toMatch(/^0:1[01]\.\d$/);
    expect(Number(at!.slice(2))).toBeLessThanOrEqual(11);
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
    fireEvent.keyDown(screen.getByRole("button", { name: "Narration of slide 1" }), { key: "ArrowRight" });
    await act(async () => {});
    expect(timingCalls()[0].timing).toEqual([{ slide: "intro", duration: 5, narrationStart: 0.6 }]);
  });

  it("drags a narration, stopping at the next, and a press that stays put saves nothing", async () => {
    open({ intro: { narration: "Hello" }, outro: { narration: "Bye" } });
    const clip = screen.getByRole("button", { name: "Narration of slide 1" });
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
    expect((screen.getByRole("button", { name: "Narration of slide 1" }) as HTMLButtonElement).disabled).toBe(true);
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
    expect(screen.getByText("0:07.5 / 0:15")).toBeTruthy();
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

  it("has back to start, step back, play and step forward together in the middle of the bar", () => {
    open();
    const transport = screen.getByTestId("transport");
    expect([...transport.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(
      ["Back to start", "Step back", "Play", "Step forward"],
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
    const clip = screen.getByRole("button", { name: "Narration of slide 1" }) as HTMLButtonElement;
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
    expect(screen.getByText(`0:01.5 / ${formatDuration(15)}`)).toBeTruthy();
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
    expect(screen.getByText(`0:00.0 / ${formatDuration(15)}`)).toBeTruthy();
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
    // Each slide says which it is and how long it shows, over its pictures.
    expect(screen.getByRole("button", { name: "Slide 2" }).textContent).toBe("25.0s");
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

describe("NarrationTimeline: keys", () => {
  const ruler = () => screen.getByTestId("ruler");
  const time = () => screen.getByTestId("timeline-time").textContent;
  const press = (target: Element, init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => void target.dispatchEvent(event));
    return event;
  };

  it("the ruler is a slider that says where the playhead is", () => {
    watch();
    expect(ruler().getAttribute("role")).toBe("slider");
    expect(ruler().tabIndex).toBe(0);
    expect(ruler().getAttribute("aria-label")).toBe("Playhead");
    expect(ruler().getAttribute("aria-valuemin")).toBe("0");
    expect(ruler().getAttribute("aria-valuemax")).toBe("15");
    expect(ruler().getAttribute("aria-valuenow")).toBe("0");
    expect(ruler().getAttribute("aria-valuetext")).toBe("0:00.0 of 0:15, slide 1");
    press(ruler(), { key: "End" });
    expect(ruler().getAttribute("aria-valuenow")).toBe("15");
    expect(ruler().getAttribute("aria-valuetext")).toBe("0:15.0 of 0:15, slide 3");
  });

  it("steps a tenth of a second with the arrows, a second with Shift, and shows it to the tenth", () => {
    watch();
    expect(time()).toBe("0:00.0 / 0:15");
    expect(press(ruler(), { key: "ArrowRight" }).defaultPrevented).toBe(true);
    expect(time()).toBe("0:00.1 / 0:15");
    expect(getSlideClock()).toEqual({ slide: "intro", at: 0.1, paused: true });
    press(ruler(), { key: "ArrowRight", shiftKey: true });
    expect(time()).toBe("0:01.1 / 0:15");
    press(ruler(), { key: "ArrowLeft" });
    expect(time()).toBe("0:01.0 / 0:15");
    press(ruler(), { key: "ArrowLeft", shiftKey: true });
    press(ruler(), { key: "ArrowLeft", shiftKey: true });
    expect(time()).toBe("0:00.0 / 0:15");
  });

  it("goes to the ends with Home and End", () => {
    watch();
    press(ruler(), { key: "End" });
    expect(time()).toBe("0:15.0 / 0:15");
    expect(useApp.getState().selected).toBe("outro");
    press(ruler(), { key: "Home" });
    expect(time()).toBe("0:00.0 / 0:15");
    expect(useApp.getState().selected).toBe("intro");
  });

  it("plays and pauses with Space, also from a slide's block, without pressing it", () => {
    play.mockReturnValue(vi.fn());
    watch();
    expect(press(ruler(), { key: " " }).defaultPrevented).toBe(true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    // Playing, the time shows in whole seconds, as it runs.
    expect(time()).toBe("0:00 / 0:15");
    const block = screen.getByRole("button", { name: "Slide 3" });
    expect(press(block, { key: " " }).defaultPrevented).toBe(true);
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(useApp.getState().selected).toBe("intro");
  });

  it("keeps the keys from the rest of the app", () => {
    watch();
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    for (const key of [" ", "ArrowLeft", "ArrowRight", "Home", "End"]) press(ruler(), { key });
    expect(seen).not.toHaveBeenCalled();
    // Other keys, and these with a modifier, pass through.
    press(ruler(), { key: "a" });
    press(ruler(), { key: "ArrowRight", metaKey: true });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(time()).toBe("0:15.0 / 0:15");
    window.removeEventListener("keydown", seen);
  });

  it("leaves Space and the arrows alone on the buttons of its bar, and anywhere else", () => {
    play.mockReturnValue(vi.fn());
    watch();
    const zoom = screen.getByRole("button", { name: "Zoom in" });
    expect(press(zoom, { key: " " }).defaultPrevented).toBe(false);
    expect(press(zoom, { key: "ArrowRight" }).defaultPrevented).toBe(false);
    expect(press(document.body, { key: " " }).defaultPrevented).toBe(false);
    expect(press(document.body, { key: "ArrowRight" }).defaultPrevented).toBe(false);
    expect(play).not.toHaveBeenCalled();
    expect(time()).toBe("0:00.0 / 0:15");
  });

  it("leaves the arrows to an edge or a narration being moved, in Edit", async () => {
    open();
    fireEvent.keyDown(screen.getByRole("button", { name: "End of slide 1" }), { key: "ArrowRight" });
    await act(async () => {});
    expect(timingCalls()).toHaveLength(1);
    // The edge moved; the playhead did not.
    expect(time()).toMatch(/^0:00\.0 \//);
  });

  it("has a button back to the start, and names the keys in its tooltips", () => {
    watch();
    const back = screen.getByRole("button", { name: "Back to start" }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    press(ruler(), { key: "End" });
    expect(back.disabled).toBe(false);
    expect(back.title).toBe("Back to the start (Home)");
    fireEvent.click(back);
    expect(time()).toBe("0:00.0 / 0:15");
    expect(screen.getByRole("button", { name: "Play" }).title).toBe("Play from the playhead (Space)");
    expect(screen.getByRole("button", { name: "Step back" }).title).toMatch(/\(←\)$/);
    expect(screen.getByRole("button", { name: "Step forward" }).title).toMatch(/\(→\)$/);
  });
});

describe("NarrationTimeline: finding one's way", () => {
  const time = () => screen.getByTestId("timeline-time").textContent;

  it("moves the playhead to the start of a slide that is pressed, so Play starts there", () => {
    play.mockReturnValue(vi.fn());
    watch();
    fireEvent.click(screen.getByRole("button", { name: "Slide 3" }));
    expect(useApp.getState().selected).toBe("outro");
    expect(time()).toBe("0:10.0 / 0:15");
    expect(screen.getByTestId("playhead").style.left).toBe(`${(10 / 15) * 100}%`);
    // The slide shows as it does anywhere, not frozen before its first animation.
    expect(getSlideClock()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(play.mock.calls[0]?.[2]).toBe(10);
  });

  it("plays on from a slide pressed while it plays", () => {
    const stops: Mock[] = [];
    play.mockImplementation(() => {
      stops.push(vi.fn());
      return stops.at(-1);
    });
    watch();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    fireEvent.click(screen.getByRole("button", { name: "Slide 2" }));
    expect(stops[0]).toHaveBeenCalled();
    expect(stops[1]).not.toHaveBeenCalled();
    expect(play).toHaveBeenCalledTimes(2);
    expect(play.mock.calls[1]?.[2]).toBe(5);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("says how long each slide shows, live while its edge is dragged", () => {
    open();
    const seconds = () => [...screen.getAllByTestId("slide-seconds")].map((el) => el.textContent);
    expect(seconds()).toEqual(["5.0s", "5.0s", "5.0s"]);
    const line = screen.getByRole("button", { name: "End of slide 1" }).closest(".relative.flex") as HTMLElement;
    line.getBoundingClientRect = () => ({ left: 0, width: 300 }) as DOMRect;
    const edge = screen.getByRole("button", { name: "End of slide 1" });
    fireEvent.pointerDown(edge, { clientX: 100, button: 0 });
    fireEvent.pointerMove(edge, { clientX: 140 });
    // 40 of 300 pixels over 15 seconds: two seconds more, before it is let go.
    expect(seconds()).toEqual(["7.0s", "5.0s", "5.0s"]);
    expect(timingCalls()).toEqual([]);
    expect(screen.getByRole("button", { name: "Slide 1" }).title).toMatch(/^Slide 1, shown for 7\.0s/);
    fireEvent.pointerCancel(edge);
  });

  it("names a narration by its slide's number, not its id", async () => {
    open({ intro: { narration: "Hello" }, outro: { narration: "Bye" } });
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Narration of slide 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Narration of slide 3/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Narration of (intro|outro)/ })).toBeNull();
  });

  it("says where narration comes from when there is none", () => {
    const view = open({});
    expect(screen.getByTestId("no-narration").textContent).toBe("No narration yet. Write it in the Narration tab.");
    view.unmount();
    open();
    expect(screen.queryByTestId("no-narration")).toBeNull();
  });

  it("says what its zoom buttons do, and why one cannot", () => {
    watch();
    const out = screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement;
    const zoomIn = screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement;
    expect(out.disabled).toBe(true);
    expect(out.title).toBe("The whole timeline is in sight");
    expect(zoomIn.title).toBe("Zoom in, around the playhead");
    for (let i = 0; i < 4; i++) fireEvent.click(zoomIn);
    expect(zoomIn.disabled).toBe(true);
    expect(zoomIn.title).toBe("Zoomed in all the way");
    expect(out.title).toBe("Zoom out");
  });

  describe("zoomed in", () => {
    /** A panel 400 pixels wide, whose track is as wide as its zoom says. */
    function sized() {
      const scroller = screen.getByTestId("ruler").parentElement!.parentElement!;
      const track = screen.getByTestId("ruler").parentElement!;
      Object.defineProperty(scroller, "clientWidth", { configurable: true, get: () => 400 });
      Object.defineProperty(track, "clientWidth", {
        configurable: true,
        get: () => (400 * Number.parseFloat(track.style.width)) / 100,
      });
      return scroller;
    }

    it("keeps the playhead where it is on screen when the zoom changes", () => {
      watch();
      const scroller = sized();
      // The playhead halfway along: at 200 of 400 pixels.
      const ruler = screen.getByTestId("ruler");
      ruler.getBoundingClientRect = () => ({ left: 0, width: 400 }) as DOMRect;
      fireEvent.pointerDown(ruler, { clientX: 200 });
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      // Twice as wide, it is at 400: scrolled by 200, it is still 200 from the left.
      expect(scroller.scrollLeft).toBe(200);
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      expect(scroller.scrollLeft).toBe(600);
      fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
      expect(scroller.scrollLeft).toBe(200);
    });

    it("scrolls on with the playhead while it plays", () => {
      play.mockReturnValue(vi.fn());
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
      try {
        watch();
        const scroller = sized();
        fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
        fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
        // 1600 pixels of track over 15 seconds, 400 of them in sight.
        act(() => {
          for (const callback of resized) callback();
        });
        fireEvent.click(screen.getByRole("button", { name: "Play" }));
        const events = play.mock.calls[0]?.[3] as { tick: (t: number) => void };
        act(() => events.tick(3));
        expect(scroller.scrollLeft).toBe(0);
        // 7.5 s in, the playhead is at 800, out of sight: the track turns the page.
        act(() => events.tick(7.5));
        expect(scroller.scrollLeft).toBe(760);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});

describe("NarrationTimeline: timing", () => {
  const openTiming = () => fireEvent.click(screen.getByRole("button", { name: "Timing" }));
  const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
  const time = () => screen.getByTestId("timeline-time").textContent;

  it("sets how long a slide without narration shows, laying the timeline out anew at once", () => {
    open({});
    expect(time()).toBe("0:00.0 / 0:15");
    openTiming();
    expect(screen.getByRole("dialog", { name: "Timing" })).toBeTruthy();
    expect(field("Seconds per slide without narration").value).toBe("5");
    fireEvent.change(field("Seconds per slide without narration"), { target: { value: "8" } });
    expect(time()).toBe("0:00.0 / 0:24");
    // Saved as it is typed, where the video export and the show's Play read it.
    expect(JSON.parse(localStorage.getItem("slopslide.video") ?? "{}").secondsPerSlide).toBe(8);
  });

  it("sets the pauses around narration", async () => {
    open({ intro: { narration: "Hello" }, "#2": {}, outro: {} });
    await act(async () => {});
    openTiming();
    expect(field("Pause before narration").value).toBe("0.5");
    expect(field("Pause after narration").value).toBe("1");
    // Three seconds of narration between pauses of 3 and 4: ten seconds, then two slides of five.
    fireEvent.change(field("Pause before narration"), { target: { value: "3" } });
    fireEvent.change(field("Pause after narration"), { target: { value: "4" } });
    expect(time()).toBe("0:00.0 / 0:20");
    const stored = JSON.parse(localStorage.getItem("slopslide.video") ?? "{}");
    expect([stored.pauseBefore, stored.pauseAfter]).toEqual([3, 4]);
    // It keeps what else is stored: whether a video speaks its narration is the video's choice.
    expect(stored.narration).toBe(true);
  });

  it("says what is wrong with a time it cannot use, and does not save it", () => {
    open({});
    openTiming();
    fireEvent.change(field("Seconds per slide without narration"), { target: { value: "0" } });
    expect(screen.getByRole("alert").textContent).toMatch(/0.5 to 600 seconds/);
    expect(localStorage.getItem("slopslide.video")).toBeNull();
    expect(time()).toBe("0:00.0 / 0:15");
    fireEvent.change(field("Seconds per slide without narration"), { target: { value: "6" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(time()).toBe("0:00.0 / 0:18");
  });

  it("types its numbers without playing or stepping the timeline", () => {
    play.mockReturnValue(vi.fn());
    open({});
    openTiming();
    fireEvent.keyDown(field("Seconds per slide without narration"), { key: " " });
    fireEvent.keyDown(field("Seconds per slide without narration"), { key: "ArrowRight" });
    expect(play).not.toHaveBeenCalled();
    expect(time()).toBe("0:00.0 / 0:15");
  });
});
