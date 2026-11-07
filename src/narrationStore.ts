import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  api,
  type Deck,
  errorMessage,
  type NarrationProvider,
  type NarrationRenderProgress,
  type NarrationTimingProgress,
  type NarrationVoice,
  type SlideAudio,
  type SpeechStatus,
  type VoiceDownloadProgress,
} from "./lib/api";
import { dirname } from "./lib/utils";
import { useApp } from "./store";

/** The backend's error for a render the user cancelled. */
export const NARRATION_CANCELLED = "the narration was cancelled";

/**
 * Spoken narration (see src-tauri/src/narration/): whether the voice model is there, the open
 * deck's audio per slide, and the download or render running.
 */
interface NarrationState {
  speech: SpeechStatus | null;
  /** Voices a hosted provider's account has beyond its built-in ones (ElevenLabs: the user's own), by provider id. */
  accountVoices: Record<string, NarrationVoice[]>;
  /** The audio of `audioDeck`'s slides, by slide id. */
  audio: Record<string, SlideAudio>;
  audioDeck: string | null;
  /** While the model downloads, how far it has got. */
  download: VoiceDownloadProgress | null;
  /** While narration is said, how far it has got. */
  render: NarrationRenderProgress | null;
  /** While narration audio is heard again to time its words, how far it has got; `downloading` while the speech-to-text model downloads first. */
  timing: (NarrationTimingProgress & { downloading?: boolean }) | null;
  loadSpeech: () => Promise<void>;
  /** Asks a hosted provider for every voice its account can use; the built-in ones stay on failure. */
  loadVoices: (provider: string) => Promise<void>;
  /** Saves a hosted provider's API key (or forgets it for null); false when it failed. */
  setKey: (provider: string, key: string | null) => Promise<boolean>;
  /** Reads the deck's audio state again (after its narration, voice or language changed). */
  refreshAudio: (deck: string) => Promise<void>;
  downloadModel: () => Promise<void>;
  /** Says the `slides`' (all for null) narration that has no up-to-date audio; false when it failed or was cancelled. */
  renderAudio: (deck: string, slides: string[] | null) => Promise<boolean>;
  cancelRender: () => Promise<void>;
  /**
   * Has the speech-to-text model hear the `slides`' (all for null) up-to-date audio again to
   * time each word, downloading the model first when needed; false when it failed.
   */
  timeWords: (deck: string, slides: string[] | null) => Promise<boolean>;
  /** Deletes the slide's recording, so the voice model can say its narration again. */
  deleteRecording: (deck: string, slide: string) => Promise<void>;
}

function fail(error: unknown) {
  const message = errorMessage(error);
  if (message !== NARRATION_CANCELLED) useApp.getState().setError(message);
}

function byId(audio: SlideAudio[]): Record<string, SlideAudio> {
  return Object.fromEntries(audio.map((a) => [a.slide, a]));
}

export const useNarration = create<NarrationState>((set, get) => ({
  speech: null,
  accountVoices: {},
  audio: {},
  audioDeck: null,
  download: null,
  render: null,
  timing: null,

  loadSpeech: async () => {
    try {
      set({ speech: await api.speechStatus() });
    } catch (error) {
      fail(error);
    }
  },

  loadVoices: async (provider) => {
    try {
      const voices = await api.speechVoices(provider);
      if (voices.length > 0) set((s) => ({ accountVoices: { ...s.accountVoices, [provider]: voices } }));
    } catch {
      // Offline or a key it does not accept: the built-in voices do, and saying narration tells why.
    }
  },

  setKey: async (provider, key) => {
    try {
      set({ speech: await api.setSpeechKey(provider, key) });
    } catch (error) {
      fail(error);
      return false;
    }
    set((s) => {
      const { [provider]: _, ...rest } = s.accountVoices;
      return { accountVoices: rest };
    });
    return true;
  },

  refreshAudio: async (deck) => {
    try {
      const audio = await api.narrationAudio(deck);
      set({ audio: byId(audio), audioDeck: deck });
    } catch {
      // The deck file is mid-write or gone; the next change refreshes it.
    }
  },

  downloadModel: async () => {
    set({ download: { received: 0, total: get().speech?.modelBytes ?? 0 } });
    try {
      await api.downloadSpeechModel();
    } catch (error) {
      fail(error);
    }
    set({ download: null });
    await get().loadSpeech();
  },

  renderAudio: async (deck, slides) => {
    set({ render: { deck, slide: null, done: 0, total: 0 } });
    try {
      const audio = await api.renderNarration(deck, slides);
      set({ audio: byId(audio), audioDeck: deck });
      return true;
    } catch (error) {
      fail(error);
      await get().refreshAudio(deck);
      return false;
    } finally {
      set({ render: null });
    }
  },

  cancelRender: async () => {
    await api.cancelNarration();
  },

  timeWords: async (deck, slides) => {
    if (get().timing) return false;
    set({ timing: { deck, slide: null, done: 0, total: 0 } });
    try {
      if (!(await api.voiceStatus()).modelReady) {
        set({ timing: { deck, slide: null, done: 0, total: 0, downloading: true } });
        await api.downloadVoiceModel();
      }
      const audio = await api.timeNarration(deck, slides);
      set({ audio: byId(audio), audioDeck: deck });
      return true;
    } catch (error) {
      fail(error);
      await get().refreshAudio(deck);
      return false;
    } finally {
      set({ timing: null });
    }
  },

  deleteRecording: async (deck, slide) => {
    try {
      const audio = await api.deleteRecordedNarration(deck, slide);
      set({ audio: byId(audio), audioDeck: deck });
    } catch (error) {
      fail(error);
    }
  },
}));

