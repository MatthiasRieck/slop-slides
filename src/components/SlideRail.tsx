import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useDndContext,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, Plus, SquareSplitVertical, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import type { Deck } from "../lib/api";
import {
  dropRows,
  dropSection,
  foldedSlides,
  foldHolding,
  type RailItem,
  railItems,
  sectionBlocks,
  sectionKey,
  sectionSizes,
  sectionStarts,
  startsSection,
} from "../lib/sections";
import { cn, plural } from "../lib/utils";
import { railSelection, useApp } from "../store";
import { foldSlides, holdIframes, holdRow, openTop, releaseIframes, rowTop, type SectionMove } from "./rail/fold";
import { type MenuEntry, SEARCH_REORDER, sectionMenu, slideMenu } from "./rail/menus";
import { RailMenuItems } from "./rail/RailMenu";
import { SectionHeader } from "./rail/SectionHeader";
import { Thumbnail } from "./rail/Thumbnail";
import { SECTION_HEADING } from "./styles";
import { LayoutPicker } from "./Templates";

/**
 * How a drag starts. The same objects for every render: dnd-kit takes new options for new
 * sensors and tells every row of them.
 */
const POINTER_DRAG = { activationConstraint: { distance: 4 } };
/** The keys that move a row with the keyboard: Space picks it up and puts it down; Enter is the thumbnail's own. */
const KEYBOARD_DRAG = {
  coordinateGetter: sortableKeyboardCoordinates,
  keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
};

/** What the rail's drags are held to, and how they scroll it: the same for every render. */
const DRAG_MODIFIERS = [restrictToVerticalAxis];
const DRAG_SCROLL = { layoutShiftCompensation: false };
const MEASURE_ALWAYS = { droppable: { strategy: MeasuringStrategy.Always } };
const MEASURE_DRAGGING = { droppable: { strategy: MeasuringStrategy.WhileDragging } };

const NONE_FOLDED: ReadonlySet<string> = new Set();

/**
 * `keys` as the same list for as long as it names the same rows in the same order. dnd-kit tells
 * every row when its list of rows is another one, which a slide saved anew would otherwise be.
 */
function useSameKeys(keys: string[]): string[] {
  const [kept, setKept] = useState(keys);
  const same = kept.length === keys.length && kept.every((key, i) => key === keys[i]);
  if (!same) setKept(keys);
  return same ? kept : keys;
}

/**
 * The rail's rows and what is looked up in them, worked out once for each change to the slides
 * or the sections. The deck keeps both as they are while they do not change (see `shareDeck`),
 * so a slide's comments or the review marks leave all of this alone.
 */
function useRailRows(deck: Deck | null) {
  const slides = deck?.slides;
  const sections = deck?.sections;
  return useMemo(() => {
    const items = slides && sections ? railItems({ slides, sections }) : [];
    const blocks = sectionBlocks(items);
    return {
      items,
      blocks,
      itemKeys: items.map((item) => item.key),
      blockKeys: blocks.map((block) => block.key),
      starts: sectionStarts(blocks),
      sizes: sectionSizes(blocks),
      looseSlides: items.findIndex((item) => item.kind === "section"),
    };
  }, [slides, sections]);
}

/** What a right-click's menu is about, and its choices. */
type OpenMenu = { label: string; entries: MenuEntry[] };

/**
 * The deck's slides and sections, to go through, pick from and change: adding, duplicating,
 * deleting, hiding, locking and reordering slides, and the sections. All of it works the same in
 * every mode: View and Edit differ in what can be done on a slide, not to the slides of the deck.
 *
 * A right-click on a slide or a section's header opens its menu (see ./rail/menus.ts): on a slide
 * that is not picked it picks that slide first, and with several picked it is about all of them.
 * Slides and sections are moved by dragging, or with the keyboard: Space on a row picks it up, the
 * arrows move it, Space puts it down. One of several picked slides takes the others along.
 *
 * The rail itself does not follow which slide is selected: the rows that are picked or let go
 * follow it themselves, as do the bits of its header that depend on it (`StartSectionButton`,
 * `OpenSelectedFold`), so going through the slides renders two rows, not the whole list.
 */
