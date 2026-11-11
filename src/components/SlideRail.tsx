import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MeasuringStrategy,
  PointerSensor,
  useDndContext,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  SquareSplitVertical,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { api, type Deck, type Section, type Slide } from "../lib/api";
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
import { pixelsOf } from "../lib/slideSize";
import { cn, plural } from "../lib/utils";
import { railSelection, reportingErrors, useApp } from "../store";
import { ToolButton } from "./Button";
import { Popover } from "./Popover";
import { foldSlides, holdIframes, holdRow, openTop, releaseIframes, rowTop, type SectionMove } from "./rail/fold";
import { SectionLabel } from "./SectionLabel";
import { SlideFrame, useSlideVersion } from "./SlideFrame";
import { LayoutPicker } from "./Templates";

/** What the tools that change the deck say in View mode, where they are off. */
const EDIT_ONLY = "Switch to Edit to change the slides";

/** How a slide in the rail eases into and out of being hidden or locked. */
const MARK_TRANSITION = "transition duration-200";

/**
 * The deck's slides and sections, to go through and pick from. Changing them is Edit mode's:
 * adding, duplicating, deleting, hiding, locking and reordering slides, and the sections. In View
 * the rail only shows them, folds sections and picks slides.
 */
export function SlideRail() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const editable = useApp((s) => s.editing);
  const [editingSection, setEditingSection] = useState<number | null>(null);
  const [addingSlide, setAddingSlide] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const matches = useApp((s) => s.search.matches);
  const collapsed = useApp((s) => s.collapsedSections);
  // While a search runs the rail lists what it found. The rest stay mounted, hidden, so ending it
  // doesn't reload every thumbnail, and can't be dragged: an order needs all the slides in view.
  const found = useMemo(() => matches && new Set(matches.map((m) => m.slide)), [matches]);
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

  const items = railItems(deck);
  const blocks = sectionBlocks(items);
  const keys = moving ? blocks.map((block) => block.key) : items.map((item) => item.key);
  const looseSlides = items.findIndex((item) => item.kind === "section");
  const starts = sectionStarts(blocks);
  // A search shows what it found wherever it is.
  const folded = found ? new Set<string>() : foldedSlides(blocks, collapsed);
  const selectedIndex = deck.slides.findIndex((s) => s.id === selected);
  const canAddSection = selectedIndex >= 0 && !startsSection(deck, selectedIndex);

  const onDragStart = ({ active }: DragStartEvent) => {
    holdIframes();
    const key = String(active.id);
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
    if (moving) putDown(moving, keys.indexOf(moving.key), moving.top);
  };

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    releaseIframes();
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

  const addSlide = () =>
    reportingErrors(async () => {
      const created = await api.addSlide(deck.id, useApp.getState().selected);
      useApp.getState().setDeck(created.deck);
      useApp.getState().select(created.slide);
    });

  const addSection = () =>
    reportingErrors(async () => {
      const next = await api.addSection(deck.id, selected, "New section");
      useApp.getState().setDeck(next);
      const created = next.sections.filter((s) => s.before === selectedIndex).at(-1);
      setEditingSection(created?.index ?? null);
    });

  return (
    <div data-slide-rail className="flex h-full flex-col bg-sidebar">
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <SectionLabel>Slides · {found ? `${found.size} of ${deck.slides.length}` : deck.slides.length}</SectionLabel>
        <div className="flex items-center gap-0.5">
          <ToolButton
            variant="panel"
            onClick={addSection}
            disabled={!editable || !canAddSection}
            title={
              !editable
                ? EDIT_ONLY
                : selectedIndex >= 0 && !canAddSection
                  ? "This slide already starts a section"
                  : "Start a section at this slide"
            }
          >
            <SquareSplitVertical className="size-4" />
          </ToolButton>
          <ToolButton
            ref={addButton}
            variant="panel"
            onClick={() => setAddingSlide((open) => !open)}
            aria-expanded={addingSlide}
            aria-label="New slide"
            disabled={!editable}
            title={editable ? "New slide" : EDIT_ONLY}
          >
            <Plus className="size-4" />
          </ToolButton>
        </div>
      </div>
      {addingSlide && editable && (
        <Popover
          anchor={addButton}
          placement="below"
          width={560}
          label="New slide"
          onClose={() => setAddingSlide(false)}
        >
          <LayoutPicker mode="add" onBlank={() => void addSlide()} onDone={() => setAddingSlide(false)} />
        </Popover>
      )}
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
                    />
                  ) : (
                    <SectionHeader
                      key={item.key}
                      itemKey={item.key}
                      deckId={deck.id}
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
        aria-label="Move up"
        title={editable ? "Move up (⌘↑)" : EDIT_ONLY}
        disabled={!editable || searching}
        onClick={() => void app.moveSlides(-1)}
      >
        <ArrowUp className="size-3.5" />
      </ToolButton>
      <ToolButton
        variant="panel"
        aria-label="Move down"
        title={editable ? "Move down (⌘↓)" : EDIT_ONLY}
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
      <ToolButton variant="panel" title="Clear selection" onClick={app.clearRailSelection}>
        <X className="size-3.5" />
      </ToolButton>
    </div>
  );
}

