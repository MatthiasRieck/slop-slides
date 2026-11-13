import { useUnsavedQuestion } from "../store/confirm";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

/**
 * Asks what to do about unsaved HTML edits before what would lose them (another file, closing
 * the tab or the window): save them, give them up, or stay. Mounted once, for the whole app; it
 * shows while a question is open (see `askUnsaved` in ../store/confirm.ts). Escape stays.
 */
export function UnsavedChanges() {
  const question = useUnsavedQuestion((s) => s.question);
  if (!question) return null;
  return (
    <Dialog
      label="Unsaved changes"
      onClose={() => question.answer("cancel")}
      className="flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-xl border bg-card p-4 text-foreground shadow-lg outline-none"
      heading={<h2 className="text-sm font-medium">Save the changes to {question.name}?</h2>}
    >
      <p className="text-xs text-muted-foreground">
        The HTML tab holds edits that are not in the deck file yet. Without saving, they are lost.
      </p>
      <div className="flex justify-end gap-2">
        <Button size="lg" onClick={() => question.answer("cancel")}>
          Cancel
        </Button>
        <Button variant="destructive" size="lg" onClick={() => question.answer("discard")}>
          Don’t save
        </Button>
        <Button variant="primary" size="lg" data-autofocus onClick={() => question.answer("save")}>
          Save
        </Button>
      </div>
    </Dialog>
  );
}