export function SlideRail() {
  const deck = useApp((s) => s.deck);
  const editing = useApp((s) => s.editing);
  const [editingSection, setEditingSection] = useState<number | null>(null);
  const [addingSlide, setAddingSlide] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, POINTER_DRAG), useSensor(KeyboardSensor, KEYBOARD_DRAG));
  // One menu for the whole list (see `ContextMenu` below): the row right-clicked says what it holds.
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  /** A row took the right-click that is on its way up to the list, and has set the menu for it. */
  const menuAsked = useRef(false);
  /**
   * The section the menu's Rename is about. Its title is typed once the menu is gone: a field
   * that took the focus while the menu was open would lose it to the menu again. Nor does the
   * menu, going, hand the focus back to where it was while a title is being typed.
   */
  const renameAfterMenu = useRef<number | null>(null);
  const typingTitle = useRef(false);
  typingTitle.current = editingSection !== null;
  // The slides going along with the one being dragged, itself included; empty when it goes alone.
  const [dragged, setDragged] = useState<string[]>([]);
  const matches = useApp((s) => s.search.matches);
  const collapsed = useApp((s) => s.collapsedSections);
  // While a search runs the rail lists what it found. The rest stay mounted, hidden, so ending it
  // doesn't reload every thumbnail, and can't be dragged: an order needs all the slides in view.
  const found = useMemo(() => {
    if (!matches) return null;
    const counts = new Map<string, number>();
    for (const match of matches) counts.set(match.slide, (counts.get(match.slide) ?? 0) + 1);
    return counts;
  }, [matches]);
  // The section being dragged, where its row was when picked up, and how tall a slide's row is.
  // Until it is dropped the slides are folded away, the rail closing up around that row.
  const [moving, setMoving] = useState<SectionMove | null>(null);
  // The folded slides open again after the drop; dnd-kit must not animate them from where they were.
  const [settling, setSettling] = useState(false);
  const landing = useRef<SectionMove | null>(null);
  const stopHolding = useRef<() => void>(undefined);
  const list = useRef<HTMLOListElement>(null);
  const remeasure = useRef<() => void>(undefined);
  useEffect(() => releaseIframes, []);
  useEffect(() => () => stopHolding.current?.(), []);
  useLayoutEffect(() => {
    const rows = list.current;
    if (!rows) return;
    if (moving) {
      foldSlides(rows, moving.slideHeight, false);
      stopHolding.current?.();
      // dnd-kit measured the rows before they folded; it sorts by where they are, so keep it told.
      stopHolding.current = holdRow(rows, moving.key, moving.top, moving.top, () => remeasure.current?.());
      return;
    }
    const dropped = landing.current;
    if (!dropped) return;
    landing.current = null;
    const end = openTop(rows, dropped);
    foldSlides(rows, dropped.slideHeight, true);
    stopHolding.current?.();
    stopHolding.current = holdRow(rows, dropped.key, dropped.top, end, undefined, () => {
      rows.style.paddingTop = "";
      rows.style.paddingBottom = "";
      setSettling(false);
    });
  }, [moving]);
  const { items, blocks, itemKeys, blockKeys, starts, sizes, looseSlides } = useRailRows(deck);
  // A search shows what it found wherever it is.
  const folded = useMemo(() => (found ? NONE_FOLDED : foldedSlides(blocks, collapsed)), [found, blocks, collapsed]);
  const app = useApp.getState;

  /** Starts a section at `slide`, and goes on to naming it. */
  const startSection = useCallback(
    async (slide: string) => setEditingSection(await useApp.getState().startSection(slide)),
    [],
  );

  // The menus read what they are about when they open, so every row gets the same two functions.
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
        { searching: !!state.search.matches },
        {
          addSlide: (after) => void app().addSlide(after),
          duplicate: (slides) => void app().duplicateSlides(slides),
          copy: () => void app().copySlides(),
          cut: () => void app().cutSlides(),
          paste: () => void app().pasteSlides(),
          remove: (slides) => void app().deleteSlides(slides),
          setHidden: (slides, hidden) => void app().setSlidesHidden(slides, hidden),
          setLocked: (slides, locked) => void app().setSlidesLocked(slides, locked),
          move: (delta) => void app().moveSlides(delta),
          startSection: (at) => void startSection(at),
        },
      );
      menuAsked.current = true;
      setMenu({ label: "Slide", entries });
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
    const entries = sectionMenu(key, sectionBlocks(items), collapsedSections, {
      rename: () => {
        renameAfterMenu.current = section.index;
      },
      setCollapsed: (first, folded) => app().toggleSection(first, folded),
      setAllCollapsed: (firsts, folded) => app().setSectionsCollapsed(firsts, folded),
      select: (slides) => app().pickSlides(slides),
      remove: () => void app().removeSection(section.index),
    });
    menuAsked.current = true;
    setMenu({ label: "Section", entries });
  }, []);

  const keys = useSameKeys(moving ? blockKeys : itemKeys);
  if (!deck) return null;
  const hiddenCount = deck.slides.filter((s) => s.hidden).length;

  const onDragStart = ({ active }: DragStartEvent) => {
    holdIframes();
    const key = String(active.id);
    const picked = railSelection(app());
    setDragged(picked.length > 1 && picked.includes(key) ? picked : []);
    const top = blocks.some((block) => block.key === key) ? rowTop(list.current, key) : null;
    // A slide in a collapsed section has no height to tell.
    const slideHeight = list.current?.querySelector<HTMLElement>("[data-rail-slide]:not(.hidden)")?.offsetHeight ?? 0;
    if (top != null) setMoving({ key, top, slideHeight });
  };

  // Only the sections' rows are open to a drop while a section moves; the rest take no space.
  const collisionDetection: CollisionDetection = (args) =>
    closestCenter(
      moving
        ? { ...args, droppableContainers: args.droppableContainers.filter((c) => keys.includes(`${c.id}`)) }
        : { ...args, droppableContainers: args.droppableContainers.filter((c) => !folded.has(`${c.id}`)) },
    );

  /** Opens the sections again, with the one dragged ending up `at` this place among them. */
  const putDown = (move: SectionMove, at: number, top: number) => {
    landing.current = { ...move, key: sectionKey(at), top };
    setSettling(true);
    setMoving(null);
  };

  const onDragCancel = () => {
    releaseIframes();
    setDragged([]);
    if (moving) putDown(moving, keys.indexOf(moving.key), moving.top);
  };

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    releaseIframes();
    setDragged([]);
    const key = String(active.id);
    if (moving) {
      const order = dropSection(items, key, String(over?.id ?? key));
      const at = order.filter((row) => keys.includes(row)).indexOf(key);
      putDown(moving, at, active.rect.current.translated?.top ?? moving.top);
      if (over && over.id !== active.id) await useApp.getState().reorderRail(order);
      return;
    }
    if (!over || active.id === over.id) return;
    // Dragging one of the picked slides takes the others along.
    const picked = railSelection(useApp.getState());
    const moved = picked.length > 1 && picked.includes(key) ? picked : [key];
    await useApp.getState().reorderRail(dropRows(keys, moved, key, String(over.id)));
  };

  return (
    <div data-slide-rail className="flex h-full flex-col bg-sidebar">
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <span className={SECTION_HEADING}>{railTitle(deck.slides.length, found?.size, hiddenCount)}</span>
        <div className="flex items-center gap-0.5">
          <StartSectionButton deck={deck} onStart={startSection} />
          <Popover open={addingSlide} onOpenChange={setAddingSlide}>
            <PopoverTrigger render={<Button variant="tool" size="icon-xs" tooltip="New slide" />}>
              <Plus className="size-4" />
            </PopoverTrigger>
            <PopoverContent
              side="bottom"
              align="start"
              aria-label="New slide"
              className="max-h-(--available-height) w-[560px] max-w-(--available-width) gap-0 overflow-hidden p-0"
            >
              <LayoutPicker mode="add" onBlank={() => void app().addSlide()} onDone={() => setAddingSlide(false)} />
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <OpenSelectedFold />
      <BulkActions deck={deck} />
      {/*
        Always keeps the scrollbar's room (its track is transparent): the thumbnails' height follows
        their width, so a scrollbar that came and went with the overflow would narrow them until
        they fit, then widen them until they overflow again, and the rail would flicker.
      */}
      <div data-rail-scroller className="min-h-0 flex-1 overflow-y-scroll px-3 pb-4 pt-1.5">
        {deck.slides.length === 0 ? (
          <RailNote>
            No slides yet. Describe your presentation in the chat, or add a blank slide with the + above.
          </RailNote>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            modifiers={DRAG_MODIFIERS}
            autoScroll={DRAG_SCROLL}
            measuring={moving ? MEASURE_ALWAYS : MEASURE_DRAGGING}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
          >
            {found?.size === 0 && <RailNote>No slide contains this text.</RailNote>}
            <Remeasure handle={remeasure} />
            <SortableContext items={keys} strategy={verticalListSortingStrategy} disabled={!!found}>
              {/*
                One menu for every row: a row right-clicked sets what it holds (`openSlideMenu`,
                `openSectionMenu`) before the click reaches the list, which opens it at the pointer.
                A right-click between the rows opens none, and while a section's title is typed
                the field keeps its own.
              */}
              <ContextMenu
                disabled={editingSection !== null}
                onOpenChangeComplete={(open) => {
                  const section = renameAfterMenu.current;
                  if (open || section === null) return;
                  renameAfterMenu.current = null;
                  typingTitle.current = true;
                  setEditingSection(section);
                }}
              >
                <ContextMenuTrigger
                  render={<ol ref={list} className="flex flex-col gap-3" />}
                  onContextMenu={(event) => {
                    if (!menuAsked.current) event.preventBaseUIHandler();
                    menuAsked.current = false;
                  }}
                >
                  {moving && looseSlides > 0 && <LooseSlides count={looseSlides} />}
                  {items.map((item) =>
                    item.kind === "slide" ? (
                      <Thumbnail
                        key={item.key}
                        deckId={deck.id}
                        slide={item.slide}
                        index={item.index}
                        editing={editing}
                        filteredOut={(!!found && !found.has(item.slide.id)) || folded.has(item.slide.id)}
                        folded={!!moving}
                        still={!!moving || settling}
                        draggedAlong={dragged.length > 1 && dragged.includes(item.slide.id)}
                        matches={found?.get(item.slide.id)}
                        onMenu={openSlideMenu}
                      />
                    ) : (
                      <SectionHeader
                        key={item.key}
                        itemKey={item.key}
                        section={item.section}
                        filteredOut={!!found}
                        still={!!moving || settling}
                        slides={moving ? sizes.get(item.key) : undefined}
                        first={starts.get(item.key)}
                        collapsed={collapsed.includes(starts.get(item.key) ?? "")}
                        count={sizes.get(item.key) ?? 0}
                        editing={editingSection === item.section.index}
                        onEditing={setEditingSection}
                        onMenu={openSectionMenu}
                      />
                    ),
                  )}
                </ContextMenuTrigger>
                <ContextMenuContent
                  aria-label={menu?.label}
                  className="min-w-56"
                  finalFocus={() => renameAfterMenu.current === null && !typingTitle.current}
                >
                  <RailMenuItems entries={menu?.entries ?? []} />
                </ContextMenuContent>
              </ContextMenu>
            </SortableContext>
            {/* Follows the pointer on its own: the rail scrolls and moves under it as the slides fold. */}
            {moving && (
              <DragOverlay dropAnimation={null}>
                <div
                  data-testid="section-overlay"
                  className="flex items-center gap-2 rounded bg-sidebar pb-1 pl-6 pr-1 pt-1 ring-1 ring-border"
                >
                  <span className={cn(SECTION_HEADING, "min-w-0 truncate")}>{sectionTitle(items, moving.key)}</span>
                  <Separator className="flex-1 data-horizontal:w-auto" />
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {plural(sizes.get(moving.key) ?? 0, "slide")}
                  </span>
                </div>
              </DragOverlay>
            )}
            {/* Rides on the slide being dragged, to say that the other picked ones go along. */}
            {!moving && dragged.length > 1 && (
              <DragOverlay dropAnimation={null} className="pointer-events-none">
                <Badge data-testid="drag-count" className="absolute -right-1 -top-2 text-2xs font-semibold shadow-md">
                  {plural(dragged.length, "slide")}
                </Badge>
              </DragOverlay>
            )}
          </DndContext>
        )}
      </div>
    </div>
  );
}