const noLayoutAnimation = () => false;

/** Shows the deck as `change` leaves it, or what went wrong. */
async function updateDeck(change: () => Promise<Deck>) {
  const next = await reportingErrors(change);
  if (next) useApp.getState().setDeck(next);
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

/** Divider row that names a section. Only the editor shows it; the player never does. */
function SectionHeader(props: {
  itemKey: string;
  deckId: string;
  section: Section;
  /** Edit mode: the section can be renamed, removed and moved. */
  editable: boolean;
  filteredOut: boolean;
  /** How many slides are folded under the row while sections are being moved. */
  slides?: number;
  /** Keeps dnd-kit from sliding the row anywhere while the slides fold and open. */
  still: boolean;
  /** The section's first slide, which names its fold; none when the section has no slides. */
  first?: string;
  /** Whether the user folded the section's slides away under it. */
  collapsed: boolean;
  /** How many slides the section holds. */
  count: number;
  editing: boolean;
  onEditing: (editing: boolean) => void;
}) {
  const { deckId, section, editing, onEditing } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.itemKey,
    animateLayoutChanges: props.still ? noLayoutAnimation : undefined,
  });

  const commit = async (title: string) => {
    onEditing(false);
    const next = title.trim();
    if (!next || next === section.title) return;
    await updateDeck(() => api.renameSection(deckId, section.index, next));
  };

  const remove = () => updateDeck(() => api.deleteSection(deckId, section.index));

  return (
    <li
      ref={setNodeRef}
      data-testid="section-header"
      data-section-key={props.itemKey}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(props.filteredOut ? "hidden" : "group flex items-center gap-2 pt-1", isDragging && "opacity-0")}
      {...attributes}
      {...listeners}
    >
      {props.first === undefined || props.slides !== undefined ? (
        <span className="w-4 shrink-0" />
      ) : (
        <button
          type="button"
          title={props.collapsed ? "Expand section" : "Collapse section"}
          aria-expanded={!props.collapsed}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            useApp.getState().toggleSection(props.first!);
          }}
          className="flex w-4 shrink-0 justify-end rounded text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn("size-3 transition-transform duration-200", !props.collapsed && "rotate-90")} />
        </button>
      )}
      {editing ? (
        <input
          autoFocus
          aria-label="Section title"
          defaultValue={section.title}
          onFocus={(e) => e.currentTarget.select()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              e.currentTarget.value = section.title;
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => void commit(e.currentTarget.value)}
          className="min-w-0 flex-1 rounded border border-input bg-background px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-foreground outline-none focus:ring-1 focus:ring-primary"
        />
      ) : (
        <>
          {/* Double-click is a shortcut for the adjacent keyboard-accessible Rename section button. */}
          <SectionLabel
            title={props.editable ? "Double-click to rename" : undefined}
            onDoubleClick={() => props.editable && onEditing(true)}
            className={cn("min-w-0 truncate", !section.title && "italic")}
          >
            {section.title || "Untitled section"}
          </SectionLabel>
          <span className="h-px flex-1 bg-border" />
          {props.slides !== undefined ? (
            <span data-fold-label className="shrink-0 pr-1 text-2xs text-muted-foreground">
              {plural(props.slides, "slide")}
            </span>
          ) : (
            <>
              {props.collapsed && (
                <span data-testid="folded-count" className="shrink-0 text-2xs text-muted-foreground">
                  {plural(props.count, "slide")}
                </span>
              )}
              {props.editable && (
                <div className="invisible flex shrink-0 gap-0.5 group-hover:visible group-focus-within:visible">
                  <SectionAction title="Rename section" onClick={() => onEditing(true)}>
                    <Pencil className="size-3" />
                  </SectionAction>
                  <SectionAction title="Remove section" onClick={remove}>
                    <X className="size-3" />
                  </SectionAction>
                </div>
              )}
            </>
          )}
        </>
      )}
    </li>
  );
}

function SectionAction(props: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={props.title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {props.children}
    </button>
  );
}

