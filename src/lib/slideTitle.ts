/**
 * What to call a slide where people read it: its id as words. Ids are descriptive kebab-case
 * names the agent and the app give slides (`market-size`, `pricing-tiers-2`), so "Market size"
 * says which slide it is without showing the id itself.
 */
export function slideTitle(id: string): string {
  const words = id.replace(/^#/, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "";
}

/** A slide by its place in the deck and what it is called: "Slide 3 · Market size". */
export function slideHeading(index: number, id: string): string {
  const title = slideTitle(id);
  return title ? `Slide ${index + 1} · ${title}` : `Slide ${index + 1}`;
}