/** Going to a slide folded away, with the keys or from the stage, opens its section to show it. */
function OpenSelectedFold() {
  const selected = useApp((s) => s.selected);
  useEffect(() => {
    const { deck, collapsedSections, toggleSection } = useApp.getState();
    if (!deck || !selected) return;
    const first = foldHolding(sectionBlocks(railItems(deck)), collapsedSections, selected);
    if (first !== undefined) toggleSection(first, false);
  }, [selected]);
  return null;
}

/** Starts a section at the selected slide, which is what it follows, so that the rail need not. */
function StartSectionButton(props: { deck: Deck; onStart: (slide: string) => void }) {
  const { deck } = props;
  const selected = useApp((s) => s.selected);
  const index = deck.slides.findIndex((s) => s.id === selected);
  return (
    <Button
      variant="tool"
      size="icon-xs"
      aria-label="Start a section at this slide"
      tooltip={
        index < 0
          ? "Select a slide to start a section"
          : startsSection(deck, index)
            ? "This slide already starts a section"
            : "Start a section at this slide"
      }
      onClick={() => selected && props.onStart(selected)}
      disabled={index < 0 || startsSection(deck, index)}
    >
      <SquareSplitVertical className="size-4" />
    </Button>
  );
}

/**
 * What can be done to the slides picked with ⇧/⌘-click, in every mode. Locked ones are not
 * deleted or hidden.
 */
