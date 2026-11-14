// How much audio generating a deck's narration makes. Apart from ./narration.ts, as it reads
// the scripts' Markdown: the window starts with that module (through the store), not with the
// Markdown parser.
import type { Slide, SlideAudio } from "./api";
import { markdownText } from "./markdown";
import { formatDuration, wordsSeconds } from "./narration";

/** How much there is to say for audio to be made: how many slides, their characters, and about how long it plays. */
export interface GenerationSize {
  slides: number;
  characters: number;
  seconds: number;
}

/**
 * What generating the audio of `slides` would send to the narration service: the slides whose
 * audio is missing or out of date, the characters of what is said of their scripts (what the
 * service counts), and about how long that takes to say.
 */
export function generationSize(slides: Slide[], audio: Record<string, SlideAudio>): GenerationSize {
  const size = { slides: 0, characters: 0, seconds: 0 };
  for (const slide of slides) {
    const state = audio[slide.id]?.state;
    if (state !== "missing" && state !== "stale") continue;
    const spoken = markdownText(slide.narration ?? "").trim();
    size.slides += 1;
    size.characters += spoken.length;
    size.seconds += wordsSeconds(spoken);
  }
  return size;
}

/** A size in words: "5 slides, 2,140 characters, about 2:20 of audio". */
export function describeGeneration(size: GenerationSize): string {
  const slides = `${size.slides} ${size.slides === 1 ? "slide" : "slides"}`;
  return `${slides}, ${size.characters.toLocaleString("en-US")} characters, about ${formatDuration(size.seconds)} of audio`;
}
