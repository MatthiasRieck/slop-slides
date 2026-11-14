import { Trash2, Undo2 } from "lucide-react";
import { useRef } from "react";

import { shownView, useChanges } from "../../changesStore";
import { useContentSize } from "../../hooks/useContentSize";
import type { Deck, DeckChanges, SlideChange } from "../../lib/api";
import { pixelsOf } from "../../lib/slideSize";
import { Button } from "../Button";
import { SlideComparison } from "../SlideComparison";
import {
  actionsOf,
  caption,
  comparable,
  contentMarkOf,
  MARKS,
  type Mark,
  type MarkActions,
  STYLES,
  stylesActions,
} from "./changeRows";
import { IncludeCheckbox } from "./marks";
import { TextChanges } from "./TextChanges";
import { holdToFlip } from "./useChangesKeys";
import { LiveSlide, SavedSlide } from "./versions";

/**
 * The picked slide as large as fits; under it what the list says about it, with what can be done
 * about its change beside that; and under those the words that changed.
 */
export function SlideArea({ deck, changes, row }: { deck: Deck; changes: DeckChanges; row: SlideChange }) {
  const area = useRef<HTMLDivElement>(null);
  const room = useContentSize(area);
  const compared = comparable(row, changes);
  const view = useChanges((s) => shownView(s.view, compared && s.flipped));
  const canvas = pixelsOf({ size: deck.size });
  const scale = room ? Math.max(0, Math.min(room.width / canvas.width, room.height / canvas.height)) : 0;
  const box = { width: canvas.width * scale, height: canvas.height * scale };
  const commit = changes.commit?.hash;
  const slide = deck.slides.find((s) => s.id === row.id);

  const before =
    row.oldId && commit ? (
      <SavedSlide
        deck={deck}
        slideId={row.oldId}
        commit={commit}
        size={pixelsOf({ size: changes.oldSize })}
        className="w-full"
      />
    ) : null;
  const after = slide ? <LiveSlide deck={deck} slide={slide} /> : null;
  // One version of a slide that has two, when asked for; else whichever there is.
  const single = compared && view === "before" ? before : compared && view === "after" ? after : (after ?? before);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      {changes.tracking === "committed" && changes.stylesChanged && (
        <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 px-3 pt-2 text-xs text-muted-foreground">
          <span>The shared styles changed.</span>
          <ChangeActions
            deck={deck.id}
            mark={STYLES}
            actions={stylesActions(changes.stylesStaged)}
            label="Shared styles"
          />
        </div>
      )}
      <div className="min-h-0 flex-1 p-6">
        <div ref={area} className="flex size-full items-center justify-center">
          {scale > 0 &&
            (compared && view === "split" ? (
              <SlideComparison box={box} before={before} after={after} />
            ) : (
              <div
                data-testid="single-version"
                data-version={compared ? view : undefined}
                className="relative flex items-center overflow-hidden bg-stage"
                style={box}
              >
                {single}
                {compared && (
                  // Over the slide, which takes no pointer itself: a press here shows the other version.
                  <div
                    data-testid="flip-surface"
                    title="Hold to see the other version"
                    className="absolute inset-0 cursor-pointer touch-none select-none"
                    {...holdToFlip()}
                  />
                )}
              </div>
            ))}
        </div>
      </div>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1.5 px-3 pb-2 text-xs text-muted-foreground">
        <p className="text-center">
          {compared && view !== "split" && (
            <span data-testid="version-name" className="mr-1.5 font-medium text-foreground">
              {view === "before" ? "Before." : "After."}
            </span>
          )}
          {caption(row, changes)}
        </p>
        {changes.tracking === "committed" && <RowActions deck={deck} row={row} />}
      </div>
      <TextChanges changes={row.textChanges} />
    </div>
  );
}

/** What can be done about the picked slide's change, and about its move, which is a change of its own. */
function RowActions({ deck, row }: { deck: Deck; row: SlideChange }) {
  const content = contentMarkOf(row);
  const slide = content ? actionsOf(row, content) : null;
  const move = row.moved ? actionsOf(row, MARKS.moved) : null;
  const locked = !!deck.slides.find((s) => s.id === row.id)?.locked;
  return (
    <>
      {content && slide && <ChangeActions deck={deck.id} mark={content} actions={slide} locked={locked} />}
      {move && <ChangeActions deck={deck.id} mark={MARKS.moved} actions={move} locked={locked} />}
    </>
  );
}

/**
 * What can be done with a change, said in full: pick it for the next version, and put it back as
 * the last version has it, named by what that does to it (see `restoreActionOf`) and red where
 * work goes with it. The discard says what it did in a message that offers to undo it.
 */
function ChangeActions(props: { deck: string; mark: Mark; actions: MarkActions; locked?: boolean; label?: string }) {
  const { deck, mark, actions, locked = false } = props;
  const undo = actions.restore;
  return (
    <fieldset aria-label={props.label ?? mark.label} className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
      <IncludeCheckbox deck={deck} actions={actions} text={actions.include} className="text-foreground" />
      <Button
        variant={undo.destructive ? "destructive" : "outline"}
        title={locked ? "This slide is locked; unlock it first" : undo.title}
        disabled={locked}
        onClick={() => void useChanges.getState().restore(deck, actions.change, undo.done)}
        className="bg-background"
      >
        {undo.destructive ? <Trash2 /> : <Undo2 />}
        {undo.label}
      </Button>
    </fieldset>
  );
}
