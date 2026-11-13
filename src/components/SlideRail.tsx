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
  sectionStarts,
  startsSection,
} from "../lib/sections";
import { plural } from "../lib/utils";
import { railSelection, useApp } from "../store";
import { ToolButton } from "./Button";
import { EDIT_ONLY } from "./editOnly";
import { Popover } from "./Popover";
import { ContextMenu, type MenuEntry } from "./rail/ContextMenu";
import { foldSlides, holdIframes, holdRow, openTop, releaseIframes, rowTop, type SectionMove } from "./rail/fold";
import { SEARCH_REORDER, sectionMenu, slideMenu } from "./rail/menus";
import { SectionHeader } from "./rail/SectionHeader";
import { Thumbnail } from "./rail/Thumbnail";
import { SectionLabel } from "./SectionLabel";
import { LayoutPicker } from "./Templates";

/** The keys that move a row with the keyboard: Space picks it up and puts it down; Enter is the thumbnail's own. */
const KEYBOARD_DRAG = { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] };

/** A right-click's menu, where it was asked for. */
type OpenMenu = { label: string; x: number; y: number; entries: MenuEntry[] };

/**
 * The deck's slides and sections, to go through and pick from. Changing them is Edit mode's:
 * adding, duplicating, deleting, hiding, locking and reordering slides, and the sections. In View
 * the rail only shows them, folds sections and picks slides; its "+" goes to Edit to add one.
 *
 * A right-click on a slide or a section's header opens its menu (see ./rail/menus.ts): on a slide
 * that is not picked it picks that slide first, and with several picked it is about all of them.
 * Slides and sections are moved by dragging, or with the keyboard: Space on a row picks it up, the
 * arrows move it, Space puts it down. One of several picked slides takes the others along.
 */
