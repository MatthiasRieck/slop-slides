import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import type { Deck, Slide } from "../lib/api";
import { slideHeading } from "../lib/slideTitle";
import { useDraftText } from "../lib/useDraftText";
import { cn } from "../lib/utils";
import { NOTES_HEIGHT, useApp } from "../store";
import { Button } from "./Button";
import { ScriptField, ScriptPreviewToggle } from "./ScriptMarkdown";
import { SlideTime } from "./SlideTime";

/** How long typing pauses before the notes are saved to the deck. */
export const NOTES_SAVE_DELAY = 800;

/** How far an arrow key moves the edge of the notes under the slide, in pixels. */
const RESIZE_STEP = 16;

/**
 * A slide's speaker notes as they are being written: the text, saved by itself once typing
 * pauses, and whether a save is on its way or in. Mount one per slide: switching slides saves
 * the last one's pending text as it unmounts.
 */
function useNotesDraft(slide: Slide) {
  const [saving, setSaving] = useState<"saving" | "saved" | null>(null);
  /** Counts the changes, so a save that an edit has overtaken does not say "Saved". */
  const typed = useRef(0);
  const { draft, change, flush } = useDraftText(slide.notes ?? "", NOTES_SAVE_DELAY, async (text) => {
    const at = typed.current;
    await useApp.getState().setNotes(slide.id, text);
    if (typed.current === at) setSaving("saved");
  });
  const edit = (text: string) => {
    typed.current++;
    setSaving("saving");
    change(text);
  };
  return { draft, edit, flush, saving };
}

/** Says that the notes are being saved, or are saved, once they were changed. */
function SavingStatus({ saving }: { saving: "saving" | "saved" | null }) {
  if (!saving) return null;
  return (
    <span role="status" className="shrink-0 text-2xs text-muted-foreground">
      {saving === "saving" ? "Saving…" : "Saved"}
    </span>
  );
}

/** The first line of `notes` with something on it, as the folded pane shows it. */
export function firstNotesLine(notes: string): string {
  return (
    notes
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

/**
 * The speaker notes of the slide on the stage, in a pane under it, in View and in Edit: where
 * the presenter writes what to say, beside the slide it is said over, with the time planned for
 * the slide. Folded, it is one line that shows how the notes begin; open, it is a Markdown field
 * as tall as the user dragged it (see `NOTES_HEIGHT`). Whether it is open and how tall are
 * remembered. The notes save by themselves, which the header says.
 *
 * It reads what it shows from the store itself, so the stage around it does not render for it.
 */
export const NotesPane = memo(function NotesPane() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const open = useApp((s) => s.notesOpen);
  const index = deck?.slides.findIndex((s) => s.id === selected) ?? -1;
  const slide = deck?.slides[index];
  if (!deck || !slide) return null;
  return (
    <section aria-label="Speaker notes" className="relative shrink-0 border-t bg-background">
      {open && <ResizeHandle />}
      {/* One editor per slide: switching slides saves the last one's pending text as it unmounts. */}
      <PaneNotes key={slide.id} deck={deck} slide={slide} index={index} open={open} />
    </section>
  );
});

/** The pane's header row, and under it, while the pane is open, the field the notes are written in. */
function PaneNotes(props: { deck: Deck; slide: Slide; index: number; open: boolean }) {
  const { deck, slide, index, open } = props;
  const height = useApp((s) => s.notesHeight);
  const [preview, setPreview] = useState(false);
  const { draft, edit, flush, saving } = useNotesDraft(slide);
  const body = useRef<HTMLDivElement>(null);
  /** The user opened the pane: the field takes the keyboard once it is there. */
  const focusAsked = useRef(false);
  const toggle = () => {
    focusAsked.current = !open;
    useApp.getState().setNotesOpen(!open);
  };
  useEffect(() => {
    if (!open || !focusAsked.current) return;
    focusAsked.current = false;
    body.current?.querySelector("textarea")?.focus();
  }, [open]);
  const Chevron = open ? ChevronDown : ChevronRight;
  const first = firstNotesLine(draft);
  return (
    <>
      <div className="flex h-8 items-center gap-2 px-3 text-xs text-muted-foreground">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          title={open ? "Fold the speaker notes away" : "Open the speaker notes"}
          onClick={toggle}
          className="-ml-1.5 font-medium text-foreground"
        >
          <Chevron />
          Notes
        </Button>
        {open ? (
          <span className="min-w-0 flex-1 truncate">{slideHeading(index, slide.id)}</span>
        ) : (
          <button
            type="button"
            data-testid="notes-first-line"
            title="Open the speaker notes"
            onClick={toggle}
            className={cn("min-w-0 flex-1 truncate text-left hover:text-foreground", !first && "italic")}
          >
            {first || (slide.locked ? "No notes" : "Add what to say while this slide is shown…")}
          </button>
        )}
        <SavingStatus saving={saving} />
        {open && <ScriptPreviewToggle preview={preview} onChange={setPreview} />}
        {slide.locked && (
          <span
            role="img"
            aria-label="Locked"
            title="This slide is locked: its notes cannot be changed"
            className="flex shrink-0 items-center"
          >
            <Lock className="size-3" />
          </span>
        )}
        <SlideTime deck={deck} compact />
      </div>
      {open && (
        <div ref={body} style={{ height }} className="flex max-h-[40vh] min-h-16 flex-col px-3 pb-2">
          <ScriptField
            label="Speaker notes"
            draft={draft}
            preview={preview}
            readOnly={!!slide.locked}
            onChange={edit}
            onBlur={() => void flush()}
            placeholder={slide.locked ? "No notes." : "What to remember while this slide is shown…"}
          />
        </div>
      )}
    </>
  );
}

/**
 * The top edge of the open notes, to drag: up makes them taller, down shorter. The arrow keys do
 * the same in steps, and a double-click puts the height back to where it starts. The height is
 * the store's, kept within `NOTES_HEIGHT` and remembered.
 */
function ResizeHandle() {
  const height = useApp((s) => s.notesHeight);
  /** Where the drag started, and how tall the notes were then. */
  const drag = useRef<{ y: number; height: number } | null>(null);
  const { setNotesHeight } = useApp.getState();
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { y: event.clientY, height };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current) setNotesHeight(drag.current.height + drag.current.y - event.clientY);
  };
  const end = () => {
    drag.current = null;
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowUp" ? RESIZE_STEP : event.key === "ArrowDown" ? -RESIZE_STEP : 0;
    if (!step) return;
    event.preventDefault();
    // The stage's own arrow keys change slides.
    event.stopPropagation();
    setNotesHeight(height + step);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable edge between two panes, which an <hr> is not
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the speaker notes"
      aria-valuenow={height}
      aria-valuemin={NOTES_HEIGHT.min}
      aria-valuemax={NOTES_HEIGHT.max}
      tabIndex={0}
      title="Drag to resize the notes; double-click for the usual height"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => setNotesHeight(NOTES_HEIGHT.initial)}
      onKeyDown={onKeyDown}
      className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none after:absolute after:inset-x-0 after:top-[3px] after:h-0.5 hover:after:bg-primary/40 focus-visible:after:bg-primary"
    />
  );
}
