import type { Deck } from "../lib/api";

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

export function deckFor(html: string, rev = "1"): Deck {
  const ids = [...html.matchAll(/<section class="slide"(?: id="([^"]+)")?/g)].map((m, i) => m[1] ?? `#${i + 1}`);
  return {
    id: "talk",
    title: "Talk",
    path: "/decks/talk",
    slides: ids.map((id) => ({ id, hash: `${id}-${rev}` })),
    shellHash: `shell-${rev}`,
  };
}
