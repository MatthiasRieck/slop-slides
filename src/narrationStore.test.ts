import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, listen } from "./test/tauri";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
listen.mockImplementation(async (event: string, handler: (event: { payload: unknown }) => void) => {
  listeners.set(event, handler);
  return () => {};
});

import type { SpeechStatus } from "./lib/api";
import { forgetNarration, narrationPeaks } from "./lib/narrationCache";
import {
  audioKey,
  canSpeakWith,
  deckProvider,
  initNarrationEvents,
  NARRATION_CANCELLED,
  touchesNarration,
  useNarration,
} from "./narrationStore";
import { useApp } from "./store";
import { lastError } from "./store/errors";
import { DECK_HTML, deckFor } from "./test/fixtures";

const deck = deckFor(DECK_HTML);

beforeEach(() => {
  invoke.mockReset();
  useNarration.setState({
    speech: null,
    accountVoices: {},
    audio: {},
    audioDeck: null,
    render: null,
    timing: null,
  });
  useApp.setState({ deck: null, toasts: [] });
});

describe("narration store", () => {
  it("keeps the open deck's audio up to date as the deck changes", async () => {
    await initNarrationEvents();
    invoke.mockResolvedValue([{ slide: "intro", state: "ready", seconds: 3 }]);
    await act(async () => useApp.setState({ deck }));
    expect(invoke).toHaveBeenCalledWith("narration_audio", { id: deck.id });
    expect(useNarration.getState().audioDeck).toBe(deck.id);
    expect(useNarration.getState().audio.intro?.seconds).toBe(3);
  });

  it("reads the audio again when its files change outside the app", async () => {
    await initNarrationEvents();
    invoke.mockResolvedValue([]);
    await act(async () =>
      useApp.setState({ deck, openedFile: { path: "talks/deck.html", absolute: deck.id, kind: "deck" } }),
    );
    invoke.mockClear();
    invoke.mockResolvedValue([{ slide: "intro", state: "ready", seconds: 4, recorded: true, timed: true }]);
    await act(async () => useApp.setState({ workspaceChange: { paths: ["talks/notes.md"], rev: 1 } }));
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => useApp.setState({ workspaceChange: { paths: ["talks/narration/manifest.json"], rev: 2 } }));
    expect(invoke).toHaveBeenCalledWith("narration_audio", { id: deck.id });
    expect(useNarration.getState().audio.intro?.timed).toBe(true);
  });

  it("knows which changed files are a deck's narration audio", () => {
    expect(touchesNarration(["narration/intro.wav"], "deck.html")).toBe(true);
    expect(touchesNarration(["talks/narration/q3/intro.wav"], "talks/q3.html")).toBe(true);
    expect(touchesNarration(["other/narration/intro.wav"], "talks/deck.html")).toBe(false);
    expect(touchesNarration(["narration.md", "deck.html"], "deck.html")).toBe(false);
  });

  it("follows renders as they go, from any window", async () => {
    await initNarrationEvents();
    useApp.setState({ deck });
    invoke.mockResolvedValue([]);
    const render = listeners.get("narration-render");
    act(() => render?.({ payload: { deck: deck.id, slide: "intro", done: 0, total: 2 } }));
    expect(useNarration.getState().render?.slide).toBe("intro");
    act(() => render?.({ payload: { deck: deck.id, slide: null, done: 2, total: 2 } }));
    expect(useNarration.getState().render).toBeNull();
  });

  it("reports a failed render but not a cancelled one", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "render_narration") throw "Slide intro: the speech engine stopped unexpectedly";
      return [];
    });
    expect(await useNarration.getState().renderAudio(deck.id, ["intro"])).toBe(false);
    expect(lastError(useApp.getState())).toBe("Slide intro: the speech engine stopped unexpectedly");
    expect(useNarration.getState().render).toBeNull();

    useApp.setState({ toasts: [] });
    invoke.mockImplementation(async (command: string) => {
      if (command === "render_narration") throw NARRATION_CANCELLED;
      return [];
    });
    expect(await useNarration.getState().renderAudio(deck.id, null)).toBe(false);
    expect(lastError(useApp.getState())).toBeNull();
  });

  it("times words, downloading the speech-to-text model first when it is missing", async () => {
    await initNarrationEvents();
    useApp.setState({ deck });
    let ready = false;
    let finish!: (audio: unknown) => void;
    invoke.mockImplementation(async (command: string) => {
      if (command === "voice_status") return { modelReady: ready };
      if (command === "download_voice_model") ready = true;
      if (command === "time_narration") return new Promise((r) => (finish = r));
      return [];
    });
    const done = useNarration.getState().timeWords(deck.id, null);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("time_narration", { id: deck.id, slides: null }));
    expect(invoke).toHaveBeenCalledWith("download_voice_model");
    // Another timing waits for this one.
    expect(await useNarration.getState().timeWords(deck.id, null)).toBe(false);
    const timing = listeners.get("narration-timing");
    act(() => timing?.({ payload: { deck: deck.id, slide: "intro", done: 0, total: 1 } }));
    expect(useNarration.getState().timing).toEqual({ deck: deck.id, slide: "intro", done: 0, total: 1 });
    finish([{ slide: "intro", state: "ready", seconds: 3, timed: true }]);
    expect(await done).toBe(true);
    expect(useNarration.getState().timing).toBeNull();
    expect(useNarration.getState().audio.intro?.timed).toBe(true);

    // With the model there, it is not downloaded again; a failure is reported.
    invoke.mockClear();
    invoke.mockImplementation(async (command: string) => {
      if (command === "voice_status") return { modelReady: true };
      if (command === "time_narration") throw "Slide intro: Transcription failed";
      return [];
    });
    expect(await useNarration.getState().timeWords(deck.id, ["intro"])).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith("download_voice_model");
    expect(lastError(useApp.getState())).toBe("Slide intro: Transcription failed");
    expect(useNarration.getState().timing).toBeNull();
  });
});

