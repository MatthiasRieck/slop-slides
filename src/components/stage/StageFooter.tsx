import { AlertTriangle, Check, ChevronLeft, ChevronRight, EyeOff, Lock, Search, ZoomIn, ZoomOut } from "lucide-react";
import { memo, type ReactNode, useContext, useRef, useState } from "react";

import { useMenuKeys } from "../../hooks/useMenuKeys";
import type { Slide } from "../../lib/api";
import { cn, plural } from "../../lib/utils";
import { showSuccess, useApp } from "../../store";
import { Button, ToolButton, withShortcut } from "../Button";
import { LintStatus } from "../LintStatus";
import { Popover } from "../Popover";
import { useSlideReport } from "./editorState";
import { AgentMark, StageActionsContext, useTidyLayout } from "./SlideLayoutTools";
import { isMoved, overflowPath, useShownView, useStageView } from "./stageView";
import { ZOOM_LEVELS, ZOOM_STEP } from "./usePasteboard";

/** Where a control's name shows beside its icon: once the row under the slide has the room. */
const NAMED = "hidden @[38rem]:inline";

/**
 * The row under the slide, in three groups that keep their places: on the left Find and what is
 * special about the slide shown (something runs past it, it is hidden, it is locked); in the
 * middle, always in the middle whatever shows beside it, the arrows between slides and where
 * this one is (a field to jump to another); on the right the check of the deck and the zoom.
 * In a narrow stage the controls keep their icons and drop their names.
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
}) {
  const { index, count, slide } = props;
  return (
    <div className="@container shrink-0 border-t text-xs text-muted-foreground">
      <div className="grid h-10 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3">
        <div className="flex min-w-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Find"
            title="Find text on the slides and in their notes"
            shortcut="mod+f"
            onClick={() => useApp.getState().openFind()}
          >
            <Search />
            <span className={NAMED}>Find</span>
          </Button>
          {slide && <SlideStatus slide={slide} number={index + 1} />}
        </div>
        <nav aria-label="Slides" className="flex items-center gap-1">
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
        </nav>
        <div className="flex min-w-0 items-center justify-end gap-1">
          <LintStatus nameClass={NAMED} />
          {slide && <ZoomControls onFit={props.onResetView} onZoomBy={props.onZoomBy} onZoomTo={props.onZoomTo} />}
        </div>
      </div>
    </div>
  );
});

/**
 * What is special about the slide shown, each a control for it: what runs past it (a list to
 * pick from), and that it is hidden or locked. The last two are toggles that are on: pressing
 * one turns the state off, and says so with a way to take that back.
 */
function SlideStatus({ slide, number }: { slide: Slide; number: number }) {
  const { setSlidesHidden, setSlidesLocked } = useApp.getState();
  const show = () => {
    void setSlidesHidden([slide.id], false);
    showSuccess(`Slide ${number} is shown again`, { label: "Undo", run: () => void setSlidesHidden([slide.id], true) });
  };
  const unlock = () => {
    void setSlidesLocked([slide.id], false);
    showSuccess(`Slide ${number} unlocked`, { label: "Undo", run: () => void setSlidesLocked([slide.id], true) });
  };
  return (
    <>
      <OverflowChip slide={slide.id} />
      {slide.hidden && (
        <StatusToggle
          label="Hidden"
          title="Hidden: skipped when presenting. Click to show the slide again."
          icon={<EyeOff />}
          onClick={show}
        />
      )}
      {slide.locked && (
        <StatusToggle
          label="Locked"
          title="Locked: neither you nor the agent can change this slide. Click to unlock it."
          icon={<Lock />}
          onClick={unlock}
        />
      )}
    </>
  );
}

/** A state of the slide that is on, as the toggle it is: pressed, and a press turns it off. */
function StatusToggle(props: { label: string; title: string; icon: ReactNode; onClick: () => void }) {
  return (
    <ToolButton
      active
      label={props.label}
      title={props.title}
      onClick={props.onClick}
      className="flex shrink-0 items-center gap-1 px-1.5 text-xs [&_svg]:!size-3.5"
    >
      {props.icon}
      <span className={NAMED}>{props.label}</span>
    </ToolButton>
  );
}

/**
 * The warning that something on the slide runs past its edge or is cut off, as the editor found.
 * It opens the list of what does: a row selects that element on the slide, and the button under
 * the list asks the agent to tidy the slide.
 */
function OverflowChip({ slide }: { slide: string }) {
  const overflow = useSlideReport((report) => report.overflow);
  const running = useApp((s) => s.running);
  const { post } = useContext(StageActionsContext);
  const tidy = useTidyLayout();
  const menu = useMenuKeys();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (overflow.length === 0) return null;
  const select = (index: number) => {
    const path = overflowPath(slide, index);
    if (path) post({ type: "slop:edit-select", path });
    setOpen(false);
  };
  return (
    <>
      <Button
        ref={anchor}
        variant="ghost"
        size="sm"
        aria-label={`Overflow: ${plural(overflow.length, "element")}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Something runs past the slide or is cut off. Click to see what."
        onClick={() => setOpen((v) => !v)}
        className={cn("text-warning", open && "bg-accent")}
      >
        <AlertTriangle />
        <span className={NAMED}>Overflow</span>
      </Button>
      {open && (
        <Popover
          anchor={anchor}
          placement="above"
          width={380}
          label="What runs past the slide"
          onClose={() => setOpen(false)}
        >
          <p className="shrink-0 border-b px-3 py-2 text-xs font-medium">
            {plural(overflow.length, "element runs", "elements run")} past the slide or{" "}
            {overflow.length === 1 ? "is" : "are"} cut off
          </p>
          <div
            role="menu"
            aria-label="What runs past the slide"
            {...menu}
            className="min-h-0 flex-1 overflow-y-auto p-1 text-xs outline-none"
          >
            {overflow.map((item, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: the list is the editor's, rebuilt whole with every report
                key={i}
                type="button"
                role="menuitem"
                title="Select this element on the slide"
                onClick={() => select(i)}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <span className="min-w-0 flex-1 break-words">{item}</span>
              </button>
            ))}
          </div>
          <div className="flex shrink-0 items-center justify-end border-t p-2">
            <Button
              data-autofocus
              disabled={running}
              title={
                running
                  ? "The agent is at work: ask once it is done"
                  : "Puts a request with a screenshot in the chat, to fit these into a clean layout · asks the agent"
              }
              onClick={() => {
                setOpen(false);
                tidy();
              }}
            >
              Tidy layout…
              <AgentMark />
            </Button>
          </div>
        </Popover>
      )}
    </>
  );
}

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
        className="whitespace-nowrap rounded-md px-1.5 py-0.5 tabular-nums enabled:hover:bg-accent enabled:hover:text-foreground"
      >
        {index + 1} / {count}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1 whitespace-nowrap tabular-nums">
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
    <div role="group" aria-label="Zoom" className="flex shrink-0 items-center">
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
