import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  LayoutTemplate,
  Lock,
  Search,
  Wand2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { memo, useRef, useState } from "react";

import { useMenuKeys } from "../../hooks/useMenuKeys";
import type { Slide } from "../../lib/api";
import { cn } from "../../lib/utils";
import { useApp } from "../../store";
import { Button, ToolButton, withShortcut } from "../Button";
import { EDIT_ONLY } from "../editOnly";
import { LintStatus } from "../LintStatus";
import { Popover } from "../Popover";
import { LayoutPicker } from "../Templates";
import { useSlideReport } from "./editorState";
import { isMoved, useShownView, useStageView } from "./stageView";
import { ZOOM_LEVELS, ZOOM_STEP } from "./usePasteboard";

/**
 * The row under the slide: on the left the search, in the middle the arrows between slides and
 * where this one is (a field to jump to another), and on the right the zoom, what is wrong with
 * the slide or special about it (hidden, locked), its layout tools and the lint status.
 *
 * What the slide editor found running past the slide, and how far the slide is zoomed, it reads
 * for itself, where they show.
 */
export const StageFooter = memo(function StageFooter(props: {
  /** The current slide's place in the deck, -1 without one. */
  index: number;
  count: number;
  slide: Slide | undefined;
  onResetView: () => void;
  onZoomBy: (factor: number) => void;
  /** Zooms to `k` times the size the slide fits the stage at. */
  onZoomTo: (k: number) => void;
  /** Takes the selection out of the preview, for the screenshot Tidy layout sends. */
  onClearSelection: () => void;
}) {
  const { index, count, slide } = props;
  // What runs past the slide or is cut off, as the editor found.
  const overflow = useSlideReport((report) => report.overflow);
  const running = useApp((s) => s.running);
  const editable = useApp((s) => s.editing);
  const locked = !!slide?.locked;
  return (
    <div className="grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)] items-center gap-2 px-3 text-xs text-muted-foreground">
      <div className="flex items-center">
        <ToolButton
          variant="plain"
          label="Find in the slides"
          shortcut="mod+f"
          onClick={() => useApp.getState().openFind()}
        >
          <Search />
        </ToolButton>
      </div>
      <div className="flex items-center gap-2">
        <ToolButton
          variant="plain"
          label="Previous slide"
          shortcut="left"
          onClick={() => useApp.getState().selectRelative(-1)}
          disabled={index <= 0}
        >
          <ChevronLeft className="size-4" />
        </ToolButton>
        <SlideCounter index={index} count={count} />
        <ToolButton
          variant="plain"
          label="Next slide"
          shortcut="right"
          onClick={() => useApp.getState().selectRelative(1)}
          disabled={index >= count - 1}
        >
          <ChevronRight className="size-4" />
        </ToolButton>
      </div>
      <div className="flex items-center justify-end">
        {slide && <ZoomControls onFit={props.onResetView} onZoomBy={props.onZoomBy} onZoomTo={props.onZoomTo} />}
        {overflow.length > 0 && (
          <span
            title={`Runs past the slide or is cut off:\n${overflow.join("\n")}`}
            className="mr-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-warning "
          >
            <AlertTriangle className="size-3.5" />
            Overflow
          </span>
        )}
        {slide?.hidden && (
          <Button
            variant="ghost"
            size="sm"
            disabled={!editable}
            title={
              editable
                ? "Hidden: skipped when presenting. Click to show it again."
                : `Hidden: skipped when presenting. ${EDIT_ONLY}.`
            }
            onClick={() => void useApp.getState().setSlidesHidden([slide.id], false)}
            className="mr-1"
          >
            <EyeOff />
            Hidden
          </Button>
        )}
        {slide && locked && (
          <Button
            variant="ghost"
            size="sm"
            title="Locked: neither you nor the agent can change this slide. Click to unlock it."
            onClick={() => void useApp.getState().setSlidesLocked([slide.id], false)}
            className="mr-1"
          >
            <Lock />
            Locked
          </Button>
        )}
        {slide && <ChangeLayoutButton disabled={running || locked} />}
        {slide && (
          <Button
            variant="ghost"
            size="sm"
            title="Prepare a message, with a screenshot, asking the agent to rebuild this slide's layout, fixing overflow and clipping and keeping the elements you moved, rotated or scaled"
            disabled={running || locked}
            onClick={() => {
              props.onClearSelection();
              // Give the preview a frame to drop its selection outline before the screenshot.
              requestAnimationFrame(() => requestAnimationFrame(() => void useApp.getState().tidyLayout(overflow)));
            }}
            className={cn((slide.moved || overflow.length > 0) && "font-medium text-foreground")}
          >
            <Wand2 className="size-3.5" />
            Tidy layout
          </Button>
        )}
        <LintStatus />
      </div>
    </div>
  );
});

/**
 * Where the slide shown is in the deck, "3 / 20". Pressed, the 3 becomes a field: a number and
 * Enter go to that slide, Escape or leaving the field keeps the one shown.
 */
