import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Copy, Eye, EyeOff, Lock, LockOpen, MessageSquare, Search, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";

import type { Slide } from "../../lib/api";
import { scrollBehavior } from "../../lib/motion";
import { pixelsOf } from "../../lib/slideSize";
import { cn, plural } from "../../lib/utils";
import { useApp } from "../../store";
import { SlideFrame, useSlideVersion } from "../SlideFrame";

/** How a slide in the rail eases into and out of being hidden or locked. */
const MARK_TRANSITION = "transition duration-200";

export const noLayoutAnimation = () => false;

/** What a screen reader says of a slide's row: "Slide 3, hidden, locked, 2 comments". */
export function slideLabel(index: number, slide: Slide, comments: number): string {
  return [
    `Slide ${index + 1}`,
    slide.hidden && "hidden",
    slide.locked && "locked",
    comments > 0 && plural(comments, "comment"),
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * One slide of the rail: its number and its thumbnail, a single button (one tab stop) that picks
 * the slide, is what a drag or the keyboard (Space, then the arrows) moves it by, and takes the
 * right-click for the slide's menu. Over it, what there is to know about the slide (hidden, locked,
 * how many comments, how many matches of the search) and, in Edit, its quick actions, which show
 * under the pointer and while the focus is in the row.
 */
export function Thumbnail(props: {
  deckId: string;
  slide: Slide;
  index: number;
  /** Edit mode: the slide can be locked, hidden, duplicated and deleted from here. */
  editable: boolean;
  filteredOut: boolean;
  folded: boolean;
  still: boolean;
  /** Another of the picked slides is being dragged, and this one goes along. */
  draggedAlong: boolean;
  /** How many matches of the search the slide has; undefined while none is on. */
  matches?: number;
  onMenu: (event: React.MouseEvent) => void;
}) {
  const { deckId, slide, index, filteredOut, folded } = props;
  const selected = useApp((s) => s.selected === slide.id);
  const picked = useApp((s) => s.railSelected.includes(slide.id));
  const comments = useApp((s) => s.comments[slide.id]?.length ?? 0);
  const version = useSlideVersion(slide);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: slide.id,
    animateLayoutChanges: props.still ? noLayoutAnimation : undefined,
  });
  const itemRef = useRef<HTMLLIElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!selected) return;
    itemRef.current?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
    // The keys went to another slide with the focus on a thumbnail: the focus goes along.
    const focused = document.activeElement;
    if (focused !== buttonRef.current && focused?.matches("button[data-thumbnail]")) {
      buttonRef.current?.focus({ preventScroll: true });
    }
  }, [selected]);

  const deckSize = useApp((s) => s.deck?.size);
  const app = useApp.getState;

  const onClick = (event: React.MouseEvent) => {
    if (event.shiftKey) app().extendRailSelection(slide.id, "range");
    else if (event.metaKey || event.ctrlKey) app().extendRailSelection(slide.id, "toggle");
    else app().select(slide.id);
  };

  const onDoubleClick = () => {
    app().select(slide.id);
    app().setMode("edit");
  };

  // dnd-kit names the row a button and says whether it can be dragged; the thumbnail is a real
  // button, pressed while its slide is picked, and works whether or not it can be dragged.
  const { role: _role, "aria-pressed": _pressed, "aria-disabled": undraggable, ...sortable } = attributes;

  return (
    <li
      ref={(node) => {
        setNodeRef(node);
        itemRef.current = node;
      }}
      data-rail-slide
      data-draggable={!undraggable}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        filteredOut ? "hidden" : "group flex gap-2",
        folded && "pointer-events-none -mt-3 h-0 overflow-hidden opacity-0",
        isDragging && "z-10 opacity-80",
        props.draggedAlong && "opacity-40",
      )}
    >
      <span
        aria-hidden
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
          {...sortable}
          {...listeners}
          ref={(node) => {
            setActivatorNodeRef(node);
            buttonRef.current = node;
          }}
          type="button"
          data-thumbnail
          aria-label={slideLabel(index, slide, comments)}
          aria-current={selected ? "true" : undefined}
          aria-pressed={picked || selected}
          title={props.editable ? `Slide ${index + 1}` : `Slide ${index + 1} · double-click to edit`}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onContextMenu={props.onMenu}
          className={cn(
            "block w-full overflow-hidden rounded-md shadow-thumbnail transition-shadow",
            "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring",
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
        <div className="pointer-events-none absolute bottom-1 right-1 flex gap-1">
          {props.matches !== undefined && props.matches > 0 && (
            <Badge testId="match-count" title={`${plural(props.matches, "match", "matches")} of the search`}>
              <Search className="size-2.5" />
              {props.matches}
            </Badge>
          )}
          {comments > 0 && (
            <Badge testId="comment-count" title={plural(comments, "comment")}>
              <MessageSquare className="size-2.5" />
              {comments}
            </Badge>
          )}
        </div>
        {props.editable && (
          <div className="absolute right-1 top-1 hidden gap-0.5 group-focus-within:flex group-hover:flex">
            <RailAction
              title={slide.locked ? "Unlock slide" : "Lock slide"}
              onClick={() => void app().setSlidesLocked([slide.id], !slide.locked)}
            >
              {slide.locked ? <LockOpen className="size-3" /> : <Lock className="size-3" />}
            </RailAction>
            <RailAction
              title={slide.hidden ? "Show slide" : "Hide slide"}
              onClick={() => void app().setSlidesHidden([slide.id], !slide.hidden)}
            >
              {slide.hidden ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
            </RailAction>
            <RailAction title="Duplicate" onClick={() => void app().duplicateSlides([slide.id])}>
              <Copy className="size-3" />
            </RailAction>
            {!slide.locked && (
              <RailAction title="Delete" onClick={() => void app().deleteSlides([slide.id])}>
                <Trash2 className="size-3" />
              </RailAction>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** A small count over a thumbnail's corner, with an icon saying of what. */
function Badge(props: { testId: string; title: string; children: React.ReactNode }) {
  return (
    <span
      data-testid={props.testId}
      title={props.title}
      className="pointer-events-auto flex items-center gap-0.5 rounded bg-overlay px-1 py-0.5 text-[10px] font-medium leading-none tabular-nums text-overlay-foreground"
    >
      {props.children}
    </span>
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
      aria-label={props.title}
      title={props.title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      className="rounded bg-overlay p-1 text-overlay-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring"
    >
      {props.children}
    </button>
  );
}
