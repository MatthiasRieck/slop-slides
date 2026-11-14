import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deck, SlideAudio, SpeechStatus } from "../lib/api";
import { forgetNarration } from "../lib/narrationCache";
import { wavePath } from "../lib/waveform";
import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { confirmAction } from "../store/confirm";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { NARRATION_SAVE_DELAY, NarrationPanel } from "./NarrationPanel";

const playNarration = vi.fn();
vi.mock("../lib/narrationAudio", async (original) => ({
  ...(await original<typeof import("../lib/narrationAudio")>()),
  playNarration: (...args: unknown[]) => playNarration(...args),
}));

// Counted, to tell when a waveform is drawn again.
vi.mock("../lib/waveform", async (original) => {
  const actual = await original<typeof import("../lib/waveform")>();
  return { wavePath: vi.fn(actual.wavePath) };
});

vi.mock("../store/confirm", async (original) => ({
  ...(await original<typeof import("../store/confirm")>()),
  confirmAction: vi.fn(async () => true),
}));

const setNarration = vi.fn(async (_slide: string, _text: string) => {});

function deckWith(narration: Record<string, string>, locked: string[] = []): Deck {
  const deck = deckFor(DECK_HTML);
  return {
    ...deck,
    slides: deck.slides.map((s) => ({ ...s, narration: narration[s.id] ?? "", locked: locked.includes(s.id) })),
  };
}

const box = () => screen.getByRole("textbox", { name: "Narration" }) as HTMLTextAreaElement;

/** OpenAI, the default provider, has a key; ElevenLabs none. */
const SPEECH: SpeechStatus = {
  rendering: null,
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      key: "saved",
      voices: [
        { id: "marin", name: "Marin", description: "Natural, clear voice" },
        { id: "coral", name: "Coral", description: "Warm, friendly voice" },
      ],
    },
    {
      id: "elevenlabs",
      name: "ElevenLabs",
      key: null,
      voices: [{ id: "JBFqnCBsd6RMkjVDRZzb", name: "George", description: "Warm British male narrator" }],
    },
  ],
  languages: [
    { id: "en", name: "English" },
    { id: "ko", name: "Korean" },
  ],
};

/** The backend answering speech_status with `speech`, and other commands with `answers`. */
function backend(speech: SpeechStatus | null, answers: Record<string, unknown> = {}) {
  invoke.mockImplementation(async (command: string) => (command === "speech_status" ? speech : answers[command]));
}