function SlideCounter({ index, count }: { index: number; count: number }) {
  const [typing, setTyping] = useState(false);
  const go = (text: string) => {
    setTyping(false);
    const number = Number.parseInt(text, 10);
    const slides = useApp.getState().deck?.slides ?? [];
    // Past either end goes to that end, as far as the number reaches.
    const slide = Number.isFinite(number) ? slides[Math.min(slides.length, Math.max(1, number)) - 1] : undefined;
    if (slide) useApp.getState().select(slide.id);
  };
  if (!typing) {
    return (
      <button
        type="button"
        aria-label={`Slide ${index + 1} of ${count}. Go to a slide…`}
        title="Go to a slide: type its number"
        disabled={count < 2}
        onClick={() => setTyping(true)}
        className="rounded-md px-1.5 py-0.5 tabular-nums enabled:hover:bg-accent enabled:hover:text-foreground"
      >
        {index + 1} / {count}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1 tabular-nums">
      <input
        autoFocus
        aria-label="Go to slide number"
        inputMode="numeric"
        defaultValue={index + 1}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => setTyping(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            go(event.currentTarget.value);
          } else if (event.key === "Escape") {
            // The field's own: nothing else that is open closes with it.
            event.stopPropagation();
            setTyping(false);
          }
        }}
        className="h-5 w-9 rounded border border-input bg-background px-1 text-center text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
      />
      / {count}
    </span>
  );
}

/** A zoom level as the menu and the button write it. */
const percent = (zoom: number) => `${Math.round(zoom * 100)}%`;

/**
 * The stage's zoom: out, in, and between them how far it is zoomed, which opens the levels to go
 * to. "Fit" is the whole slide in the stage, where every slide starts; the percentages are the
 * slide's own pixels against the screen's, so 100% shows it at its real size. It follows the
 * pasteboard's view by itself, and renders when the zoom changes, not as the slide is panned.
 */
function ZoomControls(props: { onFit: () => void; onZoomBy: (factor: number) => void; onZoomTo: (k: number) => void }) {
  // How far the view is zoomed once it is panned or zoomed; null while it shows the whole slide.
  const zoomed = useShownView((view) => (view && isMoved(view) ? view.k : null));
  const fitScale = useStageView((s) => s.fitScale);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useMenuKeys();
  const moved = zoomed !== null;
  const zoom = (zoomed ?? 1) * fitScale;
  const level = moved ? percent(zoom) : "Fit";
  const item =
    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none [&_svg]:size-3.5";
  const pick = (go: () => void) => {
    setOpen(false);
    go();
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of buttons, not a form's fieldset
    <div role="group" aria-label="Zoom" className="mr-1 flex items-center">
      <ToolButton variant="plain" label="Zoom out" shortcut="mod+-" onClick={() => props.onZoomBy(1 / ZOOM_STEP)}>
        <ZoomOut className="size-3.5" />
      </ToolButton>
      <button
        ref={anchor}
        type="button"
        aria-label={`Zoom: ${level}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={withShortcut("Zoom level. Fit shows the whole slide", "mod+0")}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "min-w-10 rounded-md px-1 py-1 text-center tabular-nums hover:bg-accent hover:text-foreground",
          open && "bg-accent text-foreground",
        )}
      >
        {level}
      </button>
      <ToolButton variant="plain" label="Zoom in" shortcut="mod+plus" onClick={() => props.onZoomBy(ZOOM_STEP)}>
        <ZoomIn className="size-3.5" />
      </ToolButton>
      {open && (
        <Popover
          anchor={anchor}
          onClose={() => setOpen(false)}
          width={150}
          placement="above"
          variant="menu"
          portal
          className="p-1"
        >
          <div role="menu" aria-label="Zoom level" {...menu} className="outline-none">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!moved}
              onClick={() => pick(props.onFit)}
              className={item}
            >
              <span className="flex-1">Fit</span>
              {!moved && <Check className="text-muted-foreground" />}
            </button>
            {ZOOM_LEVELS.map((to) => {
              const here = moved && percent(zoom) === percent(to);
              return (
                <button
                  key={to}
                  type="button"
                  role="menuitemradio"
                  aria-checked={here}
                  onClick={() => pick(() => props.onZoomTo(to / fitScale))}
                  className={item}
                >
                  <span className="flex-1">{percent(to)}</span>
                  {here && <Check className="text-muted-foreground" />}
                </button>
              );
            })}
          </div>
        </Popover>
      )}
    </div>
  );
}

/** Opens the template layouts, to have the agent rebuild the current slide on one. */
function ChangeLayoutButton(props: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={buttonRef}
        variant="ghost"
        size="sm"
        title="Rebuild this slide on a template layout"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => setOpen((v) => !v)}
        className="mr-1"
      >
        <LayoutTemplate className="size-3.5" />
        Layout
      </Button>
      {open && (
        <Popover anchor={buttonRef} placement="above" width={560} label="Change layout" onClose={() => setOpen(false)}>
          <LayoutPicker mode="change" onDone={() => setOpen(false)} />
        </Popover>
      )}
    </>
  );
}
