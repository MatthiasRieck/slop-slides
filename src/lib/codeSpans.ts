// Apart from ./markdown.ts, which brings the Markdown parser: the start screen uses this.

/** Stretches of a sentence, those written between backticks marked as code. */
export function codeSpans(text: string): { text: string; code: boolean }[] {
  return text
    .split("`")
    .map((part, index) => ({ text: part, code: index % 2 === 1 }))
    .filter((part) => part.text !== "");
}
