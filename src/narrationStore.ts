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
} from "./lib/api";
import { forgetNarration } from "./lib/narrationCache";
import { dirname } from "./lib/utils";
import { showError, useApp } from "./store";

/** The backend's error for a render the user cancelled. */
export const NARRATION_CANCELLED = "the narration was cancelled";

/**
 * Spoken narration (see src-tauri/src/narration/): the providers and their keys, the open
 * deck's audio per slide, and the render running.
 */
interface NarrationState {
  speech: SpeechStatus | null;
  /** Voices a hosted provider's account has beyond its built-in ones (ElevenLabs: the user's own), by provider id. */
  accountVoices: Record<string, NarrationVoice[]>;
  /** The audio of `audioDeck`'s slides, by slide id. */
  audio: Record<string, SlideAudio>;
  audioDeck: string | null;
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
  /** Says the `slides`' (all for null) narration that has no up-to-date audio; false when it failed or was cancelled. */
  renderAudio: (deck: string, slides: string[] | null) => Promise<boolean>;
  cancelRender: () => Promise<void>;
  /**
   * Has the speech-to-text model hear the `slides`' (all for null) up-to-date audio again to
   * time each word, downloading the model first when needed; false when it failed.
   */
  timeWords: (deck: string, slides: string[] | null) => Promise<boolean>;
  /** Deletes the slide's recording, so the narration service can say its script again. */
  deleteRecording: (deck: string, slide: string) => Promise<void>;
}

function fail(error: unknown) {
  const message = errorMessage(error);
  if (message !== NARRATION_CANCELLED) showError(message);
}

/** Whether two slides' audio is the same in all that is known of it. */
function sameAudio(a: SlideAudio, b: SlideAudio): boolean {
  return (
    a.slide === b.slide &&
    a.state === b.state &&
    a.seconds === b.seconds &&
    !a.recorded === !b.recorded &&
    !a.imported === !b.imported &&
    !a.timed === !b.timed
  );
}

/**
 * What `listed`, the audio of deck `deck`'s slides as the backend lists it, makes of what is
 * `known`: the `state` to set, null when it is all as known, and the slides whose audio `changed`
 * (or is gone). What did not change stays the very object it was: a slide whose audio is as
 * before keeps its entry, and when that goes for all of them nothing is set at all, so reading
 * the audio again tells nobody who shows it.
 */
function audioAfter(known: Pick<NarrationState, "audio" | "audioDeck">, deck: string, listed: SlideAudio[]) {
  const before = known.audioDeck === deck ? known.audio : {};
  const audio: Record<string, SlideAudio> = {};
  const changed = Object.keys(before).filter((slide) => !listed.some((entry) => entry.slide === slide));
  for (const entry of listed) {
    const was = before[entry.slide];
    if (was && sameAudio(was, entry)) audio[entry.slide] = was;
    else {
      audio[entry.slide] = entry;
      changed.push(entry.slide);
    }
  }
  const same = known.audioDeck === deck && changed.length === 0;
  return { state: same ? null : { audio, audioDeck: deck }, changed };
}

/** What tells that a deck's audio may be other than it was: the slides, what is said over each, and who says it. */
export function audioKey(deck: Deck): string {
  return JSON.stringify([
    deck.id,
    deck.narration ?? null,
    deck.slides.map((slide) => [slide.id, slide.narration ?? ""]),
  ]);
}

export const useNarration = create<NarrationState>((set, get) => {
  /**
   * Takes in the audio of `deck`'s slides as the backend lists it. What was read of a slide whose
   * audio changed is forgotten (see ./lib/narrationCache.ts), so it is read anew.
   */
  const take = (deck: string, listed: SlideAudio[]) => {
    const { state, changed } = audioAfter(get(), deck, listed);
    for (const slide of changed) forgetNarration(deck, slide);
    if (state) set(state);
  };
  return {
    speech: null,
    accountVoices: {},
    audio: {},
    audioDeck: null,
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
        take(deck, await api.narrationAudio(deck));
      } catch {
        // The deck file is mid-write or gone; the next change refreshes it.
      }
    },

    renderAudio: async (deck, slides) => {
      set({ render: { deck, slide: null, done: 0, total: 0 } });
      try {
        const audio = await api.renderNarration(deck, slides);
        // Said again, a slide's audio may be as long as it was and still be other audio.
        if (slides) for (const slide of slides) forgetNarration(deck, slide);
        else forgetNarration(deck);
        take(deck, audio);
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
        take(deck, audio);
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
        forgetNarration(deck, slide);
        take(deck, audio);
      } catch (error) {
        fail(error);
      }
    },
  };
});

/** Who says the deck's narration: its provider, or the default (the first) when the deck names none (or one unknown). */
export function deckProvider(deck: Deck, speech: SpeechStatus): NarrationProvider | undefined {
  const id = deck.narration?.provider;
  return speech.providers.find((p) => p.id === id) ?? speech.providers[0];
}

/** Whether `provider` can say narration now: it has an API key. */
export function canSpeakWith(speech: SpeechStatus | null, provider: NarrationProvider | undefined): boolean {
  return !!speech && !!provider && provider.key !== null;
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

/**
 * Keeps the narration state in step with backend events and the open deck. The deck's audio is
 * read again when something it depends on changed (see `audioKey`), not for every other edit of
 * the deck: each saved slide brings a new deck.
 */
export async function initNarrationEvents() {
  const refresh = (deck: string) => void useNarration.getState().refreshAudio(deck);
  const open = () => useApp.getState().deck?.id;
  // Listening starts for all three at once: none waits for the one before.
  await Promise.all([
    listen<NarrationRenderProgress>("narration-render", ({ payload }) => {
      // Renders started in another window, or by a video export, show here too.
      useNarration.setState({ render: payload.slide === null ? null : payload });
      if (payload.deck === open()) refresh(payload.deck);
    }),
    listen<NarrationTimingProgress>("narration-timing", ({ payload }) => {
      // Only the window timing the words shows its progress.
      if (useNarration.getState().timing?.deck === payload.deck && payload.slide !== null) {
        useNarration.setState({ timing: payload });
      }
      if (payload.deck === open()) refresh(payload.deck);
    }),
    // Recorded in the presenter view, maybe in its own window: other audio, however long.
    listen<string>("narration-recorded", ({ payload }) => {
      forgetNarration(payload);
      if (payload === open()) refresh(payload);
    }),
  ]);
  // A changed deck (a script, the voice or language) changes which audio is up to date.
  let last: Deck | null = null;
  let key: string | null = null;
  // Audio written outside the app, such as by the agent, changes it too.
  let change = useApp.getState().workspaceChange;
  useApp.subscribe((state) => {
    const changed = state.workspaceChange !== change;
    change = state.workspaceChange;
    if (state.deck !== last) {
      last = state.deck;
      const next = state.deck ? audioKey(state.deck) : null;
      if (next === key) return;
      key = next;
      if (state.deck) refresh(state.deck.id);
    } else if (changed && state.deck && state.openedFile && change) {
      if (touchesNarration(change.paths, state.openedFile.path)) {
        forgetNarration(state.deck.id);
        refresh(state.deck.id);
      }
    }
  });
}
