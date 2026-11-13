import { FileText, Loader2, MousePointerClick, PenLine, Presentation, Undo2, X } from "lucide-react";

import type { EditElement } from "../../lib/editTools";
import { cn } from "../../lib/utils";
import { useApp } from "../../store";
import { ComposerComments } from "../Comments";

/** A chip that goes along with the message. */
const CHIP = "flex h-6 min-w-0 max-w-full items-center gap-1 rounded-md border px-1.5 text-xs";
const SENT = "border-primary/30 bg-primary/10 text-primary";

/** The button on a chip that leaves it out of the message: a target of its own, as tall as the chip. */
function ChipRemove(props: { label: string; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.title ?? props.label}
      onClick={props.onClick}
      className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded hover:bg-foreground/10 hover:text-foreground"
    >
      <X className="size-3" />
    </button>
  );
}

/**
 * What goes along with the message besides its text and images, as chips above the composer's
 * input: the slide it is about (pressed, it goes along), the element, the sketch, the comments,
 * the undone turns the agent is told about, the attached files, and those still being saved.
 * Each can be left out.
 */
export function ComposerChips(props: {
  /** The selected slide's number, 0 without one. */
  slideNumber: number;
  includeSlide: boolean;
  onToggleSlide: () => void;
  element: EditElement | null;
  onDropElement: () => void;
  /** Whether the marks on the selected slide (`selected`) go along with the message. */
  sendsSketch: boolean;
  selected: string | null;
  /** The attached files that are not images. */
  files: string[];
  onRemove: (path: string) => void;
  /** How many attachments are still being saved. */
  pending: number;
}) {
  const { slideNumber, includeSlide, element, sendsSketch, selected, files, onRemove, pending } = props;
  const { onToggleSlide, onDropElement } = props;
  const revertNotes = useApp((s) => s.revertNotes);
  if (!(files.length > 0 || slideNumber > 0 || element || revertNotes.length > 0 || pending > 0)) return null;
  return (
    <div className="@container flex flex-wrap gap-1 px-3.5 pt-3">
      {slideNumber > 0 && (
        <button
          type="button"
          aria-pressed={includeSlide}
          onClick={onToggleSlide}
          title={
            includeSlide
              ? "The agent will know which slide you are on. Click to leave it out."
              : "Not referencing the current slide. Click to include it."
          }
          className={cn(CHIP, "shrink-0", includeSlide ? SENT : "text-muted-foreground line-through")}
        >
          <Presentation className="size-3 shrink-0" />
          Slide {slideNumber}
        </button>
      )}
      {element && (
        <span title={`The agent gets this element's markup:\n${element.path}`} className={cn(CHIP, SENT)}>
          <MousePointerClick className="size-3 shrink-0" />
          <span className="truncate">{element.name}</span>
          <ChipRemove label="Don't send element" onClick={onDropElement} />
        </span>
      )}
      {sendsSketch && (
        <span
          title="A screenshot of the slide with your marks is sent along; the marks stay on the slide as a review"
          className={cn(CHIP, SENT)}
        >
          <PenLine className="size-3 shrink-0" />
          Sketch
          <ChipRemove
            label="Don't send sketch"
            title="Don't send these marks; they stay on the slide"
            onClick={() => selected && useApp.getState().skipSketch(selected)}
          />
        </span>
      )}
      <ComposerComments />
      {revertNotes.map((note) => (
        <span
          key={note.message}
          title={`The agent is told that you undid what its turn for ${note.label} changed in the deck`}
          className={cn(CHIP, SENT)}
        >
          <Undo2 className="size-3 shrink-0" />
          <span className="truncate">Undone: {note.label}</span>
          <ChipRemove label="Don't tell the agent" onClick={() => useApp.getState().dropRevertNote(note.message)} />
        </span>
      ))}
      {files.map((a) => {
        const name = a.replace(/^assets\//, "");
        return (
          <span key={a} title={a} className={cn(CHIP, "text-muted-foreground")}>
            <FileText className="size-3 shrink-0" />
            <span className="truncate">{name}</span>
            <ChipRemove label={`Remove ${name}`} onClick={() => onRemove(a)} />
          </span>
        );
      })}
      {pending > 0 && (
        <span role="status" className={cn(CHIP, "border-dashed text-muted-foreground")}>
          <Loader2 className="size-3 shrink-0 animate-spin" />
          Attaching{pending > 1 ? ` ${pending} files` : ""}…
        </span>
      )}
    </div>
  );
}
