import { useEffect, useRef } from "react";

import type { Deck, Slide } from "../../lib/api";
import { pixelsOf } from "../../lib/slideSize";
import { cn } from "../../lib/utils";
import { Dialog } from "../Dialog";
import { slideName } from "../rail/Thumbnail";
import { SlideFrame, useSlideVersion } from "../SlideFrame";

/** The keys that close the overview: Escape, and G again. */
const CLOSE_KEYS = ["Escape", "g", "G"];

/** How many slides a row of the overview holds, for moving up and down it with the arrows. */
const COLUMNS = 4;

/** How far each arrow key moves the focus, in slides. */
const ARROWS: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS };

/**
 * All the slides the show shows, as small pictures in rows, to go to one at once: G or the
 * slide's number in the show's bar opens it (in the presenter view's own window when there is
 * one, so the audience sees nothing of it). The slide on screen is ringed and has the focus; the
 * arrows move it, Enter or a press goes to the slide, Escape or G closes it. Each slide carries
 * the number the slide list gives it, and the first of a section the section's name.
 *
 * It opens over a show that goes on: a picture's page is made only once it is in sight or near
 * it, a few at a time (see `SlideFrame`'s `lazy`), so a long deck does not load all its slides
 * at once in front of the audience.
 */
export function ShowOverview(props: {
  deck: Deck;
  /** The slide on screen. */
  current: string | null;
  onPick: (slide: string) => void;
  onClose: () => void;
}) {
  const { deck } = props;
  const current = useRef<HTMLButtonElement>(null);
  const grid = useRef<HTMLUListElement>(null);
  const shown = deck.slides.filter((s) => !s.hidden);
  const pick = (slide: string) => {
    props.onClose();
    props.onPick(slide);
  };
  // The arrows move the focus from slide to slide, a row up or down with the up and down arrows.
  useEffect(() => {
    const list = grid.current;
    if (!list) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const by = ARROWS[event.key];
      if (!by) return;
      event.preventDefault();
      const buttons = [...list.querySelectorAll("button")];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[Math.min(buttons.length - 1, Math.max(0, at + by))]?.focus();
    };
    list.addEventListener("keydown", onKeyDown);
    return () => list.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <Dialog
      label="All slides"
      onClose={props.onClose}
      initialFocus={current}
      closeKeys={CLOSE_KEYS}
      closeOnBackdrop
      closeButton
      heading={<h2 className="text-sm font-medium">All slides</h2>}
      className="dark flex max-h-[calc(100vh-4rem)] w-[56rem] max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-xl border border-foreground/10 bg-background p-4 text-foreground shadow-lg outline-none"
    >
      <ul ref={grid} className="grid min-h-0 grid-cols-4 gap-3 overflow-y-auto p-1">
        {shown.map((slide) => {
          const index = deck.slides.indexOf(slide);
          return (
            <OverviewSlide
              key={slide.id}
              ref={slide.id === props.current ? current : undefined}
              deck={deck}
              slide={slide}
              number={index + 1}
              section={sectionStartingAt(deck, index)}
              sectioned={deck.sections.length > 0}
              current={slide.id === props.current}
              onPick={() => pick(slide.id)}
            />
          );
        })}
      </ul>
    </Dialog>
  );
}

/** The name of the section that starts at slide `index` of `deck`, if one does. */
export function sectionStartingAt(deck: Deck, index: number): string | null {
  const section = deck.sections.findLast((s) => s.before === index);
  return section?.title || null;
}

function OverviewSlide(props: {
  ref?: React.Ref<HTMLButtonElement>;
  deck: Deck;
  slide: Slide;
  number: number;
  section: string | null;
  /** Whether the deck has sections: each slide then keeps a line for a section's name. */
  sectioned: boolean;
  current: boolean;
  onPick: () => void;
}) {
  const { deck, slide } = props;
  const version = useSlideVersion(slide);
  const name = slideName(slide);
  const title = name || `Slide ${props.number}`;
  return (
    <li className="flex min-w-0 flex-col gap-1">
      {props.sectioned && (
        <span className="h-4 truncate text-2xs font-medium uppercase tracking-wide text-foreground/50">
          {props.section}
        </span>
      )}
      <button
        ref={props.ref}
        type="button"
        aria-label={`${props.number}. ${title}`}
        aria-current={props.current ? "true" : undefined}
        onClick={props.onPick}
        className={cn(
          "relative overflow-hidden rounded-lg ring-offset-2 ring-offset-background outline-none hover:ring-2 hover:ring-foreground/40 focus-visible:ring-2 focus-visible:ring-foreground",
          props.current && "ring-2 ring-primary",
        )}
      >
        <SlideFrame
          deckId={deck.id}
          slideId={slide.id}
          version={version}
          size={pixelsOf({ size: deck.size })}
          thumbnail
          lazy
          className="pointer-events-none"
        />
      </button>
      <span className="flex min-w-0 gap-1.5 text-xs text-foreground/70">
        <span className="tabular-nums">{props.number}</span>
        {name && <span className="truncate">{name}</span>}
      </span>
    </li>
  );
}
