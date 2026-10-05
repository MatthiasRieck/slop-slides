import type { Deck, Section, Slide } from "./api";

/** One row of the slide rail: a slide, or the marker that starts a section. */
export type RailItem =
  | { kind: "slide"; key: string; slide: Slide; index: number }
  | { kind: "section"; key: string; section: Section };

/** Sortable key of a section marker; mirrors `section_key` in src-tauri/src/html.rs. */
export const sectionKey = (index: number) => `section:${index}`;

/** The deck's slides and section markers in document order. */
export function railItems(deck: Deck): RailItem[] {
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

/** Whether a section marker sits directly before the slide at `index`. */
export function startsSection(deck: Deck, index: number): boolean {
  return deck.sections.some((s) => s.before === index);
}
