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
import { FolderPlus, LayoutGrid, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  startsSection,
} from "../lib/sections";
import { cn, plural } from "../lib/utils";
import { railSelection, useApp } from "../store";
import { ToolButton } from "./Button";
import { BulkActions } from "./rail/BulkActions";
import { foldSlides, holdIframes, holdRow, openTop, releaseIframes, rowTop, type SectionMove } from "./rail/fold";
import { NewSlide } from "./rail/NewSlide";
import { useOverflowWatch } from "./rail/overflowMarks";
import { railTitle, useRailRows, useSameKeys, useSearchCounts } from "./rail/rows";
import { SectionHeader } from "./rail/SectionHeader";
import { ONE_ROW_OF_ACTIONS, SLIDE_LIST_ATTR, Thumbnail } from "./rail/Thumbnail";
import { OVERVIEW_KEY, useOverviewKey } from "./rail/useOverviewKey";
import { useRailMenus } from "./rail/useRailMenus";
import { SectionLabel } from "./SectionLabel";

/** What a double-click on a slide of the list says it does, in View; in Edit the slide is being edited already. */
const EDIT_HINT = "double-click to edit";

/** A double-click on a slide of the list: on to editing it. */
function editSlide(slide: string) {
  useApp.getState().select(slide);
  useApp.getState().setMode("edit");
}

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
 * The deck's slides and sections, to go through, pick from and organise: adding, duplicating,
 * deleting, hiding, locking and reordering slides, and the sections. It works the same in View
 * and in Edit: the modes are about the slide on the stage, not about the list.
 *
 * A right-click on a slide or a section's header opens its menu (see ./rail/menus.ts): on a slide
 * that is not picked it picks that slide first, and with several picked it is about all of them.
 * Slides and sections are moved by dragging, or with the keyboard: Space on a row picks it up, the
 * arrows move it, Space puts it down. One of several picked slides takes the others along.
 *
 * The rail itself does not follow which slide is selected: the rows that are picked or let go
 * follow it themselves, as do the bits of its header that depend on it (`RailHeader`,
 * `OpenSelectedFold`), so going through the slides renders two rows, not the whole list.
 */