function audioOf(entries: SlideAudio[]) {
  useNarration.setState({
    audioDeck: deckFor(DECK_HTML).id,
    audio: Object.fromEntries(entries.map((a) => [a.slide, a])),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  forgetNarration();
  setNarration.mockClear();
  invoke.mockReset();
  // A backend that knows nothing, until a test says what it answers.
  invoke.mockResolvedValue(null);
  playNarration.mockReset();
  useNarration.setState({
    speech: null,
    accountVoices: {},
    audio: {},
    audioDeck: null,
    render: null,
    timing: null,
    settings: {},
    settingsDeck: null,
  });
  vi.mocked(confirmAction).mockReset().mockResolvedValue(true);
  useApp.setState({ deck: deckWith({ intro: "Welcome, everyone." }), selected: "intro", setNarration });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NarrationPanel", () => {
  it("holds the time expected for the slide", () => {
    render(<NarrationPanel />);
    expect(screen.getByRole("textbox", { name: "Planned time" })).toBeTruthy();
  });

  it("shows the current slide's narration with its length", () => {
    render(<NarrationPanel />);
    expect(box().value).toBe("Welcome, everyone.");
    expect(screen.getByText(/Slide 1 of 3/)).toBeTruthy();
    expect(screen.getByText(/2 words/)).toBeTruthy();
    act(() => useApp.getState().select("outro"));
    expect(box().value).toBe("");
    expect(screen.getByText(/Slide 3 of 3/)).toBeTruthy();
  });

  it("counts the words said, not the Markdown around them, and previews them formatted", () => {
    render(<NarrationPanel />);
    fireEvent.change(box(), { target: { value: "- **Welcome** everyone" } });
    expect(screen.getByText(/2 words/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const preview = screen.getByRole("document", { name: "Narration preview" });
    expect(preview.querySelector("li strong")?.textContent).toBe("Welcome");
  });

  it("saves once typing pauses", () => {
    render(<NarrationPanel />);
    fireEvent.change(box(), { target: { value: "Welcome" } });
    fireEvent.change(box(), { target: { value: "Welcome back" } });
    expect(setNarration).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(NARRATION_SAVE_DELAY));
    expect(setNarration.mock.calls).toEqual([["intro", "Welcome back"]]);
  });

  it("saves right away on blur and when switching slides", () => {
    render(<NarrationPanel />);
    fireEvent.change(box(), { target: { value: "First" } });
    fireEvent.blur(box());
    expect(setNarration.mock.calls).toEqual([["intro", "First"]]);
    fireEvent.change(box(), { target: { value: "Second" } });
    act(() => useApp.getState().select("outro"));
    expect(setNarration.mock.calls).toEqual([
      ["intro", "First"],
      ["intro", "Second"],
    ]);
    act(() => vi.advanceTimersByTime(NARRATION_SAVE_DELAY));
    expect(setNarration).toHaveBeenCalledTimes(2);
  });

  it("follows changes made elsewhere, but not while the user is typing", () => {
    render(<NarrationPanel />);
    act(() => useApp.setState({ deck: deckWith({ intro: "From the agent." }) }));
    expect(box().value).toBe("From the agent.");
    fireEvent.change(box(), { target: { value: "Mine " } });
    act(() => useApp.setState({ deck: deckWith({ intro: "Agent again." }) }));
    expect(box().value).toBe("Mine ");
    // The saved, trimmed text coming back does not undo the trailing space being typed.
    act(() => vi.advanceTimersByTime(NARRATION_SAVE_DELAY));
    act(() => useApp.setState({ deck: deckWith({ intro: "Mine" }) }));
    expect(box().value).toBe("Mine ");
  });

  it("is read-only on a locked slide", () => {
    useApp.setState({ deck: deckWith({ intro: "Fixed." }, ["intro"]) });
    render(<NarrationPanel />);
    expect(box().readOnly).toBe(true);
    expect(screen.getByText("Locked")).toBeTruthy();
  });

  it("explains itself without a deck or slides", () => {
    useApp.setState({ deck: null, selected: null });
    const { rerender } = render(<NarrationPanel />);
    expect(screen.getByText(/Open a deck/)).toBeTruthy();
    useApp.setState({ deck: { ...deckFor(DECK_HTML), slides: [] } });
    rerender(<NarrationPanel />);
    expect(screen.getByText(/Add a slide/)).toBeTruthy();
  });
});

describe("NarrationPanel audio", () => {
  const WORDS = [
    { text: "Welcome,", start: 0.4, end: 1 },
    { text: "everyone.", start: 2, end: 3 },
  ];
  /** The first slide's audio, four seconds long, with its waveform and maybe its words. */
  async function withAudio(audio: Partial<SlideAudio> = {}) {
    backend(SPEECH, { narration_peaks: [0.5, 1], narration_words: WORDS });
    audioOf([{ slide: "intro", state: "ready", seconds: 4, ...audio }]);
    const view = render(<NarrationPanel />);
    await act(async () => {});
    return view;
  }
  const wave = (name = "Narration audio") => screen.getByRole("button", { name }) as HTMLButtonElement;
  /** A playback standing still at `at` until it is stopped. */
  function playing(at: number) {
    let end = () => {};
    const playback = {
      ended: new Promise<void>((resolve) => (end = resolve)),
      stop: vi.fn(() => end()),
      pause: vi.fn(),
      resume: vi.fn(async () => {}),
      time: () => at,
    };
    playNarration.mockResolvedValueOnce(playback);
    return playback;
  }

  it("shows the audio's waveform above the words, with the buttons to hear and remake it", async () => {
    await withAudio();
    expect(wave().querySelector("path")?.getAttribute("d")).toBe("M0 0.5V1.5M1 0V2");
    expect(invoke).toHaveBeenCalledWith("narration_peaks", { id: deckFor(DECK_HTML).id, slide: "intro" });
    expect(wave().compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const regenerate = screen.getByRole("button", { name: "Regenerate" });
    expect(regenerate.compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => fireEvent.click(regenerate));
    expect(invoke).toHaveBeenCalledWith("render_narration", { id: deckFor(DECK_HTML).id, slides: ["intro"] });
  });

  it("has no waveform before there is audio", async () => {
    backend(SPEECH);
    render(<NarrationPanel />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /Narration audio/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Generate" })).toBeTruthy();
  });

  it("shows when each word is said once the audio is timed, wide enough to read and scroll", async () => {
    const { unmount } = await withAudio();
    expect(wave().querySelector("[data-word]")).toBeNull();
    expect(wave().style.width).toBe("");
    unmount();
    await withAudio({ timed: true });
    const words = [...wave().querySelectorAll<HTMLElement>("[data-word]")];
    expect(words.map((w) => [w.textContent, w.style.left])).toEqual([
      ["Welcome,", "10%"],
      ["everyone.", "50%"],
    ]);
    expect(wave().style.width).toBe("320px");
    expect(wave().parentElement!.className).toContain("overflow-x-auto");
  });

  it("marks out-of-date audio, without its words", async () => {
    await withAudio({ state: "stale", timed: true });
    expect(wave("Narration audio, out of date").querySelector("[data-word]")).toBeNull();
  });

  it("plays from where the waveform is pressed, a line showing where it is", async () => {
    await withAudio();
    wave().getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;
    const first = playing(3);
    await act(async () => fireEvent.click(wave(), { clientX: 100 }));
    expect(playNarration).toHaveBeenLastCalledWith(deckFor(DECK_HTML).id, "intro", 2);
    expect(screen.getByTestId("wave-playhead").style.transform).toBe("translateX(75%)");
    // Pressed again elsewhere, it starts over from there.
    const second = playing(1);
    await act(async () => fireEvent.click(wave(), { clientX: 50 }));
    expect(first.stop).toHaveBeenCalled();
    expect(playNarration).toHaveBeenLastCalledWith(deckFor(DECK_HTML).id, "intro", 1);
    expect(screen.getByTestId("wave-playhead").style.transform).toBe("translateX(25%)");
    expect(second.stop).not.toHaveBeenCalled();
    expect(playNarration).toHaveBeenCalledTimes(2);
  });

  it("the button plays from the start, pauses, and plays on from there instead of starting over", async () => {
    await withAudio();
    const playback = playing(0);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play" })));
    expect(playNarration).toHaveBeenLastCalledWith(deckFor(DECK_HTML).id, "intro", 0);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pause" })));
    expect(playback.pause).toHaveBeenCalledOnce();
    expect(playback.stop).not.toHaveBeenCalled();
    // The line stays where it stopped.
    expect(screen.getByTestId("wave-playhead")).toBeTruthy();
    const resume = screen.getByRole("button", { name: "Resume" });
    expect(resume.title).toBe("Play on from where it was paused");
    await act(async () => fireEvent.click(resume));
    expect(playback.resume).toHaveBeenCalledOnce();
    expect(playNarration).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("goes back to Play when the audio has played to its end", async () => {
    await withAudio();
    let end!: () => void;
    playNarration.mockResolvedValueOnce({
      ended: new Promise<void>((resolve) => (end = resolve)),
      stop: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      time: () => 0,
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play" })));
    await act(async () => end());
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(screen.queryByTestId("wave-playhead")).toBeNull();
  });

  it("pressing the waveform while paused plays from there", async () => {
    await withAudio();
    wave().getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;
    const first = playing(0);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pause" })));
    playing(2);
    await act(async () => fireEvent.click(wave(), { clientX: 100 }));
    expect(first.stop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("follows the audio with the line as it plays", async () => {
    await withAudio();
    let at = 1;
    playNarration.mockResolvedValueOnce({ ended: new Promise<void>(() => {}), stop: vi.fn(), time: () => at });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play" })));
    expect(screen.getByTestId("wave-playhead").style.transform).toBe("translateX(25%)");
    at = 9;
    await act(async () => void vi.advanceTimersByTime(60));
    // Never past the end of the audio.
    expect(screen.getByTestId("wave-playhead").style.transform).toBe("translateX(100%)");
  });

  it("moves the line every frame without drawing the waveform or the words again", async () => {
    await withAudio({ timed: true });
    let at = 0;
    playNarration.mockResolvedValueOnce({ ended: new Promise<void>(() => {}), stop: vi.fn(), time: () => at });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play" })));
    vi.mocked(wavePath).mockClear();
    const words = [...wave().querySelectorAll("[data-word]")];
    const places = new Set<string>();
    for (let i = 0; i < 60; i++) {
      at += 1 / 60;
      await act(async () => void vi.advanceTimersByTime(17));
      places.add(screen.getByTestId("wave-playhead").style.transform);
    }
    expect(places.size).toBeGreaterThan(10);
    expect(wavePath).not.toHaveBeenCalled();
    expect([...wave().querySelectorAll("[data-word]")]).toEqual(words);
  });

  it("scrolls on only when the line runs out of sight, and stands still while paused", async () => {
    await withAudio({ timed: true });
    // 800 pixels of waveform over four seconds, 200 of them in sight.
    const scroller = wave().parentElement!;
    const scrolls: number[] = [];
    Object.defineProperty(scroller, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, get: () => 800 });
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => scrolls.at(-1) ?? 0,
      set: (to: number) => void scrolls.push(to),
    });
    let at = 0;
    const playback = { ended: new Promise<void>(() => {}), stop: vi.fn(), pause: vi.fn(), time: () => at };
    playNarration.mockResolvedValueOnce(playback);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play" })));
    for (at = 0.1; at < 0.9; at += 0.1) await act(async () => void vi.advanceTimersByTime(17));
    expect(scrolls).toEqual([]);
    // 1.5 s in, the line is at 300: a page on, the line near its left.
    for (at = 1.5; at < 2.2; at += 0.1) await act(async () => void vi.advanceTimersByTime(17));
    expect(scrolls).toEqual([280]);
    // Paused, nothing asks the audio where it is any more.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pause" })));
    const time = vi.spyOn(playback, "time");
    await act(async () => void vi.advanceTimersByTime(500));
    expect(time).not.toHaveBeenCalled();
  });

  it("reads the waveform once, however often the slide is shown", async () => {
    const view = await withAudio();
    view.unmount();
    await withAudio();
    expect(wave().querySelector("path")).toBeTruthy();
    expect(invoke.mock.calls.filter(([command]) => command === "narration_peaks")).toHaveLength(1);
  });
});

describe("NarrationPanel speech", () => {
  /** Renders the panel and lets it load the speech status. */
  async function show() {
    const view = render(<NarrationPanel />);
    await act(async () => {});
    return view;
  }
  /** Unfolds the deck's voice settings. */
  const change = () => fireEvent.click(screen.getByRole("button", { name: "Change" }));

  it("shows the deck's voice as one line, unfolding to change it", async () => {
    backend(SPEECH);
    useApp.setState({ deck: { ...deckWith({ intro: "Hi." }), narration: { voice: "coral", language: "ko" } } });
    await show();
    expect(screen.getByTestId("voice-summary").textContent).toBe("Voice OpenAI · Coral · Korean");
    expect(screen.queryByRole("combobox", { name: "Narration voice" })).toBeNull();
    change();
    expect(screen.getByRole("combobox", { name: "Narration voice" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("combobox", { name: "Narration voice" })).toBeNull();
  });

  it("asks for a missing API key in the folded line too", async () => {
    backend(withKey("openai", null));
    await show();
    expect(screen.getByText("Add your OpenAI API key to generate audio.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    expect(screen.getByLabelText("OpenAI API key")).toBeTruthy();
  });

  it("sets the deck's pace and style, which the audio is said with", async () => {
    const id = deckFor(DECK_HTML).id;
    backend(SPEECH, { set_narration_delivery: { pace: "slower", style: "warm" }, narration_audio: [] });
    useNarration.setState({ settings: {}, settingsDeck: id });
    await show();
    change();
    await act(async () =>
      fireEvent.change(screen.getByRole("combobox", { name: "Speaking pace" }), { target: { value: "slower" } }),
    );
    expect(invoke).toHaveBeenCalledWith("set_narration_delivery", { id, pace: "slower", style: "" });
    // The audio is read again: it is out of date now.
    expect(invoke).toHaveBeenCalledWith("narration_audio", { id });
    expect(screen.getByTestId("voice-summary").textContent).toContain("slower pace");
    const style = screen.getByRole("textbox", { name: "Speaking style" }) as HTMLInputElement;
    fireEvent.change(style, { target: { value: " calm " } });
    await act(async () => fireEvent.blur(style));
    expect(invoke).toHaveBeenCalledWith("set_narration_delivery", { id, pace: "slower", style: "calm" });
  });

  it("has no style for a service that takes none, and says so", async () => {
    backend(withKey("elevenlabs", "saved"), { speech_voices: [] });
    useApp.setState({
      deck: {
        ...deckWith({ intro: "Hi." }),
        narration: { provider: "elevenlabs", voice: "JBFqnCBsd6RMkjVDRZzb", language: "en" },
      },
    });
    await show();
    change();
    const style = screen.getByRole("textbox", { name: "Speaking style" }) as HTMLInputElement;
    expect(style.disabled).toBe(true);
    expect(style.placeholder).toBe("ElevenLabs takes no style note");
    expect((screen.getByRole("combobox", { name: "Speaking pace" }) as HTMLSelectElement).disabled).toBe(false);
  });

  it("plays a sample of the voice, made once and kept", async () => {
    const played: string[] = [];
    vi.stubGlobal(
      "Audio",
      class extends EventTarget {
        constructor(public src: string) {
          super();
        }
        async play() {
          played.push(this.src);
        }
        pause() {}
      },
    );
    URL.createObjectURL = vi.fn(() => "blob:sample");
    backend(SPEECH, { preview_narration_voice: new ArrayBuffer(4) });
    await show();
    change();
    const hear = screen.getByRole("button", { name: "Hear this voice" });
    await act(async () => fireEvent.click(hear));
    expect(invoke).toHaveBeenCalledWith("preview_narration_voice", {
      provider: "openai",
      voice: "marin",
      language: "en",
    });
    expect(played).toEqual(["blob:sample"]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop the sample" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Hear this voice" })));
    // Kept: the service is not asked again.
    expect(invoke.mock.calls.filter(([name]) => name === "preview_narration_voice")).toHaveLength(1);
    expect(played).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it("cannot play a sample without the service's key", async () => {
    backend(withKey("openai", null));
    await show();
    change();
    expect((screen.getByRole("button", { name: "Hear this voice" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("picks the deck's voice and language", async () => {
    backend(SPEECH);
    const setNarrationVoice = vi.fn(async () => {});
    const setNarrationLanguage = vi.fn(async () => {});
    useApp.setState({
      deck: { ...deckWith({ intro: "Hi." }), narration: { voice: "coral", language: "ko" } },
      setNarrationVoice,
      setNarrationLanguage,
    });
    await show();
    change();
    const voice = screen.getByRole("combobox", { name: "Narration voice" }) as HTMLSelectElement;
    const language = screen.getByRole("combobox", { name: "Narration language" }) as HTMLSelectElement;
    expect(voice.value).toBe("coral");
    expect(language.value).toBe("ko");
    expect(screen.getByRole("option", { name: "Coral — Warm, friendly voice" })).toBeTruthy();
    fireEvent.change(voice, { target: { value: "marin" } });
    fireEvent.change(language, { target: { value: "en" } });
    expect(setNarrationVoice).toHaveBeenCalledWith("marin");
    expect(setNarrationLanguage).toHaveBeenCalledWith("en");
  });

  /** SPEECH with the provider `id`'s key coming from `key`. */
  function withKey(id: string, key: "saved" | "environment" | null): SpeechStatus {
    return { ...SPEECH, providers: SPEECH.providers.map((p) => (p.id === id ? { ...p, key } : p)) };
  }

  it("picks who says the narration", async () => {
    backend(SPEECH);
    const setNarrationProvider = vi.fn(async () => {});
    useApp.setState({ setNarrationProvider });
    await show();
    change();
    const provider = screen.getByRole("combobox", { name: "Narration provider" }) as HTMLSelectElement;
    expect(provider.value).toBe("openai");
    expect([...provider.options].map((o) => o.text)).toEqual(["OpenAI", "ElevenLabs"]);
    fireEvent.change(provider, { target: { value: "elevenlabs" } });
    expect(setNarrationProvider).toHaveBeenCalledWith("elevenlabs");
  });

  it("offers a provider's voices and asks for its API key before speaking", async () => {
    backend(withKey("openai", null), { set_speech_key: SPEECH });
    useApp.setState({
      deck: { ...deckWith({ intro: "Hi." }), narration: { provider: "openai", voice: "coral", language: "en" } },
    });
    await show();
    change();
    const voice = screen.getByRole("combobox", { name: "Narration voice" }) as HTMLSelectElement;
    expect(voice.value).toBe("coral");
    expect([...voice.options].map((o) => o.value)).toEqual(["marin", "coral"]);
    // There is no voice model to download any more.
    expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
    const generate = screen.getByRole("button", { name: /Generate/ }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    expect(generate.title).toBe("Add your OpenAI API key first, under Voice below");
    const key = screen.getByLabelText("OpenAI API key") as HTMLInputElement;
    expect(key.type).toBe("password");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(key, { target: { value: "sk-test" } });
    await act(async () => fireEvent.click(save));
    expect(invoke).toHaveBeenCalledWith("set_speech_key", { provider: "openai", key: "sk-test" });
    expect(screen.getByText("OpenAI API key saved")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Generate/ }) as HTMLButtonElement).disabled).toBe(false);
    backend(SPEECH, { set_speech_key: withKey("openai", null) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Remove/ })));
    expect(invoke).toHaveBeenCalledWith("set_speech_key", { provider: "openai", key: null });
    expect(screen.getByLabelText("OpenAI API key")).toBeTruthy();
  });

  it("uses a key from the environment", async () => {
    backend(withKey("openai", "environment"));
    useApp.setState({
      deck: { ...deckWith({ intro: "Hi." }), narration: { provider: "openai", voice: "marin", language: "en" } },
    });
    await show();
    change();
    expect(screen.getByText(/OPENAI_API_KEY from your environment/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Generate/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("lists the voices of the ElevenLabs account, keeping the deck's own voice pickable", async () => {
    const account = [
      { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", description: "male, british" },
      { id: "abcdefghij1234567890", name: "Me", description: "Your voice" },
    ];
    backend(withKey("elevenlabs", "saved"), { speech_voices: account });
    useApp.setState({
      deck: {
        ...deckWith({ intro: "Hi." }),
        narration: { provider: "elevenlabs", voice: "zzzzzzzzzzzzzzzzzzzz", language: "en" },
      },
    });
    await show();
    expect(invoke).toHaveBeenCalledWith("speech_voices", { provider: "elevenlabs" });
    change();
    const voice = screen.getByRole("combobox", { name: "Narration voice" }) as HTMLSelectElement;
    expect(voice.value).toBe("zzzzzzzzzzzzzzzzzzzz");
    expect([...voice.options].map((o) => o.text)).toEqual([
      "zzzzzzzzzzzzzzzzzzzz",
      "George — male, british",
      "Me — Your voice",
    ]);
  });

  it("tells whether the slide's audio is there and up to date", async () => {
    backend(SPEECH);
    await show();
    expect(screen.getByText("No audio yet")).toBeTruthy();
    // Nothing to play yet.
    expect(screen.queryByRole("button", { name: /^Play/ })).toBeNull();
    act(() => audioOf([{ slide: "intro", state: "ready", seconds: 12.4 }]));
    expect(screen.getByText("Audio 0:12")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Play/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: /Regenerate/ })).toBeTruthy();
  });

  it("warns that the audio is out of date, offering to update it", async () => {
    backend(SPEECH);
    await show();
    act(() => audioOf([{ slide: "intro", state: "stale", seconds: 75 }]));
    expect(screen.getByTestId("audio-stale").textContent).toBe("Script or voice changed · old audio 1:15");
    expect(screen.getByTestId("audio-stale").className).toContain("text-warning");
    const update = screen.getByRole("button", { name: "Update audio" });
    expect(update.className).toContain("bg-primary");
    await act(async () => fireEvent.click(update));
    expect(invoke).toHaveBeenCalledWith("render_narration", { id: deckFor(DECK_HTML).id, slides: ["intro"] });
  });

  it("saves what was typed, then speaks the slide", async () => {
    const said: SlideAudio[] = [{ slide: "intro", state: "ready", seconds: 2 }];
    backend(SPEECH, { render_narration: said });
    await show();
    fireEvent.change(box(), { target: { value: "Welcome back." } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Generate/ })));
    expect(setNarration.mock.calls).toEqual([["intro", "Welcome back."]]);
    expect(invoke).toHaveBeenCalledWith("render_narration", { id: deckFor(DECK_HTML).id, slides: ["intro"] });
    expect(screen.getByText("Audio 0:02")).toBeTruthy();
  });

  it("has no audio controls for a slide without narration", async () => {
    backend(SPEECH);
    await show();
    act(() => useApp.getState().select("outro"));
    expect(screen.queryByRole("button", { name: /Generate$/ })).toBeNull();
  });

  it("speaks every slide that needs it, and can be cancelled", async () => {
    backend(SPEECH);
    useApp.setState({ deck: deckWith({ intro: "One.", outro: "Three." }) });
    await show();
    act(() =>
      audioOf([
        { slide: "intro", state: "stale", seconds: 1 },
        { slide: "outro", state: "missing", seconds: null },
      ]),
    );
    expect(screen.getByText("2 slides need audio")).toBeTruthy();
    // How much goes to the service, before anything is sent: "One." and "Three.".
    expect(screen.getByTestId("generation-size").textContent).toBe("10 characters go to OpenAI, about 0:01 of audio");
    expect(screen.getByRole("button", { name: /Generate all/ }).title).toMatch(
      /^Generates the audio of 2 slides, 10 characters/,
    );
    invoke.mockImplementation((command: string) =>
      command === "render_narration" ? new Promise(() => {}) : Promise.resolve(SPEECH),
    );
    act(() => fireEvent.click(screen.getByRole("button", { name: /Generate all/ })));
    expect(invoke).toHaveBeenCalledWith("render_narration", { id: deckFor(DECK_HTML).id, slides: null });
    act(() => useNarration.setState({ render: { deck: deckFor(DECK_HTML).id, slide: "outro", done: 1, total: 2 } }));
    expect(screen.getByText(/Generating audio for slide 2 of 2/)).toBeTruthy();
    // Slide 1 is not the one being generated: its own button waits, saying why.
    expect(screen.getAllByRole("button", { name: /Cancel/ })).toHaveLength(1);
    expect((screen.getByRole("button", { name: /Update audio|Generate$/ }) as HTMLButtonElement).title).toBe(
      "Audio is being generated for another slide",
    );
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(invoke).toHaveBeenCalledWith("cancel_narration");
  });

  it("offers Cancel in place of Generate on the slide whose audio is being generated", async () => {
    backend(SPEECH);
    await show();
    invoke.mockImplementation((command: string) =>
      command === "render_narration" ? new Promise(() => {}) : Promise.resolve(SPEECH),
    );
    const controls = () => screen.getByText(/Generating audio…|No audio yet/).closest("div")!;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate" })));
    act(() => useNarration.setState({ render: { deck: deckFor(DECK_HTML).id, slide: "intro", done: 0, total: 1 } }));
    expect(screen.getByText("Generating audio…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    // Right where Generate was, not only at the bottom of the tab.
    const cancel = [...controls().querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    expect(cancel.title).toBe("Stop generating the audio");
    invoke.mockClear();
    fireEvent.click(cancel);
    expect(invoke).toHaveBeenCalledWith("cancel_narration");
    act(() => useNarration.setState({ render: null }));
    expect(screen.getByRole("button", { name: "Generate" })).toBeTruthy();
  });

  it("syncs the words to audio that is not synced yet, showing how far it has got", async () => {
    backend(SPEECH);
    useApp.setState({ deck: deckWith({ intro: "One.", outro: "Three." }) });
    await show();
    // Out-of-date audio is not worth timing.
    act(() =>
      audioOf([
        { slide: "intro", state: "ready", seconds: 1 },
        { slide: "outro", state: "stale", seconds: 2 },
      ]),
    );
    expect(screen.getByText("Audio 0:01")).toBeTruthy();
    expect(screen.getByText("1 slide's words are not synced to the audio")).toBeTruthy();
    expect(screen.queryByText(/Time words/)).toBeNull();
    let finish!: (audio: SlideAudio[]) => void;
    invoke.mockImplementation((command: string) =>
      command === "time_narration"
        ? new Promise((resolve) => (finish = resolve))
        : Promise.resolve(command === "voice_status" ? { modelReady: true } : SPEECH),
    );
    const sync = screen.getByRole("button", { name: "Sync words to audio" });
    expect(sync.title).toMatch(/when each word is said/);
    await act(async () => fireEvent.click(sync));
    expect(invoke).toHaveBeenCalledWith("time_narration", { id: deckFor(DECK_HTML).id, slides: null });
    act(() => useNarration.setState({ timing: { deck: deckFor(DECK_HTML).id, slide: "intro", done: 0, total: 1 } }));
    expect(screen.getByText("Syncing words of slide 1 of 1…")).toBeTruthy();
    await act(async () =>
      finish([
        { slide: "intro", state: "ready", seconds: 1, timed: true },
        { slide: "outro", state: "stale", seconds: 2 },
      ]),
    );
    expect(screen.getByText("Audio 0:01, words synced")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sync words/ })).toBeNull();
  });

  it("says when it downloads the speech model to time words", async () => {
    backend(SPEECH);
    await show();
    act(() =>
      useNarration.setState({
        timing: { deck: deckFor(DECK_HTML).id, slide: null, done: 0, total: 0, downloading: true },
      }),
    );
    expect(screen.getByText("Downloading the speech model…")).toBeTruthy();
    act(() =>
      useNarration.setState({
        timing: {
          deck: deckFor(DECK_HTML).id,
          slide: null,
          done: 0,
          total: 0,
          downloading: true,
          download: { received: 95_000_000, total: 190_000_000 },
        },
      }),
    );
    expect(screen.getByText("Downloading the speech model: 95 MB of 190 MB")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    // Cancel stops the download, not the hearing that has not begun.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(invoke).toHaveBeenCalledWith("cancel_voice_download");
  });

  it("offers the speech model with its size before downloading it to sync words", async () => {
    backend(SPEECH, { voice_status: { modelReady: false, modelBytes: 190_085_487, downloading: false } });
    await show();
    act(() => audioOf([{ slide: "intro", state: "ready", seconds: 1 }]));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sync words to audio" })));
    expect(screen.getByText(/The model \(190 MB\) is downloaded once/)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("download_voice_model");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText(/The model \(190 MB\)/)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sync words to audio" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Download and sync" })));
    expect(invoke).toHaveBeenCalledWith("download_voice_model");
  });

  it("stops syncing words before the next slide", async () => {
    backend(SPEECH);
    await show();
    act(() => useNarration.setState({ timing: { deck: deckFor(DECK_HTML).id, slide: "intro", done: 0, total: 2 } }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(invoke).toHaveBeenCalledWith("cancel_narration_timing");
  });

  describe("recordings and cleaning up", () => {
    const recording: SlideAudio = { slide: "intro", state: "ready", seconds: 72, recorded: true };

    beforeEach(() => {
      useApp.setState({ deck: deckWith({ intro: "Um, so, hello." }), selected: "intro" });
    });

    it("shows a recording as the presenter's own, to delete rather than regenerate", async () => {
      useNarration.setState({ audioDeck: deckFor(DECK_HTML).id, audio: { intro: recording } });
      invoke.mockImplementation(async (name: string) =>
        name === "delete_recorded_narration"
          ? [{ slide: "intro", state: "missing", seconds: null, recorded: false }]
          : SPEECH,
      );
      await act(async () => void render(<NarrationPanel />));
      expect(screen.getByText("Your recording 1:12")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /generate/i })).toBeNull();
      expect(screen.getByRole("button", { name: "Record again" })).toBeTruthy();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete recording" })));
      expect(vi.mocked(confirmAction).mock.lastCall?.[0]).toMatchObject({
        title: "Delete your recording?",
        confirmLabel: "Delete recording",
        destructive: true,
      });
      expect(invoke).toHaveBeenCalledWith("delete_recorded_narration", { id: deckFor(DECK_HTML).id, slide: "intro" });
      expect(screen.getByRole("button", { name: "Generate" })).toBeTruthy();
    });

    it("shows audio brought in from elsewhere as such, to remove", async () => {
      const imported = { ...recording, imported: true, timed: true, seconds: 185 };
      useApp.setState({ deck: deckWith({}), selected: "intro" });
      useNarration.setState({ audioDeck: deckFor(DECK_HTML).id, audio: { intro: imported } });
      invoke.mockImplementation(async (name: string) =>
        name === "delete_recorded_narration" ? [{ slide: "intro", state: "none", seconds: null }] : SPEECH,
      );
      await act(async () => void render(<NarrationPanel />));
      expect(screen.getByText("Imported audio 3:05, words synced")).toBeTruthy();
      expect(screen.queryByText(/Your recording/)).toBeNull();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove audio" })));
      expect(vi.mocked(confirmAction).mock.lastCall?.[0]).toMatchObject({
        title: "Remove this slide's audio?",
        confirmLabel: "Remove audio",
      });
      expect(invoke).toHaveBeenCalledWith("delete_recorded_narration", { id: deckFor(DECK_HTML).id, slide: "intro" });
    });

    it("keeps the recording unless the deletion is confirmed", async () => {
      vi.mocked(confirmAction).mockResolvedValue(false);
      useNarration.setState({ audioDeck: deckFor(DECK_HTML).id, audio: { intro: recording } });
      await act(async () => void render(<NarrationPanel />));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete recording" })));
      expect(invoke).not.toHaveBeenCalledWith("delete_recorded_narration", expect.anything());
    });

    it("offers a slide's recording even when it has no script", async () => {
      useApp.setState({ deck: deckWith({}), selected: "intro" });
      useNarration.setState({ audioDeck: deckFor(DECK_HTML).id, audio: { intro: recording } });
      await act(async () => void render(<NarrationPanel />));
      expect(screen.getByText("Your recording 1:12")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Polish/ })).toBeNull();
    });

    it("asks the agent to clean up the slide or the whole deck, leaving the sending to the user", async () => {
      const original = useApp.getState().cleanNarration;
      const cleanNarration = vi.fn();
      backend(SPEECH);
      useApp.setState({ cleanNarration });
      await act(async () => void render(<NarrationPanel />));
      // Both say that they hand a request to the agent rather than change anything by themselves.
      const one = screen.getByRole("button", { name: "Polish wording…" });
      const all = screen.getByRole("button", { name: "Polish all scripts…" });
      for (const button of [one, all]) {
        expect(button.title).toMatch(/Opens the chat.*for you to send · asks the agent$/);
        expect(button.querySelector("svg.text-primary")).toBeTruthy();
      }
      // Generating the audio comes first in the deck's actions; polishing is after it.
      act(() => audioOf([{ slide: "intro", state: "missing", seconds: null }]));
      const generateAll = screen.getByRole("button", { name: /Generate all/ });
      expect(generateAll.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await act(async () => fireEvent.click(one));
      expect(cleanNarration).toHaveBeenLastCalledWith("intro");
      await act(async () => fireEvent.click(all));
      expect(cleanNarration).toHaveBeenLastCalledWith(null);
      useApp.setState({ cleanNarration: original });
    });

    it("has nothing to clean up without narration or on locked slides", async () => {
      useApp.setState({ deck: deckWith({ intro: "Hello." }, ["intro"]), selected: "intro" });
      await act(async () => void render(<NarrationPanel />));
      expect(screen.queryByRole("button", { name: /polish/i })).toBeNull();
    });
  });

  describe("recording", () => {
    it("records the slide after a countdown, as a take that replaces the one before", async () => {
      backend(SPEECH);
      await show();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record" })));
      // Nothing is recorded during the countdown.
      expect(screen.getByRole("status").textContent).toBe("3Recording starts…");
      expect(invoke).not.toHaveBeenCalledWith("start_narration_recording", expect.anything());
      await act(async () => vi.advanceTimersByTime(1000));
      expect(screen.getByRole("status").textContent).toBe("2Recording starts…");
      for (const _ of [2, 1]) await act(async () => vi.advanceTimersByTime(1000));
      expect(invoke).toHaveBeenCalledWith("start_narration_recording", {
        id: deckFor(DECK_HTML).id,
        slide: "intro",
        mode: "audio",
        replace: true,
      });
      expect(screen.getByRole("meter", { name: "Microphone level" })).toBeTruthy();
      expect(screen.getByTestId("recording-time").textContent).toBe("0:00");
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
      expect(invoke).toHaveBeenCalledWith("stop_narration_recording");
      expect(screen.getByRole("button", { name: "Record" })).toBeTruthy();
    });

    it("calls off a recording during its countdown", async () => {
      backend(SPEECH);
      await show();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record" })));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
      await act(async () => vi.advanceTimersByTime(5000));
      expect(invoke).not.toHaveBeenCalledWith("start_narration_recording", expect.anything());
      expect(screen.getByRole("button", { name: "Record" })).toBeTruthy();
    });

    it("records a slide that has no script yet, but not a locked one", async () => {
      backend(SPEECH);
      useApp.setState({ deck: deckWith({}), selected: "intro" });
      await show();
      expect(screen.getByRole("button", { name: "Record" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
      act(() => useApp.setState({ deck: deckWith({ intro: "Hi." }, ["intro"]) }));
      expect((screen.getByRole("button", { name: "Record" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("says why it could not record", async () => {
      backend(SPEECH);
      invoke.mockImplementation(async (command: string) => {
        if (command === "start_narration_recording") throw "No microphone was found.";
        return command === "speech_status" ? SPEECH : null;
      });
      await show();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record" })));
      for (const _ of [3, 2, 1]) await act(async () => vi.advanceTimersByTime(1000));
      expect(screen.getByRole("alert").textContent).toBe("Could not record: No microphone was found.");
    });
  });

  describe("speaker notes and the whole deck", () => {
    it("takes the slide's speaker notes as its script", async () => {
      backend(SPEECH);
      const deck = deckWith({});
      useApp.setState({
        deck: { ...deck, slides: deck.slides.map((s) => (s.id === "intro" ? { ...s, notes: "Say hello." } : s)) },
      });
      await show();
      fireEvent.click(screen.getByRole("button", { name: "Use speaker notes as script" }));
      expect(box().value).toBe("Say hello.");
      act(() => vi.advanceTimersByTime(NARRATION_SAVE_DELAY));
      expect(setNarration.mock.calls).toEqual([["intro", "Say hello."]]);
      expect(screen.queryByRole("button", { name: "Use speaker notes as script" })).toBeNull();
    });

    it("takes the notes as the script of every slide without one", async () => {
      backend(SPEECH);
      const scriptsFromNotes = vi.fn(async () => {});
      const deck = deckWith({ intro: "Mine." });
      useApp.setState({
        scriptsFromNotes,
        deck: { ...deck, slides: deck.slides.map((s) => ({ ...s, notes: "Note." })) },
      });
      await show();
      // The first slide keeps its script: two of the three get theirs.
      fireEvent.click(screen.getByRole("button", { name: "Use speaker notes for 2 empty scripts" }));
      expect(scriptsFromNotes).toHaveBeenCalled();
    });

    it("says it is saving the script, and when it is saved", async () => {
      backend(SPEECH);
      await show();
      fireEvent.change(box(), { target: { value: "Welcome back." } });
      expect(screen.getByText("Saving…")).toBeTruthy();
      await act(async () => vi.advanceTimersByTime(NARRATION_SAVE_DELAY));
      expect(screen.getByText("Saved")).toBeTruthy();
    });

    it("lists every slide's narration, going to a slide from its row", async () => {
      backend(SPEECH);
      useApp.setState({ deck: deckWith({ intro: "One.", outro: "Three." }) });
      await show();
      act(() =>
        audioOf([
          { slide: "intro", state: "stale", seconds: 1 },
          { slide: "outro", state: "ready", seconds: 2 },
        ]),
      );
      expect(screen.getByTestId("narration-counts").textContent).toBe(
        "2 of 3 slides have a script · 1 with audio · 1 out of date",
      );
      fireEvent.click(screen.getByRole("button", { name: /Every slide/ }));
      const rows = screen.getByRole("list", { name: "Narration of every slide" }).querySelectorAll("[data-mark]");
      expect([...rows].map((r) => r.getAttribute("data-mark"))).toEqual(["stale", "none", "ready"]);
      fireEvent.click(screen.getByTitle("Go to slide 3"));
      expect(useApp.getState().selected).toBe("outro");
    });
  });
});
