import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import type { Deck, SlideAudio, SpeechStatus } from "../lib/api";
import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { NARRATION_SAVE_DELAY, NarrationPanel } from "./NarrationPanel";

const setNarration = vi.fn(async (_slide: string, _text: string) => {});

function deckWith(narration: Record<string, string>, locked: string[] = []): Deck {
  const deck = deckFor(DECK_HTML);
  return {
    ...deck,
    slides: deck.slides.map((s) => ({ ...s, narration: narration[s.id] ?? "", locked: locked.includes(s.id) })),
  };
}

const box = () => screen.getByRole("textbox", { name: "Narration" }) as HTMLTextAreaElement;

const SPEECH: SpeechStatus = {
  available: true,
  modelReady: true,
  modelBytes: 2_498_383_610,
  downloading: false,
  rendering: null,
  voices: [
    { id: "ryan", name: "Ryan", description: "Dynamic male voice", native: "en" },
    { id: "sohee", name: "Sohee", description: "Warm female voice", native: "ko" },
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
  setNarration.mockClear();
  invoke.mockReset();
  useNarration.setState({ speech: null, audio: {}, audioDeck: null, render: null, download: null });
  useApp.setState({ deck: deckWith({ intro: "Welcome, everyone." }), selected: "intro", setNarration });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NarrationPanel", () => {
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

describe("NarrationPanel speech", () => {
  /** Renders the panel and lets it load the speech status. */
  async function show() {
    const view = render(<NarrationPanel />);
    await act(async () => {});
    return view;
  }

  it("picks the deck's voice and language", async () => {
    backend(SPEECH);
    const setNarrationVoice = vi.fn(async () => {});
    const setNarrationLanguage = vi.fn(async () => {});
    useApp.setState({
      deck: { ...deckWith({ intro: "Hi." }), narration: { voice: "sohee", language: "ko" } },
      setNarrationVoice,
      setNarrationLanguage,
    });
    await show();
    const voice = screen.getByRole("combobox", { name: "Narration voice" }) as HTMLSelectElement;
    const language = screen.getByRole("combobox", { name: "Narration language" }) as HTMLSelectElement;
    expect(voice.value).toBe("sohee");
    expect(language.value).toBe("ko");
    expect(screen.getByRole("option", { name: "Sohee — Warm female voice (Korean)" })).toBeTruthy();
    fireEvent.change(voice, { target: { value: "ryan" } });
    fireEvent.change(language, { target: { value: "en" } });
    expect(setNarrationVoice).toHaveBeenCalledWith("ryan");
    expect(setNarrationLanguage).toHaveBeenCalledWith("en");
  });

  it("offers to download the voice model, showing its progress", async () => {
    let finish!: () => void;
    backend({ ...SPEECH, modelReady: false });
    invoke.mockImplementation((command: string) =>
      command === "speech_status"
        ? Promise.resolve({ ...SPEECH, modelReady: false })
        : command === "download_speech_model"
          ? new Promise<void>((resolve) => (finish = resolve))
          : Promise.resolve(),
    );
    await show();
    expect(screen.getByText(/2.5 GB/)).toBeTruthy();
    const generate = screen.getByRole("button", { name: /Generate/ }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Download voice model/ })));
    expect(invoke).toHaveBeenCalledWith("download_speech_model");
    act(() => useNarration.setState({ download: { received: 1_249_191_805, total: 2_498_383_610 } }));
    expect(screen.getByRole("status").textContent).toContain("50%");
    invoke.mockImplementation(async (command: string) => (command === "speech_status" ? SPEECH : undefined));
    await act(async () => finish());
    expect(screen.queryByRole("button", { name: /Download voice model/ })).toBeNull();
    expect((screen.getByRole("button", { name: /Generate/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says when this platform cannot speak", async () => {
    backend({ ...SPEECH, available: false, modelReady: false });
    await show();
    expect(screen.getByText(/not available on this platform/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Download voice model/ })).toBeNull();
  });

  it("tells whether the slide's audio is there and up to date", async () => {
    backend(SPEECH);
    await show();
    expect(screen.getByText("No audio yet")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Play/ }) as HTMLButtonElement).disabled).toBe(true);
    act(() => audioOf([{ slide: "intro", state: "ready", seconds: 12.4 }]));
    expect(screen.getByText("Audio 0:12")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Play/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: /Regenerate/ })).toBeTruthy();
    act(() => audioOf([{ slide: "intro", state: "stale", seconds: 75 }]));
    expect(screen.getByText("Audio 1:15, out of date")).toBeTruthy();
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
    invoke.mockImplementation((command: string) =>
      command === "render_narration" ? new Promise(() => {}) : Promise.resolve(SPEECH),
    );
    act(() => fireEvent.click(screen.getByRole("button", { name: /Generate all/ })));
    expect(invoke).toHaveBeenCalledWith("render_narration", { id: deckFor(DECK_HTML).id, slides: null });
    act(() => useNarration.setState({ render: { deck: deckFor(DECK_HTML).id, slide: "outro", done: 1, total: 2 } }));
    expect(screen.getByText(/Speaking slide 2 of 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(invoke).toHaveBeenCalledWith("cancel_narration");
  });
});
