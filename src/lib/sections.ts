import type { Deck, Section, Slide } from "./api";

/** One row of the slide rail: a slide, or the marker that starts a section. */
export type RailItem =
  | { kind: "slide"; key: string; slide: Slide; index: number }
  | { kind: "section"; key: string; section: Section };

/** Sortable key of a section marker; mirrors `section_key` in src-tauri/src/html.rs. */
export const sectionKey = (index: number) => `section:${index}`;

/** The deck's slides and section markers in document order. */
export function railItems(deck: Pick<Deck, "slides" | "sections">): RailItem[] {
  const sections = [...deck.sections].sort((a, b) => a.before - b.before || a.index - b.index);
  const items: RailItem[] = [];
  let next = 0;
  const flushSections = (before: number) => {
    while (next < sections.length && sections[next]!.before <= before) {
      const section = sections[next++]!;
      items.push({ kind: "section", key: sectionKey(section.index), section });
    }
  };
  deck.slides.forEach((slide, index) => {
    flushSections(index);
    items.push({ kind: "slide", key: slide.id, slide, index });
  });
  flushSections(Infinity);
  return items;
}

/** The deck as it will be after the rail's rows are put into `keys` order. */
export function applyOrder(deck: Deck, keys: string[]): Deck {
  const slides = new Map(deck.slides.map((s) => [s.id, s]));
  const sections = new Map(deck.sections.map((s) => [sectionKey(s.index), s]));
  const nextSlides: Slide[] = [];
  const nextSections: Section[] = [];
  for (const key of keys) {
    const slide = slides.get(key);
    const section = sections.get(key);
    if (slide) nextSlides.push(slide);
    else if (section) nextSections.push({ ...section, index: nextSections.length, before: nextSlides.length });
  }
  return { ...deck, slides: nextSlides, sections: nextSections };
}

/**
 * The deck as it will be once the slides `gone` are deleted. A section's marker stays where it
 * is among the slides that are left.
 */
export function withoutSlides(deck: Deck, gone: ReadonlySet<string>): Deck {
  if (!deck.slides.some((slide) => gone.has(slide.id))) return deck;
  // How many of the first n slides stay, for every n.
  const kept = [0];
  for (const slide of deck.slides) kept.push(kept.at(-1)! + (gone.has(slide.id) ? 0 : 1));
  return {
    ...deck,
    slides: deck.slides.filter((slide) => !gone.has(slide.id)),
    sections: deck.sections.map((section) => {
      const before = kept[Math.min(section.before, deck.slides.length)]!;
      return before === section.before ? section : { ...section, before };
    }),
  };
}

/** The deck as it will be once section `index` is taken out: the sections after it move one up. */
export function withoutSection(deck: Deck, index: number): Deck {
  if (!deck.sections.some((section) => section.index === index)) return deck;
  return {
    ...deck,
    sections: deck.sections
      .filter((section) => section.index !== index)
      .map((section) => (section.index > index ? { ...section, index: section.index - 1 } : section)),
  };
}

/** The deck as it will be once `slides` are hidden or shown, or locked or unlocked, as `marks` says. */
export function withSlidesMarked(
  deck: Deck,
  slides: readonly string[],
  marks: Partial<Pick<Slide, "hidden" | "locked">>,
): Deck {
  const marked = (slide: Slide) =>
    (marks.hidden === undefined || slide.hidden === marks.hidden) &&
    (marks.locked === undefined || slide.locked === marks.locked);
  if (!deck.slides.some((slide) => slides.includes(slide.id) && !marked(slide))) return deck;
  return {
    ...deck,
    slides: deck.slides.map((slide) => (slides.includes(slide.id) && !marked(slide) ? { ...slide, ...marks } : slide)),
  };
}

/** How many slides each section holds, by the section's key. */
export function sectionSizes(blocks: SectionBlock[]): Map<string, number> {
  return new Map(blocks.map((block) => [block.key, block.rows.length - 1]));
}

