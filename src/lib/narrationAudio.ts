import { borrowNarrationSound } from "./narrationCache";

export { formatDuration } from "./narration";

/** A slide's narration audio, playing; `stop` ends it early, `pause` holds it where it is. */
export interface Playback {
  /** Resolves when the audio has played to its end, or was stopped. */
  ended: Promise<void>;
  stop: () => void;
  /** Holds it where it is, to `resume` from there. */
  pause: () => void;
  /** Plays on from where it was paused. */
  resume: () => Promise<void>;
  /** Where it is in the audio, in seconds. */
  time: () => number;
}

/**
 * Plays a slide's narration audio (its WAV file in the deck's `narration/` folder), `from`
 * seconds in. Loading the audio takes a moment, long for a long file: a function for `from`
 * is asked once it has loaded, so it starts where it should be by then. Audio played before is
 * still there (see ./narrationCache.ts), and starts at once.
 */
export async function playNarration(deck: string, slide: string, from: number | (() => number) = 0): Promise<Playback> {
  const sound = await borrowNarrationSound(deck, slide);
  const audio = new Audio(sound.url);
  audio.currentTime = Math.max(0, typeof from === "function" ? from() : from);
  let finish = () => {};
  const ended = new Promise<void>((resolve) => {
    finish = () => {
      sound.release();
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
  return {
    ended,
    stop,
    pause: () => audio.pause(),
    resume: () => audio.play(),
    time: () => audio.currentTime,
  };
}
