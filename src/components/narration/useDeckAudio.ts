import type { SlideAudio } from "../../lib/api";
import { useNarration } from "../../narrationStore";

/** No audio known yet; one object, so selecting it does not re-render. */
const NO_AUDIO: Record<string, SlideAudio> = {};

/** What is known of the audio of each slide of the deck `deckId`, by slide; empty while that is not known. */
export function useDeckAudio(deckId: string | undefined): Record<string, SlideAudio> {
  return useNarration((s) => (deckId !== undefined && s.audioDeck === deckId ? s.audio : NO_AUDIO));
}