function BulkActions({ deck }: { deck: Deck }) {
  const count = useApp((s) => s.railSelected.length);
  const searching = useApp((s) => !!s.search.matches);
  if (count < 2) return null;
  const app = useApp.getState();
  const picked = railSelection(app);
  const free = deck.slides.filter((s) => picked.includes(s.id) && !s.locked);
  const ids = free.map((s) => s.id);
  const show = free.length > 0 && free.every((s) => s.hidden);
  const locked = picked.length - free.length;
  const skips = locked > 0 ? ` (not the ${locked} locked)` : "";
  return (
    <div role="toolbar" aria-label="Selected slides" className="flex h-8 shrink-0 items-center gap-0.5 border-y px-3">
      <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">{picked.length} selected</span>
      <Button
        variant="tool"
        size="icon-xs"
        aria-label="Move up"
        tooltip={searching ? SEARCH_REORDER : "Move up"}
        shortcut={searching ? undefined : "mod+up"}
        disabled={searching}
        onClick={() => void app.moveSlides(-1)}
      >
        <ArrowUp />
      </Button>
      <Button
        variant="tool"
        size="icon-xs"
        aria-label="Move down"
        tooltip={searching ? SEARCH_REORDER : "Move down"}
        shortcut={searching ? undefined : "mod+down"}
        disabled={searching}
        onClick={() => void app.moveSlides(1)}
      >
        <ArrowDown />
      </Button>
      <Button
        variant="tool"
        size="icon-xs"
        aria-label={`${show ? "Show" : "Hide"} slides`}
        tooltip={`${show ? "Show" : "Hide"} slides${skips}`}
        disabled={free.length === 0}
        onClick={() => void app.setSlidesHidden(ids, !show)}
      >
        {show ? <Eye /> : <EyeOff />}
      </Button>
      <Button variant="tool" size="icon-xs" tooltip="Duplicate slides" onClick={() => void app.duplicateSlides(picked)}>
        <Copy />
      </Button>
      <Button
        variant="tool"
        size="icon-xs"
        aria-label="Delete slides"
        tooltip={`Delete slides${skips}`}
        disabled={free.length === 0}
        onClick={() => void app.deleteSlides(ids)}
        className="hover:text-destructive"
      >
        <Trash2 />
      </Button>
      <Button
        variant="tool"
        size="icon-xs"
        tooltip="Clear selection"
        shortcut="escape"
        onClick={app.clearRailSelection}
      >
        <X />
      </Button>
    </div>
  );
}

