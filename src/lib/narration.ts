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
