// A new deck starts from what the user says it is about; its title can be left to that.

/** How many words of what the deck is about make its title. */
const TITLE_WORDS = 6;
/** The longest a title made that way gets. */
const TITLE_CHARS = 60;

/**
 * A title for a deck described as `about`, until the agent or the user gives it a better one:
 * the first few words of its first sentence, without the punctuation at their end and with a
 * capital first. Empty when nothing is said.
 */
export function titleFromPrompt(about: string): string {
  const sentence = about.trim().split(/[\n.!?:;]/, 1)[0] ?? "";
  const words = sentence.split(/\s+/).filter(Boolean).slice(0, TITLE_WORDS).join(" ");
  const title = wholeWords(words, TITLE_CHARS).replace(/[\s,–—-]+$/, "");
  return title ? title[0]!.toUpperCase() + title.slice(1) : "";
}

/** As much of `text` as fits in `limit` characters without cutting a word in two. */
function wholeWords(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return /\s/.test(text[limit] ?? "") ? cut : cut.replace(/\s+\S*$/, "");
}

/** What a deck is called when neither a title nor what it is about was given. */
export const UNTITLED_DECK = "Untitled deck";

/** The title a new deck gets: the one typed, else one made from what it is about, else "Untitled deck". */
export function newDeckTitle(title: string, about: string): string {
  return title.trim() || titleFromPrompt(about) || UNTITLED_DECK;
}

/** What a new deck could be about, offered under the field as a start. */
export const DECK_IDEAS = [
  "A 6-slide pitch for a neighborhood tool-sharing app, bold and warm",
  "Teach the basics of compound interest to teenagers in 8 slides",
  "Quarterly engineering update: shipped, in progress, risks, asks",
];

/** The decks on the start screen whose title or folder holds `query`, in any case; all for an empty query. */
export function matchingDecks<T extends { title: string; path: string }>(decks: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...decks];
  return decks.filter((deck) => {
    const text = `${deck.title} ${deck.path}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
