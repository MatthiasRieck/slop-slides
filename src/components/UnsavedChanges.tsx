import { useRef } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useUnsavedQuestion } from "../store/confirm";

/**
 * Asks what to do about unsaved HTML edits before what would lose them (another file, closing
 * the tab or the window): save them, give them up, or stay. Mounted once, for the whole app; it
 * shows while a question is open (see `askUnsaved` in ../store/confirm.ts). Escape stays, and a
 * press beside it does nothing: it is a question, which takes one of its answers.
 */
export function UnsavedChanges() {
  const question = useUnsavedQuestion((s) => s.question);
  const save = useRef<HTMLButtonElement>(null);
  if (!question) return null;
  return (
    <AlertDialog open onOpenChange={(open) => !open && question.answer("cancel")}>
      <AlertDialogContent initialFocus={save}>
        <AlertDialogHeader>
          <AlertDialogTitle>Save the changes to {question.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The HTML tab holds edits that are not in the deck file yet. Without saving, they are lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* Closing it is the answer "cancel" (see `onOpenChange`). */}
          <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" size="sm" onClick={() => question.answer("discard")}>
            Don’t save
          </AlertDialogAction>
          <AlertDialogAction ref={save} size="sm" onClick={() => question.answer("save")}>
            Save
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
