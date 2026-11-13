import type { Deck } from "../../lib/api";
import { type SectionBlock, sectionStarts, startsSection } from "../../lib/sections";
import { EDIT_ONLY } from "../editOnly";
import type { MenuEntry } from "./ContextMenu";

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
 * the picked ones when it is among them). Out of Edit (`editable`), what changes the deck is off,
 * saying so; locked slides are neither deleted, cut nor hidden; and nothing moves while a search
 * lists only some of the slides (`searching`).
 */
export function slideMenu(
  deck: Deck,
  slide: string,
  picked: string[],
  state: { editable: boolean; searching: boolean },
  actions: SlideMenuActions,
): MenuEntry[] {
  const slides = deck.slides.filter((s) => picked.includes(s.id));
  const free = slides.filter((s) => !s.locked).map((s) => s.id);
  const several = slides.length > 1;
  const index = deck.slides.findIndex((s) => s.id === slide);
  const hide = !(slides.length > 0 && slides.every((s) => s.hidden));
  const lock = !(slides.length > 0 && slides.every((s) => s.locked));
  const off = state.editable ? undefined : EDIT_ONLY;
  const lockedOnly = free.length === 0 ? (several ? "These slides are locked" : "This slide is locked") : undefined;
  const moving = off ?? (state.searching ? SEARCH_REORDER : undefined);
  return [
    {
      label: "New slide",
      keys: "mod+shift+n",
      disabledReason: off,
      run: () => actions.addSlide(slides.at(-1)?.id ?? slide),
    },
    { label: "Duplicate", keys: "mod+d", disabledReason: off, run: () => actions.duplicate(picked) },
    "divider",
    { label: "Copy", keys: "mod+c", run: actions.copy },
    { label: "Cut", keys: "mod+x", disabledReason: off ?? lockedOnly, run: actions.cut },
    { label: "Paste after", keys: "mod+v", disabledReason: off, run: actions.paste },
    {
      label: "Delete",
      keys: "backspace",
      destructive: true,
      disabledReason: off ?? lockedOnly,
      run: () => actions.remove(free),
    },
    "divider",
    {
      label: hide ? "Hide" : "Show",
      disabledReason: off ?? lockedOnly,
      run: () => actions.setHidden(free, hide),
    },
    { label: lock ? "Lock" : "Unlock", disabledReason: off, run: () => actions.setLocked(picked, lock) },
    "divider",
    { label: "Move up", keys: "mod+up", disabledReason: moving, run: () => actions.move(-1) },
    { label: "Move down", keys: "mod+down", disabledReason: moving, run: () => actions.move(1) },
    "divider",
    {
      label: "Start section here",
      disabledReason: off ?? (startsSection(deck, index) ? "This slide already starts a section" : undefined),
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
 * fold or select; renaming and removing are Edit mode's.
 */
export function sectionMenu(
  key: string,
  blocks: SectionBlock[],
  collapsed: string[],
  editable: boolean,
  actions: SectionMenuActions,
): MenuEntry[] {
  const starts = sectionStarts(blocks);
  const first = starts.get(key);
  const slides = blocks.find((block) => block.key === key)?.rows.slice(1) ?? [];
  const firsts = [...starts.values()];
  const folded = first !== undefined && collapsed.includes(first);
  const off = editable ? undefined : EDIT_ONLY;
  const empty = first === undefined ? "This section has no slides" : undefined;
  return [
    { label: "Rename", disabledReason: off, run: actions.rename },
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
    { label: REMOVE_SECTION, destructive: true, disabledReason: off, run: actions.remove },
  ];
}
