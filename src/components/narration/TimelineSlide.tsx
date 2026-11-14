import { Pin } from "lucide-react";
import { type KeyboardEvent, memo, type PointerEvent, type Ref } from "react";

import type { Slide } from "../../lib/api";
import type { Pixels } from "../../lib/slideSize";
import { formatShown } from "../../lib/timeline";
import { cn } from "../../lib/utils";
import { SlideFrame, useSlideVersion } from "../SlideFrame";

/** What a slide on the track tells the timeline, by the slide's place among those shown. */
export interface SlideHandlers {
  goToSlide: (index: number) => void;
  pressEdge: (event: PointerEvent, index: number) => void;
  nudgeEdge: (event: KeyboardEvent, index: number) => void;
  /** Lets the slide at `index` follow its narration again, its length and narration start no longer set by hand. */
  followNarration: (index: number) => void;
  pointed: (event: PointerEvent) => void;
  release: () => void;
}

/**
 * Empty film, in frames `picture` pixels wide: what a strip is made of after its one picture. A
 * line of the border's color where each frame ends.
 */
function emptyFilm(picture: number): string | undefined {
  if (!(picture > 1)) return undefined;
  return `repeating-linear-gradient(to right, transparent 0 ${picture - 1}px, var(--border) ${picture - 1}px ${picture}px)`;
}

/**
 * A slide on its track, as a strip of film from `left` and `width` wide (as parts of the track),
 * with the handle at its end that changes how long it shows. The strip has the slide's picture
 * once, at its start, `picture` pixels wide, and empty frames of film after it for as long as it
 * shows: one page loaded for a slide, however long its strip. Not even that one unless `pictured`
 * (the strip has room for it, and it is in sight). `filmRef` is what holds the picture, as tall
 * as one.
 *
 * A slide whose length was set by hand has a pin by its seconds; double-clicking its handle (or
 * Delete on it) lets it follow its narration again.
 *
 * Rendered again only when something of its own changes: `on` stays the same, so neither the
 * playhead nor a scroll nor another slide's edge redraws it.
 */
export const TimelineSlide = memo(function TimelineSlide(props: {
  deck: string;
  size: Pixels;
  slide: Slide;
  /** Its place among the slides shown. */
  index: number;
  left: string;
  width: string;
  /** How long it shows, live while its edge is dragged. */
  seconds: number;
  selected: boolean;
  picture: number;
  pictured: boolean;
  /** Whether its length can change: in Edit, on a slide that is not locked. */
  resizable: boolean;
  /** Why not, for the handle's tooltip. */
  editable: boolean;
  /** The last slide's handle stays inside the track, which would scroll otherwise. */
  last: boolean;
  filmRef?: Ref<HTMLDivElement>;
  on: SlideHandlers;
}) {
  const { slide, index, on } = props;
  const number = index + 1;
  const pinned = slide.duration != null || slide.narrationStart != null;
  return (
    // A sliver apart, as cuts of film lie next to each other.
    <div className="absolute inset-y-1 px-px" style={{ left: props.left, width: props.width }}>
      <button
        type="button"
        aria-label={`Slide ${number}`}
        aria-current={props.selected ? "true" : undefined}
        title={`Slide ${number}, shown for ${formatShown(props.seconds)}${pinned ? ", timing set by hand" : ""}. Press to move the playhead to its start`}
        onClick={() => on.goToSlide(index)}
        className="relative block size-full overflow-hidden rounded-md bg-card text-left"
      >
        <div
          ref={props.filmRef}
          data-testid="filmstrip"
          className="pointer-events-none absolute inset-0 bg-muted"
          style={{ backgroundImage: emptyFilm(props.picture) }}
        >
          {props.pictured && (
            <div data-testid="film-picture" className="absolute inset-y-0 left-0" style={{ width: props.picture }}>
              <SlidePicture deck={props.deck} slide={slide} size={props.size} />
            </div>
          )}
        </div>
        <span className="absolute top-1 left-1 flex max-w-[calc(100%-0.5rem)] gap-1 overflow-hidden rounded-sm bg-overlay px-1 text-2xs tabular-nums text-overlay-foreground">
          {number}
          <span data-testid="slide-seconds" aria-hidden="true" className="opacity-70">
            {formatShown(props.seconds)}
          </span>
          {pinned && (
            <Pin
              data-testid="slide-pinned"
              aria-label="Timing set by hand"
              className="size-2.5 shrink-0 self-center opacity-80"
            />
          )}
        </span>
        {/* Over the picture, which would cover an outline of the button itself. */}
        <span
          className={cn(
            "pointer-events-none absolute inset-0 rounded-md ring-inset",
            props.selected ? "ring-2 ring-primary" : "ring-1 ring-border",
          )}
        />
      </button>
      <button
        type="button"
        aria-label={`End of slide ${number}`}
        title={
          !props.editable
            ? "Switch to Edit to change the timing"
            : pinned
              ? "Drag to change how long this slide shows (Alt: without snapping). Double-click or press Delete to let it follow its narration again."
              : "Drag to change how long this slide shows (Alt: without snapping)"
        }
        disabled={!props.resizable}
        onPointerDown={(event) => on.pressEdge(event, index)}
        onPointerMove={on.pointed}
        onPointerUp={on.release}
        onPointerCancel={on.release}
        onDoubleClick={() => pinned && on.followNarration(index)}
        onKeyDown={(event) => {
          if ((event.key === "Delete" || event.key === "Backspace") && pinned) {
            event.preventDefault();
            event.stopPropagation();
            return on.followNarration(index);
          }
          on.nudgeEdge(event, index);
        }}
        className={cn(
          "absolute inset-y-0 z-10 w-2 cursor-ew-resize rounded-md focus-visible:bg-primary enabled:hover:bg-primary/60 disabled:cursor-default",
          props.last ? "right-0" : "-right-1",
        )}
      />
    </div>
  );
});

function SlidePicture({ deck, slide, size }: { deck: string; slide: Slide; size: Pixels }) {
  const version = useSlideVersion(slide);
  return <SlideFrame deckId={deck} slideId={slide.id} version={version} size={size} thumbnail />;
}
