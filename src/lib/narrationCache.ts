import { api } from "./api";

/**
 * What was read of the slides' narration audio, kept so it is read once: each slide's waveform,
 * shown by the timeline and the Narration tab alike, and its sound, a whole WAV file that comes
 * over from the backend every time it is asked for. Both belong to the audio as it was when they
 * were read: whoever learns that a slide's audio changed says so with `forgetNarration` (the
 * narration store does, see ../narrationStore.ts), and the next one to ask reads it anew.
 */

/** How many slides' sounds are kept at most: each is a whole file in memory. */
export const SOUNDS_KEPT = 8;

/** A slide's sound: the object URL of its WAV file, who plays it now, and whether it is still kept for the next. */
interface Sound {
  url: Promise<string>;
  users: number;
  kept: boolean;
}

/** A slide's sound, for as long as it is played. */
export interface BorrowedSound {
  /** An object URL of its WAV file. */
  url: string;
  /** Says it is no longer played. Once, however often it is called. */
  release: () => void;
}

const peaks = new Map<string, Promise<number[] | null>>();
// The one played last is last.
const sounds = new Map<string, Sound>();

const keyOf = (deck: string, slide: string) => `${deck}\n${slide}`;

/** How loud the slide's audio is along its length (see `api.narrationPeaks`), read once per audio. */
export function narrationPeaks(deck: string, slide: string): Promise<number[] | null> {
  const key = keyOf(deck, slide);
  const known = peaks.get(key);
  if (known) return known;
  const read = api.narrationPeaks(deck, slide);
  peaks.set(key, read);
  // What could not be read is asked for again by the next.
  read.catch(() => peaks.get(key) === read && peaks.delete(key));
  return read;
}

/** Frees a sound's file once nobody plays it and it is not kept for the next. */
function settle(sound: Sound) {
  if (sound.kept || sound.users > 0) return;
  void sound.url.then(
    (url) => URL.revokeObjectURL(url),
    () => {},
  );
}

function drop(key: string) {
  const sound = sounds.get(key);
  if (!sound) return;
  sounds.delete(key);
  sound.kept = false;
  settle(sound);
}

/**
 * The slide's sound to play, read once per audio and kept for the next few plays. The file stays
 * until `release` is called, also when it is forgotten meanwhile: what plays is never cut off.
 */
export async function borrowNarrationSound(deck: string, slide: string): Promise<BorrowedSound> {
  const key = keyOf(deck, slide);
  const sound: Sound = sounds.get(key) ?? {
    url: api.narrationWav(deck, slide).then((bytes) => URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }))),
    users: 0,
    kept: true,
  };
  sounds.delete(key);
  sounds.set(key, sound);
  for (const oldest of [...sounds.keys()].slice(0, Math.max(0, sounds.size - SOUNDS_KEPT))) drop(oldest);
  sound.users += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    sound.users -= 1;
    settle(sound);
  };
  try {
    return { url: await sound.url, release };
  } catch (error) {
    // What could not be read is asked for again by the next.
    if (sounds.get(key) === sound) sounds.delete(key);
    release();
    throw error;
  }
}

/**
 * Forgets what was read of the audio of `slide` of `deck`, of all the deck's slides without one,
 * and of every deck without either: its audio changed, or may have.
 */
export function forgetNarration(deck?: string, slide?: string) {
  const prefix = deck === undefined ? "" : slide === undefined ? `${deck}\n` : keyOf(deck, slide);
  const meant = (key: string) => (slide === undefined ? key.startsWith(prefix) : key === prefix);
  for (const key of [...peaks.keys()]) if (meant(key)) peaks.delete(key);
  for (const key of [...sounds.keys()]) if (meant(key)) drop(key);
}
