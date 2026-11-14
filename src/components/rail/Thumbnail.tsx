import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { useSettled } from "../../hooks/useSettled";
import type { Slide } from "../../lib/api";
import { scrollBehavior } from "../../lib/motion";
import { pixelsOf } from "../../lib/slideSize";
import { slideTitle } from "../../lib/slideTitle";
import { cn, plural } from "../../lib/utils";
import { useApp } from "../../store";
import type { AppState } from "../../store/types";
import { useSlideVersion } from "../SlideFrame";
import { SlideImage } from "../SlideImage";
import { SlideActions } from "./SlideActions";
import { SlideMarks } from "./SlideMarks";

/** How a slide in the rail eases into and out of being hidden. */
const MARK_TRANSITION = "transition duration-200";

export const noLayoutAnimation = () => false;

/**
 * How long a slide being edited stays as it is before its thumbnail follows. The editor saves
 * after every change; a thumbnail loading each of them would load documents nobody gets to see.
 */
export const EDITED_THUMBNAIL_DELAY = 400;

/** Marks a list of thumbnails (the slide list, the grid of all slides): the keys' focus stays within one. */
export const SLIDE_LIST_ATTR = "data-slide-list";

/**
 * On a list of thumbnails: while the pointer is on one row, no other row shows its quick actions,
 * so the row the keyboard's focus is in and the one under the pointer never both carry them.
 */
export const ONE_ROW_OF_ACTIONS = "[&:has(li:hover)_li:not(:hover)_[data-slide-actions]]:hidden!";

/**
 * What a slide is called besides its number: the name the deck file gives it, in plain words
 * (see `slideTitle`). None when that says nothing the number does not ("slide", "slide-4", "7").
 */
export function slideName(slide: Slide): string {
  const title = slideTitle(slide.id);
  return /^(slide\s*)?\d*$/i.test(title) ? "" : title;
}

/** What a screen reader says of a slide's row: "Slide 3, Market size, hidden, locked, 2 comments". */
export function slideLabel(index: number, slide: Slide, comments: number): string {
  return [
    `Slide ${index + 1}`,
    slideName(slide) || false,
    slide.hidden && "hidden",
    slide.locked && "locked",
    comments > 0 && plural(comments, "comment"),
    slide.notes?.trim() && "has speaker notes",
    slide.narration?.trim() && "has narration",
  ]
    .filter(Boolean)
    .join(", ");
}

/** The picture of a thumbnail: it renders only when the slide's version, its size or its look changes. */
const Picture = memo(SlideImage);

/**
 * What a double-click on a thumbnail does, said after the slide's name in its tooltip: always
 * the same words, or words that depend on the app's state (the mode, say), or none.
 */
export type ThumbnailHint = string | ((app: AppState) => string | undefined);

/** Whether two slides look the same in the list: the same values, whether or not the same object. */
function sameSlide(a: Slide, b: Slide): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as (keyof Slide)[];
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

/** A row renders for what it shows: a deck read again with its slides as they were renders none. */
function sameRow<P extends { slide: Slide }>(before: P, after: P): boolean {
  const keys = Object.keys(after) as (keyof P)[];
  return (
    keys.length === Object.keys(before).length &&
    keys.every((key) => (key === "slide" ? sameSlide(before.slide, after.slide) : Object.is(before[key], after[key])))
  );
}

/**
 * Keeps the tooltip of `button` saying the slide's `name` and the `hint`, following the app's
 * state when the hint depends on it. It is set on the button as that changes: a hint that
 * changes with the mode would otherwise render every row of the list as the mode changes.
 */
function useTooltip(button: React.RefObject<HTMLButtonElement | null>, name: string, hint: ThumbnailHint | undefined) {
  useLayoutEffect(() => {
    const hintOf = (app: AppState) => (typeof hint === "function" ? hint(app) : hint);
    const show = (said: string | undefined) => {
      const title = said ? `${name} · ${said}` : name;
      if (button.current && button.current.title !== title) button.current.title = title;
    };
    let said = hintOf(useApp.getState());
    show(said);
    if (typeof hint !== "function") return;
    return useApp.subscribe((app) => {
      const now = hintOf(app);
      if (now === said) return;
      said = now;
      show(said);
    });
  }, [button, name, hint]);
}

/**
 * One slide of the slide list or of the grid of all slides: its number and its thumbnail, a single
 * button (one tab stop) that picks the slide, is what a drag or the keyboard (Space, then the
 * arrows) moves it by, and takes the right-click for the slide's menu. Under the number, what there
 * is to know about the slide (see ./SlideMarks.tsx), so nothing lies on the picture; over its
 * corner, the quick actions (./SlideActions.tsx), which show under the pointer and with the
 * keyboard's focus in the row.
 *
 * Memoized, and given nothing that changes with the other rows: picking another slide or saving
 * one renders the rows concerned, not the whole list, and switching modes or reading the deck
 * again renders none (see `sameRow`, `useTooltip`). What a row holds renders only for itself:
 * its picture for a new version, its quick actions for the picks.
 */