describe("reading the deck's audio again", () => {
  const READY = [
    { slide: "intro", state: "ready", seconds: 3 },
    { slide: "outro", state: "missing", seconds: null },
  ];
  const audioAsked = () => invoke.mock.calls.filter(([command]) => command === "narration_audio").length;
  const peaksAsked = () => invoke.mock.calls.filter(([command]) => command === "narration_peaks").length;

  beforeEach(() => forgetNarration());

  it("tells nobody when the audio is as it was", async () => {
    invoke.mockImplementation(async () => READY.map((audio) => ({ ...audio })));
    await useNarration.getState().refreshAudio(deck.id);
    const before = useNarration.getState().audio;
    const told = vi.fn();
    const stop = useNarration.subscribe(told);
    await useNarration.getState().refreshAudio(deck.id);
    await useNarration.getState().refreshAudio(deck.id);
    expect(told).not.toHaveBeenCalled();
    expect(useNarration.getState().audio).toBe(before);
    stop();
  });

  it("keeps the slides whose audio did not change as they were, and forgets what was read of one that did", async () => {
    invoke.mockImplementation(async (command: string) => (command === "narration_peaks" ? [0.5] : READY));
    await useNarration.getState().refreshAudio(deck.id);
    const before = useNarration.getState().audio;
    await Promise.all([narrationPeaks(deck.id, "intro"), narrationPeaks(deck.id, "outro")]);
    expect(peaksAsked()).toBe(2);
    invoke.mockImplementation(async (command: string) =>
      command === "narration_peaks" ? [1] : [READY[0], { slide: "outro", state: "ready", seconds: 2 }],
    );
    await useNarration.getState().refreshAudio(deck.id);
    const after = useNarration.getState().audio;
    expect(after).not.toBe(before);
    expect(after.intro).toBe(before.intro);
    expect(after.outro).toEqual({ slide: "outro", state: "ready", seconds: 2 });
    // Only the changed slide's waveform is read anew.
    await Promise.all([narrationPeaks(deck.id, "intro"), narrationPeaks(deck.id, "outro")]);
    expect(peaksAsked()).toBe(3);
  });

  it("sets it for another deck, and for a slide that is gone", async () => {
    invoke.mockResolvedValue(READY);
    await useNarration.getState().refreshAudio(deck.id);
    await useNarration.getState().refreshAudio("other");
    expect(useNarration.getState().audioDeck).toBe("other");
    invoke.mockResolvedValue([READY[0]]);
    await useNarration.getState().refreshAudio("other");
    expect(Object.keys(useNarration.getState().audio)).toEqual(["intro"]);
  });

  it("forgets audio said again, though it is as long as before", async () => {
    invoke.mockImplementation(async (command: string) => (command === "narration_peaks" ? [0.5] : READY));
    await useNarration.getState().refreshAudio(deck.id);
    await narrationPeaks(deck.id, "intro");
    await useNarration.getState().renderAudio(deck.id, ["intro"]);
    await narrationPeaks(deck.id, "intro");
    expect(peaksAsked()).toBe(2);
  });

  it("only when what the audio depends on changed, not for every new deck", async () => {
    await initNarrationEvents();
    invoke.mockResolvedValue(READY);
    await act(async () => useApp.setState({ deck }));
    const asked = audioAsked();
    expect(asked).toBeGreaterThan(0);
    // A slide saved: another deck object, another markup, the same words in the same voice.
    const saved = { ...deck, slides: deck.slides.map((slide) => ({ ...slide, hash: `${slide.hash}'` })) };
    expect(audioKey(saved)).toBe(audioKey(deck));
    await act(async () => useApp.setState({ deck: saved }));
    expect(audioAsked()).toBe(asked);
    // Other words over a slide, or another voice.
    const said = { ...saved, slides: saved.slides.map((slide, i) => (i ? slide : { ...slide, narration: "Hi." })) };
    await act(async () => useApp.setState({ deck: said }));
    expect(audioAsked()).toBeGreaterThan(asked);
    const again = audioAsked();
    await act(async () => useApp.setState({ deck: { ...said, narration: { voice: "coral", language: "en" } } }));
    expect(audioAsked()).toBeGreaterThan(again);
  });

  it("starts listening to the backend's events together", () => {
    listen.mockClear();
    const pending = new Promise<() => void>(() => {});
    listen.mockImplementationOnce(() => pending);
    listen.mockImplementationOnce(() => pending);
    listen.mockImplementationOnce(() => pending);
    void initNarrationEvents();
    // None waits for the one before to be registered.
    expect(listen.mock.calls.map(([event]) => event)).toEqual([
      "narration-render",
      "narration-timing",
      "narration-recorded",
    ]);
  });
});

