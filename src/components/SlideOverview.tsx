import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, type SortingStrategy, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Image, X } from "lucide-react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { keepsKey } from "../lib/keys";
import { hasOpenLayer } from "../lib/layers";
import { dropRows, dropSection, foldedSlides } from "../lib/sections";
import { dropSide, GRID_SIZES, type GridCell, gridSize, gridStep, loadGridSize, saveGridSize } from "../lib/slideGrid";
import { cn, plural } from "../lib/utils";
import { railSelection, useApp } from "../store";
import { rangeFocus } from "../store/slides";
import { ToolButton } from "./Button";
import { BulkActions } from "./rail/BulkActions";
import { holdIframes, releaseIframes } from "./rail/fold";
import { railTitle, useRailRows, useSameKeys, useSearchCounts } from "./rail/rows";
import { SectionHeader } from "./rail/SectionHeader";
import { ONE_ROW_OF_ACTIONS, SLIDE_LIST_ATTR, Thumbnail } from "./rail/Thumbnail";
import { OVERVIEW_KEY } from "./rail/useOverviewKey";
import { useRailMenus } from "./rail/useRailMenus";
import { SectionLabel } from "./SectionLabel";
import { Stage } from "./Stage";
import { useSlideKeyboard } from "./stage/useSlideKeyboard";

/** How a drag starts: as in the slide list (see ./SlideRail.tsx). The same objects for every render. */
const POINTER_DRAG = { activationConstraint: { distance: 4 } };
const KEYBOARD_DRAG = {
  coordinateGetter: sortableKeyboardCoordinates,
  keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
};

/**
 * Nothing makes room while a row is dragged: the grid stays as it is and a line shows where the
 * row would land (see `Thumbnail`'s `dropMark`). Rows of a grid with sections in it are not all
 * one size, so sliding them into each other's places would send them all over it.
 */
const stayPut: SortingStrategy = () => null;

const NONE_FOLDED: ReadonlySet<string> = new Set();

/** What a double-click on a slide of the grid says it does. */
const OPEN_HINT = "double-click to open";

/** A double-click or Enter on a slide of the grid: back to the stage, with that slide on it. */
const openSlide = (slide: string) => useApp.getState().openSlide(slide);

/** Where a drag over the grid would drop: the row it is over, and the side of it the rows would land on. */
type DropPlace = { key: string; side: "before" | "after" };

/**
 * Every slide of the deck as a grid, in the place of the stage: the whole deck at a glance, to
 * restructure it. It is the slide list laid out wide, and works as the list does: the same
 * thumbnails (which load only near the view, see `SlideImage`'s `lazy`), the same picks, menus
 * and keys, sections as headed groups that fold, and slides and sections moved by dragging or
 * with Space and the arrows. Up and down go a row; a double-click or Enter opens a slide on the
 * stage, and Escape or G goes back to the one that was there.
 *
 * The slider sets how large the thumbnails are, which is remembered. The grid itself does not
 * follow which slide is selected: its rows do (see `Thumbnail`).
 */
