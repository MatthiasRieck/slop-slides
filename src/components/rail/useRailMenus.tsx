import { type ReactNode, useCallback, useState } from "react";

import { railItems, sectionBlocks } from "../../lib/sections";
import { railSelection, useApp } from "../../store";
import { usePresent } from "../presenter/present";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { sectionMenu, slideMenu } from "./menus";

/** A menu of the list, where it was asked for. */
type OpenMenu = { label: string; x: number; y: number; entries: MenuEntry[] };

/**
 * Where a menu opens: at the pointer, or, asked for with the keyboard (a press of "More actions"
 * comes without a place), under what it was asked on.
 */
function menuPlace(event: React.MouseEvent): { x: number; y: number } {
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY };
  const box = event.currentTarget.getBoundingClientRect();
  return { x: box.left, y: box.bottom };
}

/**
 * The menus of a list of slides (the slide list, the grid of all slides), which both open the same
 * way: a right-click on a slide or on a section's header, or a press on its "More actions".
 *
 * - `menu`: the open menu, to render.
 * - `openSlideMenu` / `openSectionMenu`: the same two functions for every row. They read what the
 *   menu is about when it opens: on a slide that is not picked it picks that slide first, and with
 *   several picked it is about all of them.
 * - `editingSection` / `setEditingSection`: the section whose title is being typed, by its index.
 * - `startSection`: starts a section at a slide, and goes on to naming it.
 */
export function useRailMenus(): {
  menu: ReactNode;
  openSlideMenu: (event: React.MouseEvent, slide: string) => void;
  openSectionMenu: (event: React.MouseEvent, key: string) => void;
  editingSection: number | null;
  setEditingSection: (section: number | null) => void;
  startSection: (slide: string) => Promise<void>;
} {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [editingSection, setEditingSection] = useState<number | null>(null);

  const startSection = useCallback(
    async (slide: string) => setEditingSection(await useApp.getState().startSection(slide)),
    [],
  );

  const openSlideMenu = useCallback(
    (event: React.MouseEvent, slide: string) => {
      const app = useApp.getState;
      const { deck } = app();
      if (!deck) return;
      event.preventDefault();
      // A slide that is not picked is what the menu is about; one of the picked ones stands for all.
      if (!railSelection(app()).includes(slide)) app().select(slide);
      const state = app();
      const entries = slideMenu(
        deck,
        slide,
        railSelection(state),
        // In the grid no slide is being edited, whatever the mode.
        { editable: !state.editing || state.overview },
        {
          edit: (target) => {
            app().openSlide(target);
            app().setMode("edit");
          },
          present: (target) => {
            if (app().selected !== target) app().select(target);
            void usePresent.getState().present("current");
          },
          newSlide: () => app().setAddingSlide(true),
          duplicate: (slides) => void app().duplicateSlides(slides),
          copy: () => void app().copySlides(),
          cut: () => void app().cutSlides(),
          paste: () => void app().pasteSlides(true),
          remove: (slides) => void app().deleteSlides(slides),
          setHidden: (slides, hidden) => void app().setSlidesHidden(slides, hidden),
          setLocked: (slides, locked) => void app().setSlidesLocked(slides, locked),
          move: (delta) => void app().moveSlides(delta),
          startSection: (at) => void startSection(at),
        },
      );
      setMenu({ label: "Slide", ...menuPlace(event), entries });
    },
    [startSection],
  );

  const openSectionMenu = useCallback((event: React.MouseEvent, key: string) => {
    const app = useApp.getState;
    const { deck, collapsedSections } = app();
    if (!deck) return;
    const items = railItems(deck);
    const row = items.find((item) => item.key === key);
    if (row?.kind !== "section") return;
    event.preventDefault();
    const { section } = row;
    const blocks = sectionBlocks(items);
    const held = blocks.find((block) => block.key === key)?.rows ?? [];
    const locked = deck.slides.some((slide) => slide.locked && held.includes(slide.id));
    const entries = sectionMenu(
      key,
      blocks,
      collapsedSections,
      { locked },
      {
        rename: () => setEditingSection(section.index),
        move: (delta) => void app().moveSection(section.index, delta),
        setCollapsed: (first, folded) => app().toggleSection(first, folded),
        setAllCollapsed: (firsts, folded) => app().setSectionsCollapsed(firsts, folded),
        select: (slides) => app().pickSlides(slides),
        newSlide: (after) => {
          app().select(after);
          app().setAddingSlide(true);
        },
        remove: () => void app().removeSection(section.index),
        removeWithSlides: () => void app().deleteSectionSlides(section.index),
      },
    );
    setMenu({ label: "Section", ...menuPlace(event), entries });
  }, []);

  return {
    menu: menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />,
    openSlideMenu,
    openSectionMenu,
    editingSection,
    setEditingSection,
    startSection,
  };
}
