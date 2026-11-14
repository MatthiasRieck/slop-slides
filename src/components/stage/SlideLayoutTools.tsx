import { LayoutTemplate, Sparkles, Wand2 } from "lucide-react";
import { createContext, useContext, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { useApp } from "../../store";
import { selectedSlide } from "../../store/slides";
import { Button } from "../Button";
import { Popover } from "../Popover";
import { LayoutPicker } from "../Templates";
import { slideReport, useSlideReport } from "./editorState";

/** What the tools around the slide ask of its preview, which the stage hands them. */
export interface StageActions {
  /** Takes the selection, wires and any panning out of the preview, for a screenshot of just the slide. */
  clearSelection: () => void;
  /** Posts a message to the slide's preview (the pasteboard and, in Edit, the editor). */
  post: (data: unknown) => void;
}

/** The stage's preview, for the tools in the ribbons and under the slide; outside a stage they do nothing to it. */
export const StageActionsContext = createContext<StageActions>({ clearSelection: () => {}, post: () => {} });

/** The mark of a control that hands a request to the agent instead of acting itself. */
export function AgentMark() {
  return <Sparkles aria-hidden="true" size={12} className="!size-3 shrink-0 text-primary" />;
}

/** Why the agent cannot be asked about the slide right now; undefined when it can. */
function useAgentBusy(): string | undefined {
  const running = useApp((s) => s.running);
  const locked = useApp((s) => !!selectedSlide(s)?.locked);
  if (locked) return "This slide is locked: unlock it to change it";
  if (running) return "The agent is at work: ask once it is done";
  return undefined;
}

/**
 * Asks the agent to tidy the slide shown: a screenshot of just the slide (its selection put away
 * first) and a request, with what overflows, go into the chat for the user to send. The mode stays.
 */
export function useTidyLayout(): () => void {
  const { clearSelection } = useContext(StageActionsContext);
  return () => {
    clearSelection();
    // Give the preview a frame to drop its selection outline before the screenshot.
    const { overflow } = slideReport();
    requestAnimationFrame(() => requestAnimationFrame(() => void useApp.getState().tidyLayout(overflow)));
  };
}

/**
 * "Change layout…" in a ribbon's Slide section: opens the deck's layouts, and picking one puts a
 * request in the chat for the agent to rebuild the slide on it.
 */
export function ChangeLayoutTool() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const busy = useAgentBusy();
  return (
    <>
      <Button
        ref={anchor}
        variant="ghost"
        size="sm"
        aria-label="Change layout…"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={busy ?? "Rebuild this slide on one of the deck's layouts, keeping its content · asks the agent"}
        disabled={busy !== undefined}
        onClick={() => setOpen((v) => !v)}
        className="flex-1"
      >
        <LayoutTemplate />
        Change layout…
        <AgentMark />
      </Button>
      {open && (
        <Popover anchor={anchor} placement="below" width={560} label="Change layout" onClose={() => setOpen(false)}>
          <LayoutPicker mode="change" onDone={() => setOpen(false)} />
        </Popover>
      )}
    </>
  );
}

/**
 * "Tidy layout…" in a ribbon's Slide section: asks the agent to fit what runs past the slide and
 * what was moved by hand into a clean layout. It stands out while the slide has either.
 */
export function TidyLayoutTool() {
  const untidy = useUntidy();
  const busy = useAgentBusy();
  const tidy = useTidyLayout();
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="Tidy layout…"
      title={
        busy ??
        `${untidy ?? "Fits what runs past the slide and what you moved by hand into a clean layout"}. Puts a request with a screenshot in the chat · asks the agent`
      }
      disabled={busy !== undefined}
      onClick={tidy}
      className={cn("flex-1", untidy && "font-medium text-foreground")}
    >
      <Wand2 />
      Tidy layout…
      <AgentMark />
    </Button>
  );
}

/** Why the slide shown could do with tidying, as the start of a sentence; undefined when nothing says so. */
function useUntidy(): string | undefined {
  const moved = useApp((s) => !!selectedSlide(s)?.moved);
  const overflows = useSlideReport((report) => report.overflow.length > 0);
  if (overflows && moved) return "Something runs past this slide, and elements on it were moved by hand";
  if (overflows) return "Something runs past this slide or is cut off";
  if (moved) return "Elements on this slide were moved by hand";
  return undefined;
}