export function SlideOverview() {
  const deck = useApp((s) => s.deck);
  const several = useApp((s) => s.railSelected.length > 1);
  const matches = useApp((s) => s.search.matches);
  const collapsed = useApp((s) => s.collapsedSections);
  const [size, setSize] = useState(loadGridSize);
  const list = useRef<HTMLOListElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, POINTER_DRAG), useSensor(KeyboardSensor, KEYBOARD_DRAG));
  const { menu, openSlideMenu, openSectionMenu, editingSection, setEditingSection } = useRailMenus();
  // The slides going along with the one being dragged, itself included; empty when it goes alone.
  const [dragged, setDragged] = useState<string[]>([]);
  const [drop, setDrop] = useState<DropPlace | null>(null);
  // Before the list's own keys, which would take the arrows for the slide before and after.
  useGridKeys(list);
  useSlideKeyboard();
  useEffect(() => releaseIframes, []);

  // A search still on marks what it found, wherever that is, as the slide list does.
  const found = useSearchCounts(matches);
  const { items, blocks, itemKeys, starts, sizes } = useRailRows(deck);
  const folded = useMemo(() => (found ? NONE_FOLDED : foldedSlides(blocks, collapsed)), [found, blocks, collapsed]);
  const keys = useSameKeys(itemKeys);
  if (!deck) return null;

  const isSection = (key: string) => blocks.some((block) => block.key === key);
  /** The section the row `key` is in, by its header's key; none for the slides before the first. */
  const sectionOf = (key: string) => blocks.find((block) => block.rows.includes(key))?.key;
  /** The rows a drag of `key` moves: the picked slides when it is one of several, else itself. */
  const movedBy = (key: string) => {
    const picked = railSelection(useApp.getState());
    return picked.length > 1 && picked.includes(key) ? picked : [key];
  };

  const collisionDetection: CollisionDetection = (args) =>
    closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => !folded.has(`${c.id}`)),
    });

  const endDrag = () => {
    releaseIframes();
    setDragged([]);
    setDrop(null);
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    holdIframes();
    const moved = movedBy(String(active.id));
    setDragged(moved.length > 1 ? moved : []);
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    const key = String(active.id);
    const target = over ? String(over.id) : key;
    // A section lands among the sections, so what counts is the section it is over.
    const row = isSection(key) ? sectionOf(target) : target;
    const side = row === undefined ? null : dropSide(keys, movedBy(key), key, row);
    setDrop((was) => {
      const next = row !== undefined && side ? { key: row, side } : null;
      return was?.key === next?.key && was?.side === next?.side ? was : next;
    });
  };

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    endDrag();
    const key = String(active.id);
    if (!over || active.id === over.id) return;
    if (isSection(key)) {
      const target = sectionOf(String(over.id));
      if (target !== undefined && target !== key) await useApp.getState().reorderRail(dropSection(items, key, target));
      return;
    }
    await useApp.getState().reorderRail(dropRows(keys, movedBy(key), key, String(over.id)));
  };

  const changeSize = (next: number) => {
    const stepped = gridSize(next);
    setSize(stepped);
    saveGridSize(stepped);
  };

  const hiddenCount = deck.slides.filter((s) => s.hidden).length;

  return (
    // Marked as the slide list is, so that the keys pressed here are the slides' (see `keyForRail`).
    <div data-slide-rail data-testid="slide-overview" className="flex h-full flex-col bg-sidebar">
      <div className="@container flex h-10 shrink-0 items-center gap-3 border-b px-4">
        {several ? (
          <BulkActions deck={deck} />
        ) : (
          <>
            <SectionLabel as="h2" className="min-w-0 flex-1 truncate whitespace-nowrap">
              {railTitle(deck.slides.length, hiddenCount)}
            </SectionLabel>
            <SizeSlider size={size} onChange={changeSize} />
          </>
        )}
        <ToolButton
          variant="panel"
          label="Back to the slide"
          shortcut={OVERVIEW_KEY}
          onClick={() => useApp.getState().setOverview(false)}
        >
          <X className="size-4" />
        </ToolButton>
      </div>
      {menu}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 pt-5">
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={endDrag}
        >
          <SortableContext items={keys} strategy={stayPut}>
            <ol
              ref={list}
              {...{ [SLIDE_LIST_ATTR]: "" }}
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` }}
              className={cn("grid gap-x-4 gap-y-5", ONE_ROW_OF_ACTIONS)}
            >
              {items.map((item) =>
                item.kind === "slide" ? (
                  <Thumbnail
                    key={item.key}
                    deckId={deck.id}
                    slide={item.slide}
                    index={item.index}
                    filteredOut={folded.has(item.slide.id)}
                    dimmed={!!found && !found.has(item.slide.id)}
                    folded={false}
                    still
                    draggedAlong={dragged.length > 1 && dragged.includes(item.slide.id)}
                    matches={found?.get(item.slide.id)}
                    hint={OPEN_HINT}
                    opensOnEnter
                    dropMark={drop?.key === item.key ? drop.side : undefined}
                    onMenu={openSlideMenu}
                    onOpen={openSlide}
                  />
                ) : (
                  <SectionHeader
                    key={item.key}
                    itemKey={item.key}
                    section={item.section}
                    filteredOut={false}
                    className="col-span-full"
                    dropTarget={drop?.key === item.key}
                    still
                    first={starts.get(item.key)}
                    collapsed={collapsed.includes(starts.get(item.key) ?? "")}
                    count={sizes.get(item.key) ?? 0}
                    editing={editingSection === item.section.index}
                    onEditing={setEditingSection}
                    onMenu={openSectionMenu}
                  />
                ),
              )}
            </ol>
          </SortableContext>
          {/* Rides on the slide being dragged, to say that the other picked ones go along. */}
          {dragged.length > 1 && (
            <DragOverlay dropAnimation={null} className="pointer-events-none">
              <span
                data-testid="drag-count"
                className="absolute -right-1 -top-2 rounded-full bg-primary px-2 py-0.5 text-2xs font-semibold text-primary-foreground shadow-md"
              >
                {plural(dragged.length, "slide")}
              </span>
            </DragOverlay>
          )}
        </DndContext>
      </div>
    </div>
  );
}

/**
 * What fills the stage's place in View and Edit: the slide, or every slide as a grid while that is
 * on (see `overview`, which the slide list's "All slides" and G turn on and off).
 */
export function StageOrOverview() {
  const overview = useApp((s) => s.overview);
  return overview ? <SlideOverview /> : <Stage />;
}

/** How large the grid's thumbnails are, from many small ones to a few large ones. */
function SizeSlider({ size, onChange }: { size: number; onChange: (size: number) => void }) {
  return (
    <label className="flex shrink-0 items-center gap-1.5 text-muted-foreground" title="Thumbnail size">
      <Image aria-hidden className="size-3" />
      <input
        type="range"
        aria-label="Thumbnail size"
        min={GRID_SIZES.min}
        max={GRID_SIZES.max}
        step={GRID_SIZES.step}
        value={size}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="w-24 accent-primary @max-[20rem]:hidden"
      />
      <Image aria-hidden className="size-4" />
    </label>
  );
}

/** Where the grid's thumbnails that show are, by their slides. */
function cellsOf(list: HTMLElement): GridCell[] {
  return [...list.querySelectorAll<HTMLElement>("li[data-rail-slide]:not(.hidden)")].map((row) => {
    const box = row.getBoundingClientRect();
    return { id: row.dataset.slide ?? "", left: box.left, top: box.top, width: box.width, height: box.height };
  });
}

/**
 * The keys that are the grid's own; the rest are the slide list's (see `useSlideKeyboard`, which
 * must start listening after this does, so that it gets what is left).
 *
 * - ↑ and ↓ go a row up and down, to the slide nearest across; with ⇧ they pick up to there.
 * - Enter opens the selected slide on the stage, unless it was pressed on another control.
 * - Escape, with no more than one slide picked, goes back to the stage as it was.
 */
function useGridKeys(list: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (keepsKey(event) || hasOpenLayer()) return;
      const app = useApp.getState();
      if (app.presenting) return;
      const target = event.target as HTMLElement | null;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const from = event.shiftKey ? rangeFocus(app) : app.selected;
        const to =
          list.current && from ? gridStep(cellsOf(list.current), from, event.key === "ArrowUp" ? -1 : 1) : null;
        // On the first or last row the key has nowhere to go; it does not leave the row sideways.
        if (to !== null) event.shiftKey ? app.extendRailTo(to) : app.select(to);
      } else if (event.key === "Enter" && !event.shiftKey) {
        // Enter on a button or a link is that control's.
        if (target?.closest?.("button, a, [role=button]") || app.selected === null) return;
        app.openSlide(app.selected);
      } else if (event.key === "Escape" && app.railSelected.length === 0) {
        app.setOverview(false);
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list]);
}