const SPEECH: SpeechStatus = {
  rendering: null,
  providers: [
    { id: "openai", name: "OpenAI", key: null, voices: [] },
    { id: "elevenlabs", name: "ElevenLabs", key: "environment", voices: [] },
  ],
  languages: [],
};

describe("narration providers", () => {
  it("finds the deck's provider, the default (first) without one or for an unknown one", () => {
    const named = (provider?: string) => ({ ...deck, narration: { provider, voice: "x", language: "en" } });
    expect(deckProvider(deck, SPEECH)?.id).toBe("openai");
    expect(deckProvider(named("elevenlabs"), SPEECH)?.id).toBe("elevenlabs");
    expect(deckProvider(named("acme"), SPEECH)?.id).toBe("openai");
    // A deck made for the removed local voice model.
    expect(deckProvider(named("local"), SPEECH)?.id).toBe("openai");
  });

  it("can speak with a provider once it has a key", () => {
    const [openai, eleven] = SPEECH.providers;
    expect(canSpeakWith(SPEECH, undefined)).toBe(false);
    expect(canSpeakWith(SPEECH, openai)).toBe(false);
    expect(canSpeakWith(SPEECH, { ...openai!, key: "saved" })).toBe(true);
    expect(canSpeakWith(SPEECH, eleven)).toBe(true);
    expect(canSpeakWith(null, eleven)).toBe(false);
  });

  it("saves a key, forgetting the voices listed with the old one", async () => {
    useNarration.setState({ accountVoices: { openai: [{ id: "a", name: "A", description: "" }] } });
    invoke.mockResolvedValue(SPEECH);
    expect(await useNarration.getState().setKey("openai", "sk")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("set_speech_key", { provider: "openai", key: "sk" });
    expect(useNarration.getState().speech).toEqual(SPEECH);
    expect(useNarration.getState().accountVoices).toEqual({});
    invoke.mockRejectedValue("An API key has no spaces in it.");
    expect(await useNarration.getState().setKey("openai", "a b")).toBe(false);
    expect(lastError(useApp.getState())).toContain("no spaces");
  });

  it("keeps the built-in voices when the account's cannot be listed", async () => {
    const voices = [{ id: "abcdefghij1234567890", name: "Me", description: "Your voice" }];
    invoke.mockResolvedValue(voices);
    await useNarration.getState().loadVoices("elevenlabs");
    expect(useNarration.getState().accountVoices.elevenlabs).toEqual(voices);
    invoke.mockRejectedValue("offline");
    await useNarration.getState().loadVoices("openai");
    expect(useNarration.getState().accountVoices.openai).toBeUndefined();
    expect(lastError(useApp.getState())).toBeNull();
  });
});
