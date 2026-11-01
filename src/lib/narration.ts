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

/**
 * What to ask the agent to turn the raw transcript of a recorded narration into a script, for
 * `slide` or (null) every slide.
 */
export function cleanNarrationPrompt(slide: string | null): string {
  const scope = slide ? `the narration of slide \`${slide}\`` : "the narration of every slide that has one";
  return `Clean up ${scope}. It was spoken off the cuff and transcribed as it came, so it is full of stutters, false starts, filler words, repeated words and sentences begun twice, and the speech recognition may have misheard things.

Rewrite it into clean, fluent spoken sentences in the same language, keeping what the speaker meant, their order, and their way of talking. Remove the stutters and repetition, fix what was misheard using the slide's content, and merge what was said in several goes into one flowing text. Do not add facts of your own or shorten it beyond that.

Change only the text inside each slide's \`<aside class="narration">\`, and leave locked slides alone.`;
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
