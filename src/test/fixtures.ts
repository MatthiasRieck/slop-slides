import type { Deck, Section } from "../lib/api";

/** A deck.html with three slides; the second has no id yet. */
export const DECK_HTML = [
  `<!DOCTYPE html>`,
  `<html><head><title>Talk</title><style>.slide { color: red }</style></head>`,
  `<body><main class="deck">`,
  `<section class="slide" id="intro">`,
  `  <h1>Hello</h1>`,
  `</section>`,
  `<section class="slide">`,
  `  <p>Second</p>`,
  `</section>`,
  `<section class="slide" id="outro">`,
  `  <p>Bye</p>`,
  `</section>`,
  `</main></body></html>`,
].join("\n");

/** Reads slides and `deck-section` markers the way the backend reports them. */
export function deckFor(html: string, rev = "1"): Deck {
  const slides: { id: string; hidden: boolean }[] = [];
  const sections: Section[] = [];
  const tags = /<section class="slide"(?: id="([^"]+)")?([^>]*)>|<div class="deck-section" data-title="([^"]*)">/g;
  for (const m of html.matchAll(tags)) {
    if (m[3] !== undefined) sections.push({ index: sections.length, title: m[3], before: slides.length });
    else slides.push({ id: m[1] ?? `#${slides.length + 1}`, hidden: /\bdata-hidden\b/.test(m[2] ?? "") });
  }
  return {
    id: "talk",
    title: "Talk",
    path: "/decks/talk",
    slides: slides.map(({ id, hidden }) => ({ id, hash: `${id}-${rev}`, hidden })),
    sections,
    shellHash: `shell-${rev}`,
  };
}
