import { api, type Deck, errorMessage, type SlideTiming } from "../lib/api";
import { cleanNarrationPrompt } from "../lib/narration";
import { promptAgent } from "./composer";
import { queueEdit } from "./editQueue";
import { editRail } from "./slides";
import type { AppStore, Slice } from "./types";

/**
 * What is said over the slides, as the deck file holds it: narration, speaker notes, timing and
 * the voice (the audio said from it is in ../narrationStore.ts).
 */
export interface NarrationSlice {
  /** Saves what is said over `slide` (empty removes it), after any slide edits still being saved. */
  setNarration: (slide: string, text: string) => Promise<void>;
  /** Saves the speaker notes of `slide` (empty removes them), after any slide edits still being saved. */
  setNotes: (slide: string, text: string) => Promise<void>;
  /** Sets the seconds expected on the slide; 0 removes them. */
  setSlideTime: (slide: string, seconds: number) => Promise<void>;
  /** Hands the composer a request to clean up the recorded narration of `slide`, or (null) of every slide. */
  cleanNarration: (slide: string | null) => void;
  /** Saves slides' timing on the narration timeline, as one change the rail's history can undo. */
  setSlideTiming: (timing: SlideTiming[]) => Promise<void>;
  /** Sets the voice (or language) the deck's narration is said in. */
  setNarrationVoice: (voice: string) => Promise<void>;
  setNarrationProvider: (provider: string) => Promise<void>;
  setNarrationLanguage: (language: string) => Promise<void>;
}

/** Queues `change` to the open deck after the edits before it, and shows the deck it gives back. */
function editDeck(app: AppStore, change: (id: string) => Promise<Deck>): Promise<void> {
  return queueEdit(async () => {
    const { deck } = app.getState();
    if (!deck) return;
    try {
      const next = await change(deck.id);
      if (app.getState().deck?.id === deck.id) app.getState().setDeck(next);
    } catch (error) {
      app.setState({ error: errorMessage(error) });
    }
  });
}

export const createNarrationSlice: Slice<NarrationSlice> = (_set, _get, app) => ({
  setNarration: (slide, text) => editDeck(app, (id) => api.setSlideNarration(id, slide, text)),

  setNotes: (slide, text) => editDeck(app, (id) => api.setSlideNotes(id, slide, text)),

  setSlideTime: (slide, seconds) => editDeck(app, (id) => api.setSlideTime(id, slide, seconds)),

  cleanNarration: (slide) => promptAgent(app, cleanNarrationPrompt(slide)),

  setSlideTiming: async (timing) => {
    if (timing.length > 0) await editRail(app, (id) => api.setSlideTiming(id, timing));
  },

  setNarrationVoice: (voice) => editDeck(app, (id) => api.setNarrationVoice(id, voice)),

  setNarrationProvider: (provider) => editDeck(app, (id) => api.setNarrationProvider(id, provider)),

  setNarrationLanguage: (language) => editDeck(app, (id) => api.setNarrationLanguage(id, language)),
});