/** A line the rail says in place of its slides: that there are none yet, or none with the text searched for. */
function RailNote({ children }: { children: React.ReactNode }) {
  return (
    <Empty className="flex-none items-start p-0 px-1 pt-2 text-left">
      <EmptyHeader className="items-start">
        <EmptyDescription className="text-xs/relaxed">{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** What the rail is headed with: how many slides, how many of them a search found, how many are hidden. */
export function railTitle(slides: number, found: number | undefined, hidden: number): string {
  if (found !== undefined) return `Slides · ${found} of ${slides}`;
  return hidden > 0 ? `Slides · ${slides} (${hidden} hidden)` : `Slides · ${slides}`;
}

/** Hands out a way to have dnd-kit measure every row again, which it only does when a drag starts. */
function Remeasure({ handle }: { handle: React.RefObject<(() => void) | undefined> }) {
  const { measureDroppableContainers } = useDndContext();
  useEffect(() => {
    handle.current = () => measureDroppableContainers([]);
    return () => {
      handle.current = undefined;
    };
  }, [handle, measureDroppableContainers]);
  return null;
}

function sectionTitle(items: RailItem[], key: string) {
  const row = items.find((item) => item.key === key);
  return (row?.kind === "section" && row.section.title) || "Untitled section";
}

/** Stands in for the slides before the first section, which stay put while sections move. */
function LooseSlides({ count }: { count: number }) {
  return (
    <li
      data-testid="loose-slides"
      data-fold-label
      className="flex items-center gap-2 pt-1 text-2xs text-muted-foreground"
    >
      <span className="w-4 shrink-0" />
      {plural(count, "slide")}
    </li>
  );
}
