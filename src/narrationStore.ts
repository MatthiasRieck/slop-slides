import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  api,
  type Deck,
  errorMessage,
  type NarrationRenderProgress,
  type SlideAudio,
  type SpeechStatus,
  type VoiceDownloadProgress,
} from "./lib/api";
import { useApp } from "./store";

/** The backend's error for a render the user cancelled. */
export const NARRATION_CANCELLED = "the narration was cancelled";

/**
 * Spoken narration (see src-tauri/src/narration/): whether the voice model is there, the open
 * deck's audio per slide, and the download or render running.
 */
interface NarrationState {
  speech: SpeechStatus | null;
  /** The audio of `audioDeck`'s slides, by slide id. */
  audio: Record<string, SlideAudio>;
  audioDeck: string | null;
  /** While the model downloads, how far it has got. */
  download: VoiceDownloadProgress | null;
  /** While narration is said, how far it has got. */
  render: NarrationRenderProgress | null;
  loadSpeech: () => Promise<void>;
  /** Reads the deck's audio state again (after its narration, voice or language changed). */
  refreshAudio: (deck: string) => Promise<void>;
  downloadModel: () => Promise<void>;
  /** Says the `slides`' (all for null) narration that has no up-to-date audio; false when it failed or was cancelled. */
  renderAudio: (deck: string, slides: string[] | null) => Promise<boolean>;
  cancelRender: () => Promise<void>;
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
  audio: {},
  audioDeck: null,
  download: null,
  render: null,

  loadSpeech: async () => {
    try {
      set({ speech: await api.speechStatus() });
    } catch (error) {
      fail(error);
    }
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
}));

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
  // A changed deck (a script, the voice or language) changes which audio is up to date.
  let last: Deck | null = null;
  useApp.subscribe((state) => {
    if (state.deck === last) return;
    last = state.deck;
    if (state.deck) void useNarration.getState().refreshAudio(state.deck.id);
  });
}
