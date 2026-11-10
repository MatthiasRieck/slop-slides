import { FileText, MousePointerClick, PenLine, Presentation, Undo2, X } from "lucide-react";

import type { EditElement } from "../../lib/editTools";
import { cn } from "../../lib/utils";
import { useApp } from "../../store";
import { ComposerComments } from "../Comments";

/**
 * What goes along with the message besides its text and images, as chips above the composer's
 * input: the slide it is about (pressed, it is left out), the element, the sketch, the comments,
 * the undone turns the agent is told about, and the attached files. Each can be left out.
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
}) {
  const { slideNumber, includeSlide, element, sendsSketch, selected, files, onRemove } = props;
  const { onToggleSlide, onDropElement } = props;
  const revertNotes = useApp((s) => s.revertNotes);
  if (!(files.length > 0 || slideNumber > 0 || element || revertNotes.length > 0)) return null;
  return (
    <div className="@container flex flex-wrap gap-1 px-3.5 pt-3">
      {slideNumber > 0 && (
        <button
          type="button"
          onClick={onToggleSlide}
          title={includeSlide ? "The agent will know which slide you are on" : "Not referencing the current slide"}
          className={cn(
            "flex h-5 items-center gap-1 rounded-md border px-1.5 text-xs",
            includeSlide ? "border-primary/30 bg-primary/10 text-primary" : "text-muted-foreground line-through",
          )}
        >
          <Presentation className="size-3" />
          Slide {slideNumber}
        </button>
      )}
      {element && (
        <span
          title={`The agent gets this element's markup:\n${element.path}`}
          className="flex h-5 min-w-0 items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 text-xs text-primary"
        >
          <MousePointerClick className="size-3 shrink-0" />
          <span className="truncate">{element.name}</span>
          <button
            type="button"
            aria-label="Don't send element"
            onClick={onDropElement}
            className="hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      )}
      {sendsSketch && (
        <span
          title="A screenshot of the slide with your marks is sent along; the marks stay on the slide as a review"
          className="flex h-5 items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 text-xs text-primary"
        >
          <PenLine className="size-3" />
          Sketch
          <button
            type="button"
            aria-label="Don't send sketch"
            title="Don't send these marks; they stay on the slide"
            onClick={() => selected && useApp.getState().skipSketch(selected)}
            className="hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      )}
      <ComposerComments />
      {revertNotes.map((note) => (
        <span
          key={note.message}
          title={`The agent is told that you undid what its turn for ${note.label} changed in the deck`}
          className="flex h-5 min-w-0 items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 text-xs text-primary"
        >
          <Undo2 className="size-3 shrink-0" />
          <span className="truncate">Undone: {note.label}</span>
          <button
            type="button"
            aria-label="Don't tell the agent"
            onClick={() => useApp.getState().dropRevertNote(note.message)}
            className="hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {files.map((a) => (
        <span key={a} className="flex h-5 items-center gap-1 rounded-md border px-1.5 text-xs text-muted-foreground">
          <FileText className="size-3" />
          {a.replace(/^assets\//, "")}
          <button
            type="button"
            aria-label={`Remove ${a.replace(/^assets\//, "")}`}
            onClick={() => onRemove(a)}
            className="hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
