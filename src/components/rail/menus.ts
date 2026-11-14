import type { Deck } from "../../lib/api";
import { type SectionBlock, sectionStarts, startsSection } from "../../lib/sections";
import { plural } from "../../lib/utils";
import { PRESENT_KEYS } from "../presenter/present";
import type { MenuEntry } from "./ContextMenu";

/** What removing a section is called, wherever it is offered: its slides stay. */
export const REMOVE_SECTION = "Remove section (keeps its slides)";

/** What the slide menu's choices do; the list gives them (see ./useRailMenus.tsx). */
export interface SlideMenuActions {
  /** Goes to Edit with the slide on the stage. */
  edit: (slide: string) => void;
  /** Starts the show on the slide. */
  present: (slide: string) => void;
  /** Opens the layouts to add a slide on, after the slide on the stage. */
  newSlide: () => void;
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
 * the picked ones when it is among them). They are the same in View and in Edit: organising the
 * slides is the list's, whatever the stage is doing. "Edit slide" is there where the slide is not
 * already being edited (`editable`: in View, and in the grid of all slides). Locked slides are
 * neither deleted, cut nor hidden.
 */
export function slideMenu(
  deck: Deck,
  slide: string,
  picked: string[],
  state: { editable: boolean },
  actions: SlideMenuActions,
): MenuEntry[] {
  const slides = deck.slides.filter((s) => picked.includes(s.id));
  const free = slides.filter((s) => !s.locked).map((s) => s.id);
  const several = slides.length > 1;
  const index = deck.slides.findIndex((s) => s.id === slide);
  const hide = !(slides.length > 0 && slides.every((s) => s.hidden));
  const lock = !(slides.length > 0 && slides.every((s) => s.locked));
  const lockedOnly = free.length === 0 ? (several ? "These slides are locked" : "This slide is locked") : undefined;
  const open: MenuEntry[] = state.editable ? [{ label: "Edit slide", run: () => actions.edit(slide) }] : [];
  return [
    ...open,
    { label: "Present from this slide", keys: PRESENT_KEYS.current, run: () => actions.present(slide) },
    "divider",
    { label: "New slide…", keys: "mod+shift+n", run: actions.newSlide },
    { label: "Duplicate", keys: "mod+d", run: () => actions.duplicate(picked) },
    "divider",
    { label: "Copy", keys: "mod+c", run: actions.copy },
    { label: "Cut", keys: "mod+x", disabledReason: lockedOnly, run: actions.cut },
    { label: "Paste after", keys: "mod+v", run: actions.paste },
    {
      label: "Delete",
      keys: "backspace",
      destructive: true,
      disabledReason: lockedOnly && `${lockedOnly}: unlock to delete`,
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
    { label: "Move up", keys: "mod+up", run: () => actions.move(-1) },
    { label: "Move down", keys: "mod+down", run: () => actions.move(1) },
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
  move: (delta: -1 | 1) => void;
  setCollapsed: (first: string, collapsed: boolean) => void;
  setAllCollapsed: (firsts: string[], collapsed: boolean) => void;
  select: (slides: string[]) => void;
  /** Opens the layouts to add a slide on, after `slide`. */
  newSlide: (after: string) => void;
  remove: () => void;
  /** Deletes the section with the slides it holds. */
  removeWithSlides: () => void;
}

/**
 * The choices of a right-click on a section's header. `blocks` are the rail's sections and
 * `collapsed` the folded ones, by their first slides. A section without slides has nothing to
 * fold or select; and one holding a locked slide (`locked`) is not deleted with its slides.
 */
export function sectionMenu(
  key: string,
  blocks: SectionBlock[],
  collapsed: string[],
  state: { locked: boolean },
  actions: SectionMenuActions,
): MenuEntry[] {
  const starts = sectionStarts(blocks);
  const first = starts.get(key);
  const at = blocks.findIndex((block) => block.key === key);
  const slides = blocks[at]?.rows.slice(1) ?? [];
  const firsts = [...starts.values()];
  const folded = first !== undefined && collapsed.includes(first);
  const empty = first === undefined ? "This section has no slides" : undefined;
  const last = slides.at(-1);
  return [
    { label: "Rename", run: actions.rename },
    {
      label: "New slide in this section…",
      disabledReason: empty,
      run: () => last !== undefined && actions.newSlide(last),
    },
    "divider",
    {
      label: "Move section up",
      disabledReason: at <= 0 ? "This is the first section" : undefined,
      run: () => actions.move(-1),
    },
    {
      label: "Move section down",
      disabledReason: at === blocks.length - 1 ? "This is the last section" : undefined,
      run: () => actions.move(1),
    },
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
    {
      label:
        slides.length > 0
          ? `Delete section and its ${plural(slides.length, "slide")}`
          : "Delete section and its slides",
      destructive: true,
      disabledReason: empty ?? (state.locked ? "It holds a locked slide: unlock it to delete the section" : undefined),
      run: actions.removeWithSlides,
    },
  ];
}