export const Thumbnail = memo(function Thumbnail(props: {
  deckId: string;
  slide: Slide;
  index: number;
  filteredOut: boolean;
  /** A search is on and found nothing on the slide: it stays in its place, faded. */
  dimmed?: boolean;
  folded: boolean;
  still: boolean;
  /** Another of the picked slides is being dragged, and this one goes along. */
  draggedAlong: boolean;
  /** How many matches of the search the slide has; undefined while none is on. */
  matches?: number;
  /** What a double-click does, said after the slide's name in the tooltip: "double-click to edit". */
  hint?: ThumbnailHint;
  /** Enter opens the slide as a double-click does, rather than only picking it. */
  opensOnEnter?: boolean;
  /** Where the slide being dragged would land: before this one, or after it. Only the grid marks it. */
  dropMark?: "before" | "after";
  /** A right-click on the slide, or a press on its "More actions"; the same function for every row. */
  onMenu: (event: React.MouseEvent, slide: string) => void;
  /** A double-click on the slide; the same function for every row. */
  onOpen: (slide: string) => void;
}) {
  const { deckId, slide, index, filteredOut, folded, onMenu, onOpen } = props;
  const selected = useApp((s) => s.selected === slide.id);
  const picked = useApp((s) => s.railSelected.includes(slide.id));
  const comments = useApp((s) => s.comments[slide.id]?.length ?? 0);
  // The editor's own saves come in bursts; anything else (the agent, an undo) shows at once.
  const ownSave = useApp((s) => s.editing && s.editSaved[slide.id] === slide.hash);
  const version = useSettled(useSlideVersion(slide), ownSave ? EDITED_THUMBNAIL_DELAY : 0);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: slide.id,
    animateLayoutChanges: props.still ? noLayoutAnimation : undefined,
  });
  const itemRef = useRef<HTMLLIElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!selected) return;
    itemRef.current?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
    // The keys went to another slide with the focus on a thumbnail of this list: the focus goes along.
    const focused = document.activeElement;
    const list = buttonRef.current?.closest(`[${SLIDE_LIST_ATTR}]`);
    if (
      focused !== buttonRef.current &&
      focused?.matches("button[data-thumbnail]") &&
      focused.closest(`[${SLIDE_LIST_ATTR}]`) === list
    ) {
      buttonRef.current?.focus({ preventScroll: true });
    }
  }, [selected]);

  const deckSize = useApp((s) => s.deck?.size);
  const size = useMemo(() => pixelsOf({ size: deckSize }), [deckSize]);
  const app = useApp.getState;

  const onClick = (event: React.MouseEvent) => {
    if (event.shiftKey) app().extendRailSelection(slide.id, "range");
    else if (event.metaKey || event.ctrlKey) app().extendRailSelection(slide.id, "toggle");
    else app().select(slide.id);
  };

  // dnd-kit names the row a button and says whether it can be dragged; the thumbnail is a real
  // button, pressed while its slide is picked, and works whether or not it can be dragged.
  const { role: _role, "aria-pressed": _pressed, "aria-disabled": undraggable, ...sortable } = attributes;
  const name = [`Slide ${index + 1}`, slideName(slide)].filter(Boolean).join(" · ");
  useTooltip(buttonRef, name, props.hint);

  return (
    <li
      ref={(node) => {
        setNodeRef(node);
        itemRef.current = node;
      }}
      data-rail-slide
      data-slide={slide.id}
      data-draggable={!undraggable}
      data-drop={props.dropMark}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        filteredOut ? "hidden" : "group/slide relative flex gap-2",
        folded && "pointer-events-none -mt-3 h-0 overflow-hidden opacity-0",
        isDragging && "z-10 opacity-80",
        props.draggedAlong && "opacity-40",
        props.dimmed && !props.draggedAlong && "opacity-40",
        // Where the dragged slides would land, as a line in the gap beside this one.
        props.dropMark && "after:absolute after:inset-y-0 after:w-0.5 after:rounded-full after:bg-primary",
        props.dropMark === "before" && "after:-left-2",
        props.dropMark === "after" && "after:-right-2",
      )}
    >
      <div className="flex w-4 shrink-0 flex-col items-end gap-1 pt-0.5">
        <span
          aria-hidden
          className={cn(
            "text-right text-2xs tabular-nums text-muted-foreground transition-opacity duration-200",
            selected && "font-semibold text-foreground",
            slide.hidden && "opacity-60",
          )}
        >
          {index + 1}
        </span>
        <SlideMarks slide={slide} comments={comments} matches={props.matches} />
      </div>
      <div className="@container relative min-w-0 flex-1">
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
          onClick={onClick}
          onDoubleClick={() => onOpen(slide.id)}
          onKeyDown={(event) => {
            // Space picks the row up to move it (see dnd-kit's keyboard sensor); Enter is the slide's.
            if (props.opensOnEnter && event.key === "Enter" && !event.defaultPrevented) {
              event.preventDefault();
              onOpen(slide.id);
            } else listeners?.onKeyDown?.(event);
          }}
          onContextMenu={(event) => onMenu(event, slide.id)}
          className={cn(
            // No transition on the ring: it would repaint the slide under it for its whole length.
            "block w-full overflow-hidden rounded-md shadow-thumbnail",
            "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring",
            // The offset gap keeps the ring visible against dark slides.
            selected
              ? "ring-2 ring-primary ring-offset-2 ring-offset-sidebar"
              : picked
                ? "ring-2 ring-primary/50 ring-offset-2 ring-offset-sidebar"
                : "hover:ring-1 hover:ring-input",
          )}
        >
          <Picture
            deckId={deckId}
            slideId={slide.id}
            version={version}
            size={size}
            lazy
            className={cn(MARK_TRANSITION, slide.hidden && "opacity-35 grayscale")}
          />
        </button>
        <SlideActions slide={slide} onMenu={onMenu} />
      </div>
    </li>
  );
}, sameRow);
