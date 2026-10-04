import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Copy, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";

import { api, errorMessage } from "../lib/api";
import { cn } from "../lib/utils";
import { useApp } from "../store";
import { SlideFrame } from "./SlideFrame";

export function SlideRail() {
  const deck = useApp((s) => s.deck);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  if (!deck) return null;

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = deck.slides.indexOf(String(active.id));
    const to = deck.slides.indexOf(String(over.id));
    const slides = arrayMove(deck.slides, from, to);
    useApp.getState().setDeck({ ...deck, slides });
    try {
      useApp.getState().setDeck(await api.reorderSlides(deck.id, slides));
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
      useApp.getState().setDeck(await api.loadDeck(deck.id));
    }
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

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Slides · {deck.slides.length}
        </span>
        <button
          type="button"
          onClick={addSlide}
          title="Add blank slide"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {deck.slides.length === 0 ? (
          <p className="px-1 pt-2 text-xs leading-relaxed text-muted-foreground">
            No slides yet. Describe your presentation in the chat, or add a blank slide.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={deck.slides} strategy={verticalListSortingStrategy}>
              <ol className="flex flex-col gap-3">
                {deck.slides.map((slide, index) => (
                  <Thumbnail key={slide} deckId={deck.id} slide={slide} index={index} />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}

function Thumbnail({ deckId, slide, index }: { deckId: string; slide: string; index: number }) {
  const selected = useApp((s) => s.selected === slide);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: slide,
  });
  const itemRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (selected) itemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  const duplicate = async () => {
    try {
      const created = await api.duplicateSlide(deckId, slide);
      useApp.getState().setDeck(created.deck);
      useApp.getState().select(created.slide);
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

  const remove = async () => {
    try {
      const before = useApp.getState().deck?.slides ?? [];
      const neighbor = before[index + 1] ?? before[index - 1] ?? null;
      const next = await api.deleteSlide(deckId, slide);
      if (selected) useApp.getState().select(neighbor);
      useApp.getState().setDeck(next);
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

  return (
    <li
      ref={(node) => {
        setNodeRef(node);
        itemRef.current = node;
      }}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("group flex gap-2", isDragging && "z-10 opacity-80")}
      {...attributes}
      {...listeners}
    >
      <span
        className={cn(
          "w-4 shrink-0 pt-0.5 text-right text-2xs tabular-nums text-muted-foreground",
          selected && "font-semibold text-foreground",
        )}
      >
        {index + 1}
      </span>
      <div className="relative min-w-0 flex-1">
        <button
          type="button"
          onClick={() => useApp.getState().select(slide)}
          className={cn(
            "block w-full overflow-hidden rounded-md ring-1 ring-border transition-shadow",
            selected ? "ring-2 ring-primary" : "hover:ring-input",
          )}
        >
          <SlideFrame deckId={deckId} slide={slide} thumbnail />
        </button>
        <div className="absolute right-1 top-1 hidden gap-0.5 group-hover:flex">
          <RailAction title="Duplicate" onClick={duplicate}>
            <Copy className="size-3" />
          </RailAction>
          <RailAction title="Delete" onClick={remove}>
            <Trash2 className="size-3" />
          </RailAction>
        </div>
      </div>
    </li>
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
      className="rounded bg-black/60 p-1 text-white backdrop-blur hover:bg-black/80"
    >
      {props.children}
    </button>
  );
}
