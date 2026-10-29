import { api } from "./api";

/** A slide's narration audio, playing; `stop` ends it early. */
export interface Playback {
  /** Resolves when the audio has played to its end, or was stopped. */
  ended: Promise<void>;
  stop: () => void;
}

/** Plays a slide's narration audio (its WAV file in the deck's `narration/` folder). */
export async function playNarration(deck: string, slide: string): Promise<Playback> {
  const bytes = await api.narrationWav(deck, slide);
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  const audio = new Audio(url);
  let finish = () => {};
  const ended = new Promise<void>((resolve) => {
    finish = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
  });
  audio.addEventListener("ended", finish, { once: true });
  audio.addEventListener("error", finish, { once: true });
  const stop = () => {
    audio.pause();
    finish();
  };
  try {
    await audio.play();
  } catch (error) {
    stop();
    throw error;
  }
  return { ended, stop };
}

/** `seconds` as "0:12". */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
