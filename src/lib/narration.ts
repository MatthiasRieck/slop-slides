/** Spoken words per minute, for estimating how long a narration takes to read out. */
const WORDS_PER_MINUTE = 150;

/**
 * `text` the way the deck stores a narration (see `narration` in src-tauri/src/html.rs): each
 * line trimmed, at most one blank line between paragraphs, nothing around it.
 */
export function normalizeNarration(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
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
  const seconds = Math.round(wordsSeconds(text));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