export function SlideRail() {
  const deck = useApp((s) => s.deck);
  // In Edit the slide on the stage is being edited already; in View a double-click goes there.
  const editing = useApp((s) => s.editing);
  const header = useRef<HTMLDivElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, POINTER_DRAG), useSensor(KeyboardSensor, KEYBOARD_DRAG));
  const { menu, openSlideMenu, openSectionMenu, editingSection, setEditingSection, startSection } = useRailMenus();
  useOverviewKey();
  useOverflowWatch();
  // The slides going along with the one being dragged, itself included; empty when it goes alone.
  const [dragged, setDragged] = useState<string[]>([]);
  const matches = useApp((s) => s.search.matches);
  const collapsed = useApp((s) => s.collapsedSections);
  // While a search runs the rail still lists every slide: those it found carry their count, the
  // others are dimmed, and the order can be changed as ever.
  const found = useSearchCounts(matches);
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
      <RailHeader
        ref={header}
        deck={deck}
        title={railTitle(deck.slides.length, hiddenCount)}
        short={String(deck.slides.length)}
        onStartSection={startSection}
      />
      <NewSlide anchor={header} />
      {menu}
      <OpenSelectedFold />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-1.5">
        {deck.slides.length === 0 ? (
          <p className="px-1 pt-2 text-xs leading-relaxed text-muted-foreground">
            No slides yet. Describe your presentation in the chat, or add a slide with the + above.
          </p>
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
            <Remeasure handle={remeasure} />
            <SortableContext items={keys} strategy={verticalListSortingStrategy}>
              <ol ref={list} {...{ [SLIDE_LIST_ATTR]: "" }} className={cn("flex flex-col gap-3", ONE_ROW_OF_ACTIONS)}>
                {moving && looseSlides > 0 && <LooseSlides count={looseSlides} />}
                {items.map((item) =>
                  item.kind === "slide" ? (
                    <Thumbnail
                      key={item.key}
                      deckId={deck.id}
                      slide={item.slide}
                      index={item.index}
                      filteredOut={folded.has(item.slide.id)}
                      dimmed={!!found && !found.has(item.slide.id)}
                      folded={!!moving}
                      still={!!moving || settling}
                      draggedAlong={dragged.length > 1 && dragged.includes(item.slide.id)}
                      matches={found?.get(item.slide.id)}
                      hint={editing ? undefined : EDIT_HINT}
                      onMenu={openSlideMenu}
                      onOpen={editSlide}
                    />
                  ) : (
                    <SectionHeader
                      key={item.key}
                      itemKey={item.key}
                      section={item.section}
                      filteredOut={false}
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
              </ol>
            </SortableContext>
            {/* Follows the pointer on its own: the rail scrolls and moves under it as the slides fold. */}
            {moving && (
              <DragOverlay dropAnimation={null}>
                <div
                  data-testid="section-overlay"
                  className="flex items-center gap-2 rounded bg-sidebar pb-1 pl-6 pr-1 pt-1 ring-1 ring-border"
                >
                  <SectionLabel className="min-w-0 truncate">{sectionTitle(items, moving.key)}</SectionLabel>
                  <span className="h-px flex-1 bg-border" />
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {plural(sizes.get(moving.key) ?? 0, "slide")}
                  </span>
                </div>
              </DragOverlay>
            )}
            {/* Rides on the slide being dragged, to say that the other picked ones go along. */}
            {!moving && dragged.length > 1 && (
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

/**
 * The row over the list: how many slides there are, and the buttons for the grid of all slides, a
 * new section and a new slide. While several slides are picked, what can be done to them takes
 * its place (see ./rail/BulkActions.tsx), the row keeping its height. It never wraps: in a narrow
 * list the title is cut short, then gives way to the bare count. It follows the picks and the
 * selected slide itself, so that the rail need not.
 */
function RailHeader(props: {
  ref: React.RefObject<HTMLDivElement | null>;
  deck: Deck;
  title: string;
  /** The count alone, for a list too narrow for the title. */
  short: string;
  onStartSection: (slide: string) => void;
}) {
  const { deck } = props;
  const several = useApp((s) => s.railSelected.length > 1);
  const overview = useApp((s) => s.overview);
  const adding = useApp((s) => s.addingSlide);
  const app = useApp.getState;
  return (
    <div ref={props.ref} className="@container flex h-10 shrink-0 items-center gap-1 px-3">
      {several ? (
        <BulkActions deck={deck} />
      ) : (
        <>
          <SectionLabel title={props.title} className="min-w-0 flex-1 truncate whitespace-nowrap">
            <span className="hidden @[11rem]:inline">{props.title}</span>
            <span className="@[11rem]:hidden">{props.short}</span>
          </SectionLabel>
          <div className="flex shrink-0 items-center gap-0.5">
            <ToolButton
              variant="panel"
              label="All slides"
              title={overview ? "Back to the slide" : "Show all slides as a grid"}
              shortcut={OVERVIEW_KEY}
              active={overview}
              aria-pressed={overview}
              disabled={deck.slides.length === 0}
              disabledReason="There are no slides to show yet"
              onClick={() => app().setOverview(!overview)}
            >
              <LayoutGrid className="size-4" />
            </ToolButton>
            <StartSectionButton deck={deck} onStart={props.onStartSection} />
            <ToolButton
              variant="panel"
              label="New slide"
              title="New slide…"
              shortcut="mod+shift+n"
              onClick={() => app().setAddingSlide(!adding)}
              aria-expanded={adding}
              aria-haspopup="dialog"
            >
              <Plus className="size-4" />
            </ToolButton>
          </div>
        </>
      )}
    </div>
  );
}

/** Starts a section at the selected slide, which is what it follows. */
function StartSectionButton(props: { deck: Deck; onStart: (slide: string) => void }) {
  const { deck } = props;
  const selected = useApp((s) => s.selected);
  const index = deck.slides.findIndex((s) => s.id === selected);
  return (
    <ToolButton
      variant="panel"
      label="Start a section at this slide"
      onClick={() => selected && props.onStart(selected)}
      disabled={index < 0 || startsSection(deck, index)}
      disabledReason={index < 0 ? "Select a slide to start a section" : "This slide already starts a section"}
    >
      <FolderPlus className="size-4" />
    </ToolButton>
  );
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
