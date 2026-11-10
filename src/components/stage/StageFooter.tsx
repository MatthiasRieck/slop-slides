import { AlertTriangle, ChevronLeft, ChevronRight, LayoutTemplate, Lock, Maximize, Wand2 } from "lucide-react";
import { useRef, useState } from "react";

import type { Slide } from "../../lib/api";
import { cn } from "../../lib/utils";
import { useApp } from "../../store";
import { Button, ToolButton } from "../Button";
import { LintStatus } from "../LintStatus";
import { Popover } from "../Popover";
import { LayoutPicker } from "../Templates";
import type { PasteboardView } from "./usePasteboard";

/**
 * The row under the slide: the arrows between slides and where this one is, and on the right
 * the zoom (back to full size), what is wrong with the slide, its layout tools and the lint status.
 */
export function StageFooter(props: {
  /** The current slide's place in the deck, -1 without one. */
  index: number;
  count: number;
  slide: Slide | undefined;
  /** The pasteboard's view, when it is panned or zoomed. */
  view: PasteboardView | null;
  onResetView: () => void;
  /** What runs past the slide or is cut off, as the editor found. */
  overflow: string[];
  running: boolean;
  /** Takes the selection out of the preview, for the screenshot Tidy layout sends. */
  onClearSelection: () => void;
}) {
  const { index, count, slide, view, overflow, running } = props;
  const locked = !!slide?.locked;
  return (
    <div className="grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)] items-center gap-2 px-3 text-xs text-muted-foreground">
      <div />
      <div className="flex items-center gap-2">
        <ToolButton
          variant="plain"
          aria-label="Previous slide"
          onClick={() => useApp.getState().selectRelative(-1)}
          disabled={index <= 0}
        >
          <ChevronLeft className="size-4" />
        </ToolButton>
        <span className="tabular-nums">
          {index + 1} / {count}
        </span>
        <ToolButton
          variant="plain"
          aria-label="Next slide"
          onClick={() => useApp.getState().selectRelative(1)}
          disabled={index >= count - 1}
        >
          <ChevronRight className="size-4" />
        </ToolButton>
      </div>
      <div className="flex items-center justify-end">
        {view && (
          <Button
            variant="ghost"
            size="sm"
            title="Back to the slide, centered at full size (0)"
            onClick={props.onResetView}
            className="mr-1 tabular-nums"
          >
            <Maximize className="size-3.5" />
            {Math.round(view.k * 100)}%
          </Button>
        )}
        {overflow.length > 0 && (
          <span
            title={`Runs past the slide or is cut off:\n${overflow.join("\n")}`}
            className="mr-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-warning "
          >
            <AlertTriangle className="size-3.5" />
            Overflow
          </span>
        )}
        {locked && (
          <span
            title="Locked: neither you nor the agent can change this slide. Unlock it in the slide list."
            className="mr-1 flex items-center gap-1 rounded-md px-1.5 py-1"
          >
            <Lock className="size-3.5" />
            Locked
          </span>
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
