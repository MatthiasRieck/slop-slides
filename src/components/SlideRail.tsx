import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  getClientRect,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  Palette,
  Pencil,
  Plus,
  Redo2,
  SquareSplitVertical,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { api, type Deck, errorMessage, type Section, type Slide } from "../lib/api";
import {
  dropRows,
  dropSection,
  type RailItem,
  railItems,
  sectionBlocks,
  sectionKey,
  startsSection,
} from "../lib/sections";
import { pixelsOf } from "../lib/slideSize";
import { cn } from "../lib/utils";
import { railSelection, useApp } from "../store";
import { SlideFrame, useSlideVersion } from "./SlideFrame";
import { LayoutPicker, Popover, StylePicker } from "./Templates";

export function SlideRail() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const [editingSection, setEditingSection] = useState<number | null>(null);
  const [picker, setPicker] = useState<"style" | "slide" | null>(null);
  const styleButton = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const templates = useApp((s) => s.templates);
  const styleTitle = templates?.find((t) => t.id === deck?.template)?.title;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const matches = useApp((s) => s.search.matches);
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
  useEffect(() => releaseIframes, []);
  useEffect(() => () => stopHolding.current?.(), []);
  useLayoutEffect(() => {
    const rows = list.current;
    if (!rows) return;
    if (moving) {
      foldSlides(rows, moving.slideHeight, false);
      stopHolding.current?.();
      stopHolding.current = holdRow(rows, moving.key, moving.top, moving.top);
      return;
    }
    const dropped = landing.current;
    if (!dropped) return;
    landing.current = null;
    const end = openTop(rows, dropped);
    foldSlides(rows, dropped.slideHeight, true);
    stopHolding.current?.();
    stopHolding.current = holdRow(rows, dropped.key, dropped.top, end, () => {
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
  const selectedIndex = deck.slides.findIndex((s) => s.id === selected);
  const canAddSection = selectedIndex >= 0 && !startsSection(deck, selectedIndex);

  const onDragStart = ({ active }: DragStartEvent) => {
    holdIframes();
    const key = String(active.id);
    const top = blocks.some((block) => block.key === key) ? rowTop(list.current, key) : null;
    const slideHeight = list.current?.querySelector<HTMLElement>("[data-rail-slide]")?.offsetHeight ?? 0;
    if (top != null) setMoving({ key, top, slideHeight });
  };

  // Only the sections' rows are open to a drop while a section moves; the rest take no space.
  const collisionDetection: CollisionDetection = (args) =>
    closestCenter(
      moving
        ? { ...args, droppableContainers: args.droppableContainers.filter((c) => keys.includes(`${c.id}`)) }
        : args,
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

  const addSlide = async () => {
    const { selected } = useApp.getState();
    try {
      const created = await api.addSlide(deck.id, selected);
      useApp.getState().setDeck(created.deck);
      useApp.getState().select(created.slide);
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

  const addSection = async () => {
    try {
      const next = await api.addSection(deck.id, selected, "New section");
      useApp.getState().setDeck(next);
      const created = next.sections.filter((s) => s.before === selectedIndex).at(-1);
      setEditingSection(created?.index ?? null);
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Slides · {found ? `${found.size} of ${deck.slides.length}` : deck.slides.length}
        </span>
        <div className="flex items-center gap-0.5">
          <RailHistory />
          <button
            type="button"
            onClick={addSection}
            disabled={!canAddSection}
            title={
              selectedIndex >= 0 && !canAddSection
                ? "This slide already starts a section"
                : "Start a section at this slide"
            }
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <SquareSplitVertical className="size-4" />
          </button>
          <button
            ref={styleButton}
            type="button"
            onClick={() => setPicker((p) => (p === "style" ? null : "style"))}
            aria-expanded={picker === "style"}
            title={
              styleTitle
                ? `Style: ${styleTitle}. Pick another, or save the deck as a template`
                : "Pick a style for the deck, or save it as a template"
            }
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Palette className="size-4" />
          </button>
          <button
            ref={addButton}
            type="button"
            onClick={() => setPicker((p) => (p === "slide" ? null : "slide"))}
            aria-expanded={picker === "slide"}
            title="New slide"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>
      {picker === "style" && (
        <Popover anchor={styleButton} placement="below" width={600} label="Deck style" onClose={() => setPicker(null)}>
          <StylePicker onDone={() => setPicker(null)} />
        </Popover>
      )}
      {picker === "slide" && (
        <Popover anchor={addButton} placement="below" width={560} label="New slide" onClose={() => setPicker(null)}>
          <LayoutPicker mode="add" onBlank={() => void addSlide()} onDone={() => setPicker(null)} />
        </Popover>
      )}
      <BulkActions deck={deck} />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-1.5">
        {deck.slides.length === 0 ? (
          <p className="px-1 pt-2 text-xs leading-relaxed text-muted-foreground">
            No slides yet. Describe your presentation in the chat, or add a blank slide.
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
            <SortableContext items={keys} strategy={verticalListSortingStrategy} disabled={!!found}>
              <ol ref={list} className="flex flex-col gap-3">
                {moving && looseSlides > 0 && <LooseSlides count={looseSlides} />}
                {items.map((item) =>
                  item.kind === "slide" ? (
                    <Thumbnail
                      key={item.key}
                      deckId={deck.id}
                      slide={item.slide}
                      index={item.index}
                      filteredOut={!!found && !found.has(item.slide.id)}
                      folded={!!moving}
                      still={!!moving || settling}
                    />
                  ) : (
                    <SectionHeader
                      key={item.key}
                      itemKey={item.key}
                      deckId={deck.id}
                      section={item.section}
                      filteredOut={!!found}
                      still={!!moving || settling}
                      slides={moving ? blocks.find((block) => block.key === item.key)!.rows.length - 1 : undefined}
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
                  <span className="min-w-0 truncate text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    {sectionTitle(items, moving.key)}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {slideCount((blocks.find((block) => block.key === moving.key)?.rows.length ?? 1) - 1)}
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

const headerButton =
  "rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

/** Undo and redo of what was done in the rail, once there is something to step through. */
function RailHistory() {
  const canUndo = useApp((s) => s.deckUndo.length > 0);
  const canRedo = useApp((s) => s.deckRedo.length > 0);
  if (!canUndo && !canRedo) return null;
  return (
    <>
      <button
        type="button"
        title="Undo the last slide list change (⌘Z)"
        disabled={!canUndo}
        onClick={() => void useApp.getState().undoDeckEdit()}
        className={headerButton}
      >
        <Undo2 className="size-4" />
      </button>
      <button
        type="button"
        title="Redo the slide list change (⇧⌘Z)"
        disabled={!canRedo}
        onClick={() => void useApp.getState().redoDeckEdit()}
        className={headerButton}
      >
        <Redo2 className="size-4" />
      </button>
    </>
  );
}

/** What can be done to the slides picked with ⇧/⌘-click. Locked ones are not deleted or hidden. */
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
      <button
        type="button"
        title="Move up (⌘↑)"
        disabled={searching}
        onClick={() => void app.moveSlides(-1)}
        className={headerButton}
      >
        <ArrowUp className="size-3.5" />
      </button>
      <button
        type="button"
        title="Move down (⌘↓)"
        disabled={searching}
        onClick={() => void app.moveSlides(1)}
        className={headerButton}
      >
        <ArrowDown className="size-3.5" />
      </button>
      <button
        type="button"
        title={`${show ? "Show" : "Hide"} slides${skips}`}
        disabled={free.length === 0}
        onClick={() => void app.setSlidesHidden(ids, !show)}
        className={headerButton}
      >
        {show ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </button>
      <button
        type="button"
        title="Duplicate slides"
        onClick={() => void app.duplicateSlides(picked)}
        className={headerButton}
      >
        <Copy className="size-3.5" />
      </button>
      <button
        type="button"
        title={`Delete slides${skips}`}
        disabled={free.length === 0}
        onClick={() => void app.deleteSlides(ids)}
        className={headerButton}
      >
        <Trash2 className="size-3.5" />
      </button>
      <button type="button" title="Clear selection" onClick={app.clearRailSelection} className={headerButton}>
        <X className="size-3.5" />
      </button>
    </div>
  );
}

const IFRAME_HOLD_ID = "slide-drag-iframe-hold";

/**
 * A pointer over an iframe (the stage's slide) sends its events to the iframe's document, so a
 * drag that crossed it lost the moves and the release and stayed stuck. Keep iframes out of the
 * way while a slide is dragged.
 */
function holdIframes() {
  if (document.getElementById(IFRAME_HOLD_ID)) return;
  const style = document.createElement("style");
  style.id = IFRAME_HOLD_ID;
  style.textContent = "iframe { pointer-events: none !important; }";
  document.head.appendChild(style);
}

function releaseIframes() {
  document.getElementById(IFRAME_HOLD_ID)?.remove();
}

type SectionMove = { key: string; top: number; slideHeight: number };

const FOLD = { duration: 240, easing: "cubic-bezier(0.4, 0, 0.2, 1)" };
const noLayoutAnimation = () => false;

/** Shrinks the slides' rows to nothing, or grows them back. The -mt-3 takes back the list's gap. */
function foldSlides(rows: HTMLElement, height: number, opening: boolean) {
  const open = { height: `${height}px`, marginTop: "0px", opacity: 1, overflow: "hidden" };
  const shut = { height: "0px", marginTop: "-12px", opacity: 0, overflow: "hidden" };
  for (const slide of rows.querySelectorAll("[data-rail-slide]"))
    slide.animate(opening ? [shut, open] : [open, shut], FOLD);
  if (opening) return;
  for (const label of rows.querySelectorAll("[data-fold-label]")) label.animate([{ opacity: 0 }, { opacity: 1 }], FOLD);
}

/** Scrolls or pads the rail so the row `key` sits at `top` in the window. */
function placeRow(rows: HTMLElement, key: string, top: number) {
  const scroller = rows.parentElement;
  const at = rowTop(rows, key);
  if (!scroller || at == null) return;
  const padded = Number.parseFloat(rows.style.paddingTop || "0");
  const scroll = scroller.scrollTop - padded + at - top;
  const content = rows.offsetHeight - padded - Number.parseFloat(rows.style.paddingBottom || "0");
  rows.style.paddingTop = `${Math.max(-scroll, 0)}px`;
  rows.style.paddingBottom = `${Math.max(scroll + scroller.clientHeight - content, 0)}px`;
  scroller.scrollTop = Math.max(scroll, 0);
}

/** Where the row of a section put down ends up once the slides are open and nothing is padded. */
function openTop(rows: HTMLElement, { key, top }: SectionMove) {
  const scroller = rows.parentElement;
  rows.style.paddingTop = "";
  rows.style.paddingBottom = "";
  const at = rowTop(rows, key);
  if (!scroller || at == null) return top;
  const row = at + scroller.scrollTop;
  return row - Math.min(Math.max(row - top, 0), scroller.scrollHeight - scroller.clientHeight);
}

/** Keeps the row `key` in place, on its way `from` one height `to` another, while the slides fold. */
function holdRow(rows: HTMLElement, key: string, from: number, to: number, done?: () => void) {
  const start = performance.now();
  let frame = 0;
  const step = () => {
    const t = Math.min((performance.now() - start) / FOLD.duration, 1);
    placeRow(rows, key, from + (to - from) * t * t * (3 - 2 * t));
    if (t < 1) frame = requestAnimationFrame(step);
    else done?.();
  };
  step();
  return () => cancelAnimationFrame(frame);
}

/** Where the section row `key` sits in the window, whatever a drag is doing to it. */
function rowTop(list: HTMLElement | null, key: string) {
  const row = list?.querySelector(`[data-section-key="${key}"]`);
  return row ? getClientRect(row, { ignoreTransform: true }).top : null;
}

function sectionTitle(items: RailItem[], key: string) {
  const row = items.find((item) => item.key === key);
  return (row?.kind === "section" && row.section.title) || "Untitled section";
}

const slideCount = (count: number) => `${count} ${count === 1 ? "slide" : "slides"}`;

/** Stands in for the slides before the first section, which stay put while sections move. */
function LooseSlides({ count }: { count: number }) {
  return (
    <li
      data-testid="loose-slides"
      data-fold-label
      className="flex items-center gap-2 pt-1 text-2xs text-muted-foreground"
    >
      <span className="w-4 shrink-0" />
      {slideCount(count)}
    </li>
  );
}

/** Divider row that names a section. Only the editor shows it; the player never does. */
function SectionHeader(props: {
  itemKey: string;
  deckId: string;
  section: Section;
  filteredOut: boolean;
  /** How many slides are folded under the row while sections are being moved. */
  slides?: number;
  /** Keeps dnd-kit from sliding the row anywhere while the slides fold and open. */
  still: boolean;
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
    try {
      useApp.getState().setDeck(await api.renameSection(deckId, section.index, next));
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

  const remove = async () => {
    try {
      useApp.getState().setDeck(await api.deleteSection(deckId, section.index));
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

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
      <span className="w-4 shrink-0" />
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
          {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: double-click is a shortcut for the adjacent keyboard-accessible Rename section button. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard users rename with the adjacent Rename section button. */}
          <span
            title="Double-click to rename"
            onDoubleClick={() => onEditing(true)}
            className={cn(
              "min-w-0 truncate text-2xs font-medium uppercase tracking-wide text-muted-foreground",
              !section.title && "italic",
            )}
          >
            {section.title || "Untitled section"}
          </span>
          <span className="h-px flex-1 bg-border" />
          {props.slides !== undefined ? (
            <span data-fold-label className="shrink-0 pr-1 text-2xs text-muted-foreground">
              {slideCount(props.slides)}
            </span>
          ) : (
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

  const toggleLocked = async () => {
    try {
      useApp.getState().setDeck(await api.setSlideLocked(deckId, slide.id, !slide.locked));
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

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
          "w-4 shrink-0 pt-0.5 text-right text-2xs tabular-nums text-muted-foreground",
          selected && "font-semibold text-foreground",
          slide.hidden && "opacity-60",
        )}
      >
        {index + 1}
      </span>
      <div className="relative min-w-0 flex-1">
        <button
          type="button"
          title={slide.locked ? undefined : "Double-click to edit"}
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
            className={cn(slide.hidden && "opacity-35 grayscale")}
          />
        </button>
        {slide.hidden && <HiddenMark />}
        {slide.locked && (
          <span
            data-testid="locked-mark"
            title="Locked: neither you nor the agent can change it"
            className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/70 p-1 text-white"
          >
            <Lock className="size-3" aria-label="Locked slide" />
          </span>
        )}
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
      </div>
    </li>
  );
}

/** A closed eye over a hidden slide's thumbnail. */
function HiddenMark() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-foreground/80">
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
    </div>
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
      className="rounded bg-black/70 p-1 text-white hover:bg-black/80"
    >
      {props.children}
    </button>
  );
}
