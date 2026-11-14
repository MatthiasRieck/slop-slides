// Referring to slides and files from the message box: typing "@" opens a menu of them, and the
// one picked goes along with the message as a chip. What is found in the text, what the menu
// lists, and how slides are named are worked out here.
import { basename } from "../../lib/utils";

/** An "@…" being typed: where its "@" is in the text, and what follows it up to the caret. */
export interface Mention {
  start: number;
  query: string;
}

/**
 * The mention the caret stands at the end of: an "@" that starts a word, with what was typed
 * after it. Null when there is none, so an e-mail address or a lone "@" in a sentence left
 * behind opens nothing.
 */
export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const query = match[1] ?? "";
  return { start: before.length - query.length - 1, query };
}

/** `text` without the mention the caret (at `caret`) ends: what was picked became a chip. */
export function withoutMention(text: string, mention: Mention, caret: number): { text: string; caret: number } {
  const after = text.slice(caret);
  const before = text.slice(0, mention.start);
  // Not two spaces where the mention stood between words.
  const joined = before.endsWith(" ") && after.startsWith(" ") ? before + after.slice(1) : before + after;
  return { text: joined, caret: before.length };
}

/**
 * What a slide's id says about the slide, as words: ids are mostly made from the slide's heading
 * (`market-size` reads "Market size"). Empty for an id that says nothing (`slide-3`, `s4`, a
 * random string), where the slide's number has to do.
 */
export function slideName(id: string): string {
  if (/^(s|slide|section|page)?[-_]?\d+$/i.test(id) || /[0-9a-f]{6,}/i.test(id) || !/[a-z]{3}/i.test(id)) return "";
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Slide 3 · Market size": a slide by its number and, when its id says something, its name. */
export function slideLabel(number: number, id: string): string {
  const name = slideName(id);
  return name ? `Slide ${number} · ${name}` : `Slide ${number}`;
}

/** Slide numbers as a chip names them: `[3, 4, 5, 8]` reads "Slides 3–5, 8", one alone "Slide 3". */
export function slideRanges(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const runs: string[] = [];
  let from = sorted[0]!;
  let to = from;
  const close = () => runs.push(from === to ? `${from}` : to === from + 1 ? `${from}, ${to}` : `${from}–${to}`);
  for (const number of sorted.slice(1)) {
    if (number === to + 1) {
      to = number;
    } else {
      close();
      from = number;
      to = number;
    }
  }
  close();
  return `${sorted.length === 1 ? "Slide" : "Slides"} ${runs.join(", ")}`;
}

/** Something the "@" menu offers: a slide of the open deck, or a file of the workspace. */
export type MentionItem =
  | { kind: "slide"; id: string; number: number; label: string }
  | { kind: "file"; path: string; label: string; folder: string };

/** How many of each the menu lists at most; typing narrows them down. */
const SLIDES_LISTED = 8;
const FILES_LISTED = 6;

/**
 * What the menu lists for `query` (what was typed after "@"): the slides it fits, by number
 * ("3", "slide 3") or by name, then the files whose path holds it. Without a query, the first
 * slides and files. `slides` are the deck's in order; `files` workspace-relative paths.
 */
export function mentionItems(
  query: string,
  slides: readonly { id: string }[],
  files: readonly string[],
): MentionItem[] {
  const q = query.trim().toLowerCase();
  const number = /^(?:slide\s*)?(\d+)$/.exec(q)?.[1];
  const slideItems = slides
    .map((slide, index) => ({
      kind: "slide" as const,
      id: slide.id,
      number: index + 1,
      label: slideLabel(index + 1, slide.id),
    }))
    .filter((item) =>
      number
        ? String(item.number).startsWith(number)
        : !q || item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q),
    )
    // The slide whose number was typed comes before those that merely start with it.
    .sort((a, b) => (number ? Number(String(b.number) === number) - Number(String(a.number) === number) : 0));
  const fileItems = files
    .filter((path) => !q || path.toLowerCase().includes(q))
    // A name that starts with what was typed is more likely meant than a folder that holds it.
    .sort((a, b) => Number(basename(b).toLowerCase().startsWith(q)) - Number(basename(a).toLowerCase().startsWith(q)))
    .map((path) => {
      const name = basename(path);
      return { kind: "file" as const, path, label: name, folder: path.slice(0, path.length - name.length - 1) };
    });
  return [...slideItems.slice(0, SLIDES_LISTED), ...fileItems.slice(0, FILES_LISTED)];
}