/** Who says the deck's narration: its provider, or the local model when the deck names none (or one unknown). */
export function deckProvider(deck: Deck, speech: SpeechStatus): NarrationProvider | undefined {
  const id = deck.narration?.provider ?? "local";
  return speech.providers.find((p) => p.id === id) ?? speech.providers.find((p) => p.id === "local");
}

/** Whether `provider` can say narration now: the local model downloaded here, a hosted service with its key. */
export function canSpeakWith(speech: SpeechStatus | null, provider: NarrationProvider | undefined): boolean {
  if (!speech || !provider) return false;
  return provider.needsKey ? provider.key !== null : speech.available && speech.modelReady;
}

/**
 * Whether workspace-relative `paths` touch the narration audio of the deck at `deckPath`, as
 * the agent's `set_narration_audio` and `generate_narration_audio` tools do from outside the app.
 */
export function touchesNarration(paths: string[], deckPath: string): boolean {
  const folder = dirname(deckPath);
  const audio = folder ? `${folder}/narration/` : "narration/";
  return paths.some((path) => path.startsWith(audio));
}

/** Keeps the narration state in step with backend events and the open deck. */
export async function initNarrationEvents() {
  await listen<VoiceDownloadProgress>("speech-download", ({ payload }) => {
    if (useNarration.getState().download) useNarration.setState({ download: payload });
  });
  await listen<NarrationRenderProgress>("narration-render", ({ payload }) => {
    // Renders started in another window, or by a video export, show here too.
    useNarration.setState({ render: payload.slide === null ? null : payload });
    if (payload.deck === useApp.getState().deck?.id) void useNarration.getState().refreshAudio(payload.deck);
  });
  await listen<NarrationTimingProgress>("narration-timing", ({ payload }) => {
    // Only the window timing the words shows its progress.
    if (useNarration.getState().timing?.deck === payload.deck && payload.slide !== null) {
      useNarration.setState({ timing: payload });
    }
    if (payload.deck === useApp.getState().deck?.id) void useNarration.getState().refreshAudio(payload.deck);
  });
  // Recorded in the presenter view, maybe in its own window.
  await listen<string>("narration-recorded", ({ payload }) => {
    if (payload === useApp.getState().deck?.id) void useNarration.getState().refreshAudio(payload);
  });
  // A changed deck (a script, the voice or language) changes which audio is up to date.
  let last: Deck | null = null;
  // Audio written outside the app, such as by the agent, changes it too.
  let change = useApp.getState().workspaceChange;
  useApp.subscribe((state) => {
    const changed = state.workspaceChange !== change;
    change = state.workspaceChange;
    if (state.deck !== last) {
      last = state.deck;
      if (state.deck) void useNarration.getState().refreshAudio(state.deck.id);
    } else if (changed && state.deck && state.openedFile && change) {
      if (touchesNarration(change.paths, state.openedFile.path))
        void useNarration.getState().refreshAudio(state.deck.id);
    }
  });
}
