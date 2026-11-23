import { FileText, MousePointerClick, PenLine, Presentation, Undo2, X } from "lucide-react";

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { EditElement } from "../../lib/editTools";
import { cn } from "../../lib/utils";
import { useApp } from "../../store";
import { ComposerComments } from "../Comments";
import { CHIP, CHIP_ICON } from "./messageStyles";

const SENT = "border-primary/30 bg-primary/10 text-primary";

/**
 * A chip that goes along with the message: what it is (`icon`, and its name as `children`), with
 * a button that leaves it out of the message when `remove` names one. `title` says more of it.
 */
function Chip(props: {
  icon: React.ReactNode;
  children: React.ReactNode;
  title?: string;
  sent?: boolean;
  remove?: { label: string; tooltip?: string; onClick: () => void };
}) {
  const { remove } = props;
  return (
    <Attachment size="xs" title={props.title} className={cn(CHIP, props.sent ? SENT : "text-muted-foreground")}>
      <AttachmentMedia className={CHIP_ICON}>{props.icon}</AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle className="font-normal">{props.children}</AttachmentTitle>
      </AttachmentContent>
      {remove && (
        <AttachmentActions className="-mr-1">
          <AttachmentAction
            size="icon-2xs"
            aria-label={remove.label}
            tooltip={remove.tooltip ?? remove.label}
            onClick={remove.onClick}
            className="hover:bg-foreground/10"
          >
            <X />
          </AttachmentAction>
        </AttachmentActions>
      )}
    </Attachment>
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
    <AttachmentGroup className="@container w-full flex-wrap gap-1 overflow-visible px-3.5 pt-3 pb-0 mask-none!">
      {slideNumber > 0 && (
        <Button
          variant="outline"
          size="xs"
          aria-pressed={includeSlide}
          onClick={onToggleSlide}
          tooltip={
            includeSlide
              ? "The agent will know which slide you are on. Click to leave it out."
              : "Not referencing the current slide. Click to include it."
          }
          className={cn(
            "rounded-md px-1.5 font-normal",
            includeSlide
              ? cn(SENT, "aria-pressed:bg-primary/10 aria-pressed:text-primary hover:bg-primary/15 hover:text-primary")
              : "bg-transparent text-muted-foreground line-through",
          )}
        >
          <Presentation className="size-3" />
          Slide {slideNumber}
        </Button>
      )}
      {element && (
        <Chip
          sent
          icon={<MousePointerClick className="size-3" />}
          title={`The agent gets this element's markup:\n${element.path}`}
          remove={{ label: "Don't send element", onClick: onDropElement }}
        >
          {element.name}
        </Chip>
      )}
      {sendsSketch && (
        <Chip
          sent
          icon={<PenLine className="size-3" />}
          title="A screenshot of the slide with your marks is sent along; the marks stay on the slide as a review"
          remove={{
            label: "Don't send sketch",
            tooltip: "Don't send these marks; they stay on the slide",
            onClick: () => selected && useApp.getState().skipSketch(selected),
          }}
        >
          Sketch
        </Chip>
      )}
      <ComposerComments />
      {revertNotes.map((note) => (
        <Chip
          key={note.message}
          sent
          icon={<Undo2 className="size-3" />}
          title={`The agent is told that you undid what its turn for ${note.label} changed in the deck`}
          remove={{ label: "Don't tell the agent", onClick: () => useApp.getState().dropRevertNote(note.message) }}
        >
          Undone: {note.label}
        </Chip>
      ))}
      {files.map((a) => {
        const name = a.replace(/^assets\//, "");
        return (
          <Chip
            key={a}
            icon={<FileText className="size-3" />}
            title={a}
            remove={{ label: `Remove ${name}`, onClick: () => onRemove(a) }}
          >
            {name}
          </Chip>
        );
      })}
      {pending > 0 && (
        <Attachment size="xs" state="uploading" role="status" className={cn(CHIP, "px-1.5 text-muted-foreground")}>
          <Spinner aria-hidden="true" className="size-3" />
          <AttachmentTitle className="font-normal">Attaching{pending > 1 ? ` ${pending} files` : ""}…</AttachmentTitle>
        </Attachment>
      )}
    </AttachmentGroup>
  );
}