function Thumbnail(props: {
  deckId: string;
  slide: Slide;
  index: number;
  /** Edit mode: the slide can be locked, hidden, duplicated and deleted from here. */
  editable: boolean;
  filteredOut: boolean;
  folded: boolean;
  still: boolean;
}) {
  const { deckId, slide, index, filteredOut, folded } = props;
  const selected = useApp((s) => s.selected === slide.id);
  const picked = useApp((s) => s.railSelected.includes(slide.id));
  const version = useSlideVersion(slide);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: slide.id,
    animateLayoutChanges: props.still ? noLayoutAnimation : undefined,
  });
  const itemRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (selected) itemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  const deckSize = useApp((s) => s.deck?.size);

  const toggleLocked = () => updateDeck(() => api.setSlideLocked(deckId, slide.id, !slide.locked));

  const onClick = (event: React.MouseEvent) => {
    const app = useApp.getState();
    if (event.shiftKey) app.extendRailSelection(slide.id, "range");
    else if (event.metaKey || event.ctrlKey) app.extendRailSelection(slide.id, "toggle");
    else app.select(slide.id);
  };

  const onDoubleClick = () => {
    useApp.getState().select(slide.id);
    useApp.getState().setMode("edit");
  };

  return (
    <li
      ref={(node) => {
        setNodeRef(node);
        itemRef.current = node;
      }}
      data-rail-slide
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        filteredOut ? "hidden" : "group flex gap-2",
        folded && "pointer-events-none -mt-3 h-0 overflow-hidden opacity-0",
        isDragging && "z-10 opacity-80",
      )}
      {...attributes}
      {...listeners}
    >
      <span
        className={cn(
          "w-4 shrink-0 pt-0.5 text-right text-2xs tabular-nums text-muted-foreground transition-opacity duration-200",
          selected && "font-semibold text-foreground",
          slide.hidden && "opacity-60",
        )}
      >
        {index + 1}
      </span>
      <div className="relative min-w-0 flex-1">
        <button
          type="button"
          title={props.editable ? undefined : "Double-click to edit"}
          aria-pressed={picked || selected}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          className={cn(
            "block w-full overflow-hidden rounded-md transition-shadow",
            // The offset gap keeps the ring visible against dark slides.
            selected
              ? "ring-2 ring-primary ring-offset-2 ring-offset-sidebar"
              : picked
                ? "ring-2 ring-primary/50 ring-offset-2 ring-offset-sidebar"
                : "hover:ring-1 hover:ring-input",
          )}
        >
          <SlideFrame
            deckId={deckId}
            slideId={slide.id}
            version={version}
            size={pixelsOf({ size: deckSize })}
            thumbnail
            className={cn(MARK_TRANSITION, slide.hidden && "opacity-35 grayscale")}
          />
        </button>
        <RailMark shown={slide.hidden} className="inset-0 flex items-center justify-center text-foreground/80">
          <HiddenMark />
        </RailMark>
        <RailMark
          shown={slide.locked}
          testId="locked-mark"
          title="Locked: neither you nor the agent can change it"
          className="bottom-1 left-1 rounded bg-overlay p-1 text-overlay-foreground"
        >
          <Lock className="size-3" aria-label="Locked slide" />
        </RailMark>
        {props.editable && (
          <div className="absolute right-1 top-1 hidden gap-0.5 group-hover:flex">
            <RailAction title={slide.locked ? "Unlock slide" : "Lock slide"} onClick={toggleLocked}>
              {slide.locked ? <LockOpen className="size-3" /> : <Lock className="size-3" />}
            </RailAction>
            <RailAction
              title={slide.hidden ? "Show slide" : "Hide slide"}
              onClick={() => void useApp.getState().setSlidesHidden([slide.id], !slide.hidden)}
            >
              {slide.hidden ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
            </RailAction>
            <RailAction title="Duplicate" onClick={() => void useApp.getState().duplicateSlides([slide.id])}>
              <Copy className="size-3" />
            </RailAction>
            {!slide.locked && (
              <RailAction title="Delete" onClick={() => void useApp.getState().deleteSlides([slide.id])}>
                <Trash2 className="size-3" />
              </RailAction>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** A mark over a slide's thumbnail. It stays mounted so that it can fade out the way it came in. */
function RailMark(props: {
  shown: boolean;
  testId?: string;
  title?: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={props.testId}
      data-shown={props.shown}
      aria-hidden={!props.shown}
      title={props.title}
      className={cn(
        "pointer-events-none absolute",
        MARK_TRANSITION,
        props.className,
        !props.shown && "scale-75 opacity-0",
      )}
    >
      {props.children}
    </div>
  );
}

/** A closed eye, for a hidden slide. */
function HiddenMark() {
  return (
    <svg
      data-testid="hidden-mark"
      aria-label="Hidden slide"
      role="img"
      viewBox="2 8 20 11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className="h-1/3 max-h-8 drop-shadow"
    >
      <path d="M3 10q9 8 18 0" />
      <path d="M6.6 12.6 5 15.6M10.2 13.8l-.6 3.4M13.8 13.8l.6 3.4M17.4 12.6l1.6 3" />
    </svg>
  );
}

function RailAction(props: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={props.title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      className="rounded bg-overlay p-1 text-overlay-foreground hover:opacity-90"
    >
      {props.children}
    </button>
  );
}
