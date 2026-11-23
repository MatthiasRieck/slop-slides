import type { Deck } from "../../lib/api";
import { type SectionBlock, sectionStarts, startsSection } from "../../lib/sections";

/** One choice of a context menu, or the line between two groups of them. */
export type MenuEntry =
  | "divider"
  | {
      label: string;
      /** The keys that do the same, as a `formatKeys` spec. */
      keys?: string;
      /** Why it cannot be picked just now; it shows, off, with this as its tooltip. */
      disabledReason?: string;
      /** It deletes or discards. */
      destructive?: boolean;
      run: () => void;
    };

/** What removing a section is called, wherever it is offered: its slides stay. */
export const REMOVE_SECTION = "Remove section (keeps its slides)";

/** Why the rail's rows cannot be moved while a search lists only some of them. */
export const SEARCH_REORDER = "Clear the search to reorder";

/** What the slide menu's choices do; the rail gives them (see ../SlideRail.tsx). */
export interface SlideMenuActions {
  addSlide: (after: string) => void;
  duplicate: (slides: string[]) => void;
  copy: () => void;
  cut: () => void;
  paste: () => void;
  remove: (slides: string[]) => void;
  setHidden: (slides: string[], hidden: boolean) => void;
  setLocked: (slides: string[], locked: boolean) => void;
  move: (delta: -1 | 1) => void;
  startSection: (slide: string) => void;
}

/**
 * The choices of a right-click on slide `slide`, for the `picked` slides (the one clicked, or all
 * the picked ones when it is among them). They are the same in every mode: the deck's modes are
 * about what is on a slide. Locked slides are neither deleted, cut nor hidden, and nothing moves
 * while a search lists only some of the slides (`searching`).
 */
export function slideMenu(
  deck: Deck,
  slide: string,
  picked: string[],
  state: { searching: boolean },
  actions: SlideMenuActions,
): MenuEntry[] {
  const slides = deck.slides.filter((s) => picked.includes(s.id));
  const free = slides.filter((s) => !s.locked).map((s) => s.id);
  const several = slides.length > 1;
  const index = deck.slides.findIndex((s) => s.id === slide);
  const hide = !(slides.length > 0 && slides.every((s) => s.hidden));
  const lock = !(slides.length > 0 && slides.every((s) => s.locked));
  const lockedOnly = free.length === 0 ? (several ? "These slides are locked" : "This slide is locked") : undefined;
  const moving = state.searching ? SEARCH_REORDER : undefined;
  return [
    {
      label: "New slide",
      keys: "mod+shift+n",
      run: () => actions.addSlide(slides.at(-1)?.id ?? slide),
    },
    { label: "Duplicate", keys: "mod+d", run: () => actions.duplicate(picked) },
    "divider",
    { label: "Copy", keys: "mod+c", run: actions.copy },
    { label: "Cut", keys: "mod+x", disabledReason: lockedOnly, run: actions.cut },
    { label: "Paste after", keys: "mod+v", run: actions.paste },
    {
      label: "Delete",
      keys: "backspace",
      destructive: true,
      disabledReason: lockedOnly,
      run: () => actions.remove(free),
    },
    "divider",
    {
      label: hide ? "Hide" : "Show",
      disabledReason: lockedOnly,
      run: () => actions.setHidden(free, hide),
    },
    { label: lock ? "Lock" : "Unlock", run: () => actions.setLocked(picked, lock) },
    "divider",
    { label: "Move up", keys: "mod+up", disabledReason: moving, run: () => actions.move(-1) },
    { label: "Move down", keys: "mod+down", disabledReason: moving, run: () => actions.move(1) },
    "divider",
    {
      label: "Start section here",
      disabledReason: startsSection(deck, index) ? "This slide already starts a section" : undefined,
      run: () => actions.startSection(slide),
    },
  ];
}

/** What the section menu's choices do. */
export interface SectionMenuActions {
  rename: () => void;
  setCollapsed: (first: string, collapsed: boolean) => void;
  setAllCollapsed: (firsts: string[], collapsed: boolean) => void;
  select: (slides: string[]) => void;
  remove: () => void;
}

/**
 * The choices of a right-click on a section's header. `blocks` are the rail's sections and
 * `collapsed` the folded ones, by their first slides. A section without slides has nothing to
 * fold or select.
 */
export function sectionMenu(
  key: string,
  blocks: SectionBlock[],
  collapsed: string[],
  actions: SectionMenuActions,
): MenuEntry[] {
  const starts = sectionStarts(blocks);
  const first = starts.get(key);
  const slides = blocks.find((block) => block.key === key)?.rows.slice(1) ?? [];
  const firsts = [...starts.values()];
  const folded = first !== undefined && collapsed.includes(first);
  const empty = first === undefined ? "This section has no slides" : undefined;
  return [
    { label: "Rename", run: actions.rename },
    "divider",
    {
      label: folded ? "Expand" : "Collapse",
      disabledReason: empty,
      run: () => first !== undefined && actions.setCollapsed(first, !folded),
    },
    {
      label: "Collapse all",
      disabledReason: firsts.every((id) => collapsed.includes(id)) ? "Every section is collapsed" : undefined,
      run: () => actions.setAllCollapsed(firsts, true),
    },
    {
      label: "Expand all",
      disabledReason: firsts.some((id) => collapsed.includes(id)) ? undefined : "Every section is expanded",
      run: () => actions.setAllCollapsed(firsts, false),
    },
    "divider",
    { label: "Select its slides", disabledReason: empty, run: () => actions.select(slides) },
    "divider",
    { label: REMOVE_SECTION, destructive: true, run: actions.remove },
  ];
}
