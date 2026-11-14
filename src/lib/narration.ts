import type { Slide, SlideAudio } from "./api";

/** Spoken words per minute, for estimating how long a narration takes to read out. */
const WORDS_PER_MINUTE = 150;

/**
 * `text` the way the deck stores a narration (see `narration` in src-tauri/src/html.rs): no
 * space at the ends of lines (at their start it means something in Markdown), at most one blank
 * line between paragraphs, nothing around it.
 */
export function normalizeNarration(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** About how many seconds `text` takes to say. */
export function wordsSeconds(text: string): number {
  return (wordCount(text) / WORDS_PER_MINUTE) * 60;
}

/** About how long `text` takes to say, like `0:45`. */
export function speakingTime(text: string): string {
  return formatDuration(wordsSeconds(text));
}

/** `seconds` as "0:12". */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * What a slide has of narration, for a mark on it wherever slides are listed: nothing, a `script`
 * not spoken yet, audio that is `ready`, audio that is `stale` (its script changed since), or the
 * presenter's own `recorded` voice (or audio brought in), which no script changes.
 */
export type NarrationMark = "none" | "script" | "ready" | "stale" | "recorded";

/** The mark of `slide`, whose audio (as the narration store knows it) is `audio`. */
export function narrationMark(slide: Pick<Slide, "narration">, audio: SlideAudio | undefined): NarrationMark {
  if (audio?.recorded) return "recorded";
  if ((slide.narration ?? "").trim() === "") return "none";
  if (audio?.state === "ready") return "ready";
  if (audio?.state === "stale") return "stale";
  return "script";
}

/** A mark in words, as a slide's row or its tooltip says it. */
export const MARK_LABELS: Record<NarrationMark, string> = {
  none: "No narration",
  script: "Script, no audio yet",
  ready: "Audio",
  stale: "Script changed since the audio",
  recorded: "Your recording",
};

/** The slides whose speaker notes can become their script: they have notes, no script, and are not locked. */
export function slidesToScriptFromNotes(slides: Slide[]): Slide[] {
  return slides.filter((s) => !s.locked && (s.notes ?? "").trim() !== "" && (s.narration ?? "").trim() === "");
}