export function SlideRail() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const editable = useApp((s) => s.editing);
  const [editingSection, setEditingSection] = useState<number | null>(null);
  const [addingSlide, setAddingSlide] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: KEYBOARD_DRAG }),
  );
  const [menu, setMenu] = useState<OpenMenu | null>(null);
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
  // Going to a slide folded away, with the keys or from the stage, opens its section to show it.
  useEffect(() => {
    const { deck, collapsedSections, toggleSection } = useApp.getState();
    if (!deck || !selected) return;
    const first = foldHolding(sectionBlocks(railItems(deck)), collapsedSections, selected);
    if (first !== undefined) toggleSection(first, false);
  }, [selected]);
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
  if (!deck) return null;
  // The layouts add a slide, which is Edit mode's: leaving it puts them away.
  if (addingSlide && !editable) setAddingSlide(false);

  const items = railItems(deck);
  const blocks = sectionBlocks(items);
  const keys = moving ? blocks.map((block) => block.key) : items.map((item) => item.key);
  const looseSlides = items.findIndex((item) => item.kind === "section");
  const starts = sectionStarts(blocks);
  // A search shows what it found wherever it is.
  const folded = found ? new Set<string>() : foldedSlides(blocks, collapsed);
  const selectedIndex = deck.slides.findIndex((s) => s.id === selected);
  const canAddSection = selectedIndex >= 0 && !startsSection(deck, selectedIndex);
  const hiddenCount = deck.slides.filter((s) => s.hidden).length;
  const app = useApp.getState;

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

  /** Starts a section at `slide`, and goes on to naming it. */
  const startSection = async (slide: string) => setEditingSection(await app().startSection(slide));

  /** The "+": the layouts to add a slide on. Adding one is Edit mode's, so in View it goes there first. */
  const openLayouts = () => {
    if (!editable) app().setMode("edit");
    setAddingSlide((open) => !open);
  };

  const openSlideMenu = (event: React.MouseEvent, slide: string) => {
    event.preventDefault();
    // A slide that is not picked is what the menu is about; one of the picked ones stands for all.
    if (!railSelection(app()).includes(slide)) app().select(slide);
    const state = app();
    const entries = slideMenu(
      deck,
      slide,
      railSelection(state),
      { editable, searching: !!state.search.matches },
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
    setMenu({ label: "Slide", x: event.clientX, y: event.clientY, entries });
  };

  const openSectionMenu = (event: React.MouseEvent, key: string) => {
    const row = items.find((item) => item.key === key);
    if (row?.kind !== "section") return;
    event.preventDefault();
    const { section } = row;
    const entries = sectionMenu(key, blocks, app().collapsedSections, editable, {
      rename: () => setEditingSection(section.index),
      setCollapsed: (first, folded) => app().toggleSection(first, folded),
      setAllCollapsed: (firsts, folded) => app().setSectionsCollapsed(firsts, folded),
      select: (slides) => app().pickSlides(slides),
      remove: () => void app().removeSection(section.index),
    });
    setMenu({ label: "Section", x: event.clientX, y: event.clientY, entries });
  };

  return (
    <div data-slide-rail className="flex h-full flex-col bg-sidebar">
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <SectionLabel>{railTitle(deck.slides.length, found?.size, hiddenCount)}</SectionLabel>
        <div className="flex items-center gap-0.5">
          <ToolButton
            variant="panel"
            label="Start a section at this slide"
            onClick={() => selected && void startSection(selected)}
            disabled={!editable || !canAddSection}
            disabledReason={
              !editable
                ? EDIT_ONLY
                : selectedIndex < 0
                  ? "Select a slide to start a section"
                  : "This slide already starts a section"
            }
          >
            <SquareSplitVertical className="size-4" />
          </ToolButton>
          <ToolButton
            ref={addButton}
            variant="panel"
            label="New slide"
            title={editable ? "New slide" : "New slide: switches to Edit and opens the layouts"}
            onClick={openLayouts}
            aria-expanded={addingSlide}
            aria-haspopup="dialog"
          >
            <Plus className="size-4" />
          </ToolButton>
        </div>
      </div>
      {addingSlide && (
        <Popover
          anchor={addButton}
          placement="below"
          width={560}
          label="New slide"
          onClose={() => setAddingSlide(false)}
        >
          <LayoutPicker mode="add" onBlank={() => void app().addSlide()} onDone={() => setAddingSlide(false)} />
        </Popover>
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      <BulkActions deck={deck} editable={editable} />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-1.5">
        {deck.slides.length === 0 ? (
          <p className="px-1 pt-2 text-xs leading-relaxed text-muted-foreground">
            No slides yet. Describe your presentation in the chat, or switch to Edit and add a blank slide.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            modifiers={[restrictToVerticalAxis]}
            autoScroll={{ layoutShiftCompensation: false }}
            measuring={{ droppable: { strategy: moving ? MeasuringStrategy.Always : MeasuringStrategy.WhileDragging } }}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
          >
            {found?.size === 0 && (
              <p className="px-1 pt-2 text-xs leading-relaxed text-muted-foreground">No slide contains this text.</p>
            )}
            <Remeasure handle={remeasure} />
            <SortableContext items={keys} strategy={verticalListSortingStrategy} disabled={!!found || !editable}>
              <ol ref={list} className="flex flex-col gap-3">
                {moving && looseSlides > 0 && <LooseSlides count={looseSlides} />}
                {items.map((item) =>
                  item.kind === "slide" ? (
                    <Thumbnail
                      key={item.key}
                      deckId={deck.id}
                      slide={item.slide}
                      index={item.index}
                      editable={editable}
                      filteredOut={(!!found && !found.has(item.slide.id)) || folded.has(item.slide.id)}
                      folded={!!moving}
                      still={!!moving || settling}
                      draggedAlong={dragged.length > 1 && dragged.includes(item.slide.id)}
                      matches={found?.get(item.slide.id)}
                      onMenu={(event) => openSlideMenu(event, item.slide.id)}
                    />
                  ) : (
                    <SectionHeader
                      key={item.key}
                      itemKey={item.key}
                      section={item.section}
                      editable={editable}
                      filteredOut={!!found}
                      still={!!moving || settling}
                      slides={moving ? blocks.find((block) => block.key === item.key)!.rows.length - 1 : undefined}
                      first={starts.get(item.key)}
                      collapsed={collapsed.includes(starts.get(item.key) ?? "")}
                      count={blocks.find((block) => block.key === item.key)!.rows.length - 1}
                      editing={editingSection === item.section.index}
                      onEditing={(editing) => setEditingSection(editing ? item.section.index : null)}
                      onMenu={(event) => openSectionMenu(event, item.key)}
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
                    {plural((blocks.find((block) => block.key === moving.key)?.rows.length ?? 1) - 1, "slide")}
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

/**
 * What can be done to the slides picked with ⇧/⌘-click. Locked ones are not deleted or hidden,
 * and out of Edit mode (`editable`) none of them is changed.
 */
function BulkActions({ deck, editable }: { deck: Deck; editable: boolean }) {
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
      <ToolButton
        variant="panel"
        label="Move up"
        shortcut="mod+up"
        disabledReason={editable ? SEARCH_REORDER : EDIT_ONLY}
        disabled={!editable || searching}
        onClick={() => void app.moveSlides(-1)}
      >
        <ArrowUp className="size-3.5" />
      </ToolButton>
      <ToolButton
        variant="panel"
        label="Move down"
        shortcut="mod+down"
        disabledReason={editable ? SEARCH_REORDER : EDIT_ONLY}
        disabled={!editable || searching}
        onClick={() => void app.moveSlides(1)}
      >
        <ArrowDown className="size-3.5" />
      </ToolButton>
      <ToolButton
        variant="panel"
        aria-label={`${show ? "Show" : "Hide"} slides`}
        title={editable ? `${show ? "Show" : "Hide"} slides${skips}` : EDIT_ONLY}
        disabled={!editable || free.length === 0}
        onClick={() => void app.setSlidesHidden(ids, !show)}
      >
        {show ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </ToolButton>
      <ToolButton
        variant="panel"
        aria-label="Duplicate slides"
        title={editable ? "Duplicate slides" : EDIT_ONLY}
        disabled={!editable}
        onClick={() => void app.duplicateSlides(picked)}
      >
        <Copy className="size-3.5" />
      </ToolButton>
      <ToolButton
        variant="panel"
        aria-label="Delete slides"
        title={editable ? `Delete slides${skips}` : EDIT_ONLY}
        disabled={!editable || free.length === 0}
        onClick={() => void app.deleteSlides(ids)}
      >
        <Trash2 className="size-3.5" />
      </ToolButton>
      <ToolButton variant="panel" label="Clear selection" shortcut="escape" onClick={app.clearRailSelection}>
        <X className="size-3.5" />
      </ToolButton>
    </div>
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