/** Whether a section marker sits directly before the slide at `index`. */
export function startsSection(deck: Deck, index: number): boolean {
  return deck.sections.some((s) => s.before === index);
}

/** A section's rows: its marker, then the slides up to the next marker. */
export type SectionBlock = { key: string; rows: string[] };

/** The sections in `items`. Slides before the first marker belong to none, so they are left out. */
export function sectionBlocks(items: RailItem[]): SectionBlock[] {
  const blocks: SectionBlock[] = [];
  for (const item of items) {
    if (item.kind === "section") blocks.push({ key: item.key, rows: [] });
    blocks.at(-1)?.rows.push(item.key);
  }
  return blocks;
}

/**
 * The rail's rows after the section `active` is dragged onto section `over`, taking its slides
 * along. Slides before the first section stay first: they have no section to travel with.
 */
export function dropSection(items: RailItem[], active: string, over: string): string[] {
  const blocks = sectionBlocks(items);
  const loose = items
    .slice(
      0,
      items.findIndex((item) => item.kind === "section"),
    )
    .map((item) => item.key);
  const order = dropRows(
    blocks.map((block) => block.key),
    [active],
    active,
    over,
  );
  return [...loose, ...order.flatMap((key) => blocks.find((block) => block.key === key)?.rows ?? [])];
}

/**
 * `keys` with each of the `moved` rows one row up (-1) or down (1), past the nearest row not
 * moved. A section marker is a row too, so a slide steps out of its section and into the next.
 */
export function stepRows(keys: string[], moved: string[], delta: -1 | 1): string[] {
  const next = [...keys];
  const moving = new Set(moved);
  const rows = delta < 0 ? next.map((_, i) => i) : next.map((_, i) => next.length - 1 - i);
  for (const i of rows) {
    const key = next[i]!;
    const other = next[i + delta];
    if (moving.has(key) && other !== undefined && !moving.has(other)) {
      next[i + delta] = key;
      next[i] = other;
    }
  }
  return next;
}

/** `keys` with the `moved` rows, as a block, where dragging `active` onto row `over` puts it. */
export function dropRows(keys: string[], moved: string[], active: string, over: string): string[] {
  const moving = new Set(moved);
  if (moving.has(over)) return keys;
  const rest = keys.filter((key) => !moving.has(key));
  const at = rest.indexOf(over) + (keys.indexOf(active) < keys.indexOf(over) ? 1 : 0);
  rest.splice(at, 0, ...keys.filter((key) => moving.has(key)));
  return rest;
}

/**
 * The rail's rows after the section `key` has changed places with the one before it (-1) or after
 * it (1), each with its slides; null when there is no section that way.
 */
export function stepSection(items: RailItem[], key: string, delta: -1 | 1): string[] | null {
  const blocks = sectionBlocks(items);
  const other = blocks[blocks.findIndex((block) => block.key === key) + delta];
  if (!other || !blocks.some((block) => block.key === key)) return null;
  return dropSection(items, key, other.key);
}

/** The first slide of each section that has one, by the section's key; it names the section's fold. */
export function sectionStarts(blocks: SectionBlock[]): Map<string, string> {
  const starts = new Map<string, string>();
  for (const block of blocks) if (block.rows[1] !== undefined) starts.set(block.key, block.rows[1]);
  return starts;
}

/** The slides folded away under their section's header, given the folds' first slides. */
export function foldedSlides(blocks: SectionBlock[], collapsed: string[]): Set<string> {
  const folded = new Set<string>();
  for (const block of blocks) {
    const [, first, ...rest] = block.rows;
    if (first !== undefined && collapsed.includes(first)) for (const row of [first, ...rest]) folded.add(row);
  }
  return folded;
}

/** The first slide of the folded section that holds `slide`, if one does. */
export function foldHolding(blocks: SectionBlock[], collapsed: string[], slide: string): string | undefined {
  const block = blocks.find((b) => b.rows.includes(slide));
  const first = block?.rows[1];
  return first !== undefined && collapsed.includes(first) ? first : undefined;
}
