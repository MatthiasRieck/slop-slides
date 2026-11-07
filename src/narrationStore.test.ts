import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, listen } from "./test/tauri";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
listen.mockImplementation(async (event: string, handler: (event: { payload: unknown }) => void) => {
  listeners.set(event, handler);
  return () => {};
});

import type { SpeechStatus } from "./lib/api";
import {
  canSpeakWith,
  deckProvider,
  initNarrationEvents,
  NARRATION_CANCELLED,
  touchesNarration,
  useNarration,
} from "./narrationStore";
import { useApp } from "./store";
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
    download: null,
    timing: null,
  });
  useApp.setState({ deck: null, error: null });
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
    expect(useApp.getState().error).toBe("Slide intro: the speech engine stopped unexpectedly");
    expect(useNarration.getState().render).toBeNull();

    useApp.setState({ error: null });
    invoke.mockImplementation(async (command: string) => {
      if (command === "render_narration") throw NARRATION_CANCELLED;
      return [];
    });
    expect(await useNarration.getState().renderAudio(deck.id, null)).toBe(false);
    expect(useApp.getState().error).toBeNull();
  });

  it("shows download progress only while it downloads", async () => {
    await initNarrationEvents();
    const progress = listeners.get("speech-download");
    progress?.({ payload: { received: 5, total: 10 } });
    expect(useNarration.getState().download).toBeNull();
    let finish!: () => void;
    invoke.mockImplementation((command: string) =>
      command === "download_speech_model" ? new Promise<void>((r) => (finish = r)) : Promise.resolve(null),
    );
    const done = useNarration.getState().downloadModel();
    progress?.({ payload: { received: 5, total: 10 } });
    expect(useNarration.getState().download).toEqual({ received: 5, total: 10 });
    finish();
    await done;
    expect(useNarration.getState().download).toBeNull();
    expect(invoke).toHaveBeenCalledWith("speech_status");
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
    expect(useApp.getState().error).toBe("Slide intro: Transcription failed");
    expect(useNarration.getState().timing).toBeNull();
  });
});

const SPEECH: SpeechStatus = {
  available: true,
  modelReady: false,
  modelBytes: 1,
  downloading: false,
  rendering: null,
  providers: [
    { id: "local", name: "Local voice model", needsKey: false, key: null, voices: [] },
    { id: "openai", name: "OpenAI", needsKey: true, key: null, voices: [] },
    { id: "elevenlabs", name: "ElevenLabs", needsKey: true, key: "environment", voices: [] },
  ],
  languages: [],
};

describe("narration providers", () => {
  it("finds the deck's provider, the local model without one or for an unknown one", () => {
    const named = (provider?: string) => ({ ...deck, narration: { provider, voice: "x", language: "en" } });
    expect(deckProvider(deck, SPEECH)?.id).toBe("local");
    expect(deckProvider(named("openai"), SPEECH)?.id).toBe("openai");
    expect(deckProvider(named("acme"), SPEECH)?.id).toBe("local");
  });

  it("can speak with the local model once downloaded, and with a hosted one once it has a key", () => {
    const [local, openai, eleven] = SPEECH.providers;
    expect(canSpeakWith(SPEECH, local)).toBe(false);
    expect(canSpeakWith({ ...SPEECH, modelReady: true }, local)).toBe(true);
    expect(canSpeakWith({ ...SPEECH, available: false, modelReady: true }, local)).toBe(false);
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
    expect(useApp.getState().error).toContain("no spaces");
  });

  it("keeps the built-in voices when the account's cannot be listed", async () => {
    const voices = [{ id: "abcdefghij1234567890", name: "Me", description: "Your voice" }];
    invoke.mockResolvedValue(voices);
    await useNarration.getState().loadVoices("elevenlabs");
    expect(useNarration.getState().accountVoices.elevenlabs).toEqual(voices);
    invoke.mockRejectedValue("offline");
    await useNarration.getState().loadVoices("openai");
    expect(useNarration.getState().accountVoices.openai).toBeUndefined();
    expect(useApp.getState().error).toBeNull();
  });
});
