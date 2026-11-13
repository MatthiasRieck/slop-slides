// Where a slide stands in its deck, for the many places of the chat that name a slide by its
// number: looked up, not searched for, as they all ask again whenever anything in the app changes.

/** The numbers of the slides of each list asked about, kept as long as the list is. */
const numbered = new WeakMap<readonly { id: string }[], ReadonlyMap<string, number>>();

/** The number (from 1) of each of `slides` by its id. The same list is numbered once. */
export function slideNumbers(slides: readonly { id: string }[]): ReadonlyMap<string, number> {
  let numbers = numbered.get(slides);
  if (!numbers) {
    const byId = new Map<string, number>();
    // Of two slides with one id (a deck being repaired), the first is the one meant: it is set last.
    for (let index = slides.length - 1; index >= 0; index--) byId.set(slides[index]!.id, index + 1);
    numbers = byId;
    numbered.set(slides, numbers);
  }
  return numbers;
}

/** The number (from 1) of slide `id` in `deck`; 0 without a deck, an id, or such a slide. */
export function slideNumber(deck: { slides: readonly { id: string }[] } | null, id: string | null): number {
  return deck && id ? (slideNumbers(deck.slides).get(id) ?? 0) : 0;
}
