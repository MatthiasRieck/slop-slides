import { useEffect, useRef } from "react";

import { useChanges } from "../../changesStore";
import type { Deck, DeckChanges, SlideChange } from "../../lib/api";
import { scrollBehavior } from "../../lib/motion";
import { pixelsOf } from "../../lib/slideSize";
import { cn } from "../../lib/utils";
import {
  actionsOf,
  contentMarkOf,
  describeRow,
  MARKS,
  type MarkActions,
  marksOf,
  STYLES,
  stylesActions,
} from "./changeRows";
import { IncludeCheckbox, MarkBadge } from "./marks";
import { LiveThumbnail, SavedSlide } from "./versions";

/**
 * A slide in the list: its picture, marked in a corner by what changed, with a checkbox in the
 * other that picks the change for the next version. What else can be done with it (discarding
 * it, say) is beside the large slide, once the row is picked. `canInclude` is off for a deck
 * with no version yet, whose slides are all just new: they show plain.
 */
export function ChangeRow(props: {
  deck: Deck;
  row: SlideChange;
  number?: number;
  commit?: string;
  canInclude: boolean;
}) {
  const { deck, row, number, commit, canInclude } = props;
  const picked = useChanges((s) => s.picked === row.key);
  const slide = deck.slides.find((s) => s.id === row.id);
  const marks = canInclude ? marksOf(row) : [];
  const content = canInclude ? contentMarkOf(row) : null;
  const actions = content ? actionsOf(row, content) : null;
  const move = canInclude && row.moved ? actionsOf(row, MARKS.moved) : null;
  const name = number ? `slide ${number}` : "the removed slide";
  const itemRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (picked) itemRef.current?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  }, [picked]);

  return (
    <li ref={itemRef} data-testid="change-row" data-status={row.status} data-moved={row.moved} className="flex gap-2">
      <span className="w-4 shrink-0 pt-0.5 text-right text-2xs tabular-nums text-muted-foreground">
        {number ?? "–"}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="relative">
          <button
            type="button"
            aria-pressed={picked}
            aria-label={[number ? `Slide ${number}` : "Slide", canInclude && describeRow(row)]
              .filter(Boolean)
              .join(", ")}
            onClick={() => useChanges.getState().pick(row.key)}
            className={cn(
              // No transition on the ring: it would repaint the slide under it for its whole length.
              "block w-full overflow-hidden rounded-md shadow-thumbnail",
              picked
                ? "ring-2 ring-primary ring-offset-2 ring-offset-sidebar"
                : marks[0]
                  ? `ring-2 ${marks[0].ring}`
                  : "hover:ring-1 hover:ring-input",
            )}
          >
            {slide ? (
              <LiveThumbnail deck={deck} slide={slide} faded={canInclude && row.status === "unchanged"} />
            ) : row.oldId && commit ? (
              <SavedSlide
                deck={deck}
                slideId={row.oldId}
                commit={commit}
                size={pixelsOf({ size: deck.size })}
                lazy
                className="opacity-60 grayscale"
              />
            ) : null}
          </button>
          {/* In the corners, so the picture of the slide stays in view. */}
          {content && <MarkBadge mark={content} className="pointer-events-none absolute right-1 top-1" />}
          {actions && (
            <IncludeCheckbox
              deck={deck.id}
              actions={{ ...actions, include: `Include ${name} in this version` }}
              className="absolute left-1 top-1 rounded bg-background/90 p-1 shadow-md"
            />
          )}
        </div>
        {canInclude && row.moved && <MoveRow row={row} number={number} deck={deck.id} actions={move} />}
      </div>
    </li>
  );
}

/** The field under a slide that moved: its own change, picked for a version apart from the slide's. */
function MoveRow(props: { row: SlideChange; number?: number; deck: string; actions: MarkActions | null }) {
  const { row, number, deck, actions } = props;
  const from = row.oldNumber === null || number === undefined ? "Moved" : `${row.oldNumber} → ${number}`;
  const title = row.oldNumber === null ? "Moved" : `Moved from slide ${row.oldNumber} to slide ${number ?? "?"}`;
  return (
    <div
      data-testid="move-row"
      className="flex items-center gap-1.5 rounded-md border border-dashed border-info px-1.5 py-1 text-xs text-muted-foreground"
    >
      {actions && (
        <IncludeCheckbox
          deck={deck}
          actions={{ ...actions, include: `Include the move of slide ${number ?? "?"} in this version` }}
        />
      )}
      <span className="flex min-w-0 items-center gap-1" title={title}>
        <MarkBadge mark={MARKS.moved} small />
        <span className="truncate tabular-nums">{from}</span>
      </span>
    </div>
  );
}

/** The row above the slides for what they share, once that changed: a styles mark and its checkbox. */
export function StylesRow({ deck, changes }: { deck: string; changes: DeckChanges }) {
  return (
    <li data-testid="styles-row" className="flex gap-2">
      <span className="w-4 shrink-0" />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-dashed px-1.5 py-1.5 text-xs text-muted-foreground">
        <IncludeCheckbox deck={deck} actions={stylesActions(changes.stylesStaged)} />
        <MarkBadge mark={STYLES} small />
        <span className="truncate" title="The styles, fonts and scripts every slide shares">
          Shared styles
        </span>
      </div>
    </li>
  );
}
