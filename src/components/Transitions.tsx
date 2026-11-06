import { ArrowRightLeft, Ban, Blend, Columns2, type LucideIcon, ZoomIn } from "lucide-react";
import { useRef, useState } from "react";

import type { Slide, SlideTransition } from "../lib/api";
import { cn } from "../lib/utils";
import { useApp } from "../store";
import { Popover } from "./Popover";

/** The transitions the player knows (src-tauri/assets/runtime.css), in the order they are offered. */
type TransitionInfo = { id: SlideTransition; label: string; description: string; icon: LucideIcon };

const FADE: TransitionInfo = { id: "fade", label: "Fade", description: "Cross-fades to the next slide", icon: Blend };

export const TRANSITIONS: TransitionInfo[] = [
  { id: "none", label: "None", description: "Switches at once", icon: Ban },
  FADE,
  { id: "slide", label: "Slide", description: "Pushes the slide out to the side", icon: ArrowRightLeft },
  { id: "zoom", label: "Zoom", description: "Grows the next slide in as this one fades", icon: ZoomIn },
  { id: "wipe", label: "Wipe", description: "Uncovers the next slide from one side", icon: Columns2 },
];

export const DEFAULT_TRANSITION: SlideTransition = "fade";

export const transitionInfo = (id: SlideTransition) => TRANSITIONS.find((t) => t.id === id) ?? FADE;

/** Buttons for each transition, the one in use pressed; with `inherit`, a first one for the deck's. */
function TransitionOptions(props: {
  value: SlideTransition | null;
  onPick: (transition: SlideTransition | null) => void;
  /** The deck's transition, offered first for a slide that should follow it. */
  inherit?: SlideTransition;
  disabled?: boolean;
  columns: string;
}) {
  const options: { id: SlideTransition | null; label: string; title: string; icon: LucideIcon }[] = TRANSITIONS.map(
    (t) => ({ id: t.id, label: t.label, title: t.description, icon: t.icon }),
  );
  if (props.inherit) {
    const deck = transitionInfo(props.inherit);
    options.unshift({ id: null, label: `Deck (${deck.label})`, title: "The deck's transition", icon: deck.icon });
  }
  return (
    <div className={cn("grid gap-1", props.columns)}>
      {options.map(({ id, label, title, icon: Icon }) => (
        <button
          key={id ?? "deck"}
          type="button"
          title={title}
          aria-pressed={props.value === id}
          disabled={props.disabled}
          onClick={() => props.onPick(id)}
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50",
            props.value === id && "border-primary text-foreground",
          )}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      ))}
    </div>
  );
}

/** The deck's slide transition, in Settings mode: what every slide without its own uses. */
export function DeckTransitionSettings() {
  const current = useApp((s) => s.deck?.transition) ?? DEFAULT_TRANSITION;
  const own = useApp((s) => s.deck?.slides.filter((slide) => slide.transition).length ?? 0);
  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div>
        <div className="font-medium">Slide transition</div>
        <p className="text-2xs text-muted-foreground">
          How the show moves from one slide to the next. To change it between two slides, use the round button between
          their thumbnails in the slide list.
        </p>
      </div>
      <TransitionOptions
        value={current}
        columns="grid-cols-5"
        onPick={(transition) => transition && void useApp.getState().setDeckTransition(transition)}
      />
      {own > 0 && (
        <p data-testid="own-transitions" className="text-2xs text-muted-foreground">
          {own === 1 ? "1 slide has its own transition." : `${own} slides have their own transition.`}
        </p>
      )}
    </div>
  );
}

/**
 * The round button between a slide's thumbnail and the one before it: how the show moves on to
 * `slide` (and back). It shows on hover, or always when the slide has a transition of its own.
 */
export function TransitionPicker(props: { slide: Slide; number: number; deckTransition: SlideTransition }) {
  const { slide, number, deckTransition } = props;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const own = slide.transition ?? null;
  const shown = transitionInfo(own ?? deckTransition);
  const Icon = shown.icon;
  const name = `Transition to slide ${number}: ${shown.label}${own ? "" : " (deck)"}`;
  return (
    // The gap above the thumbnail; pressing here must not start dragging the slide.
    <div
      data-testid="transition-gap"
      className="group/transition absolute inset-x-0 -top-3 z-10 h-3"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        ref={button}
        type="button"
        title={slide.locked ? `${name}. Unlock the slide to change it.` : name}
        aria-label={name}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={cn(
          "absolute left-1/2 top-full flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-background shadow-sm transition-opacity hover:text-foreground focus-visible:opacity-100",
          own ? "border-primary/60 text-primary" : "text-muted-foreground",
          own || open ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-hover/transition:opacity-100",
        )}
      >
        <Icon className="size-3" />
      </button>
      {open && (
        <Popover anchor={button} width={260} portal label="Slide transition" onClose={() => setOpen(false)}>
          {/* The rail lets a press anywhere in a slide's row drag the slide; React passes portal events up to it. */}
          <div className="flex flex-col gap-2 p-3 text-xs" onPointerDown={(e) => e.stopPropagation()}>
            <div>
              <div className="font-medium">Transition to slide {number}</div>
              <p className="text-2xs text-muted-foreground">
                {slide.locked
                  ? "This slide is locked; unlock it to change its transition."
                  : "From the slide before, and back. The deck's is set in Settings."}
              </p>
            </div>
            <TransitionOptions
              value={own}
              inherit={deckTransition}
              columns="grid-cols-2"
              disabled={slide.locked}
              onPick={(transition) => {
                setOpen(false);
                if (transition !== own) void useApp.getState().setSlideTransition(slide.id, transition);
              }}
            />
          </div>
        </Popover>
      )}
    </div>
  );
}
