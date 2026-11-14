import { isMac } from "../lib/utils";
import { useUnsavedQuestion } from "../store/confirm";
import { Button } from "./Button";
import { Dialog, DialogActions } from "./Dialog";

/**
 * Asks what to do about unsaved HTML edits before what would lose them (another file, closing
 * the tab or the window): save them, give them up, or stay. Mounted once, for the whole app; it
 * shows while a question is open (see `askUnsaved` in ../store/confirm.ts). Escape stays.
 *
 * The buttons are in the order of the system's own question. On macOS: "Don’t save" apart at the
 * left, then Cancel and Save at the right. Elsewhere: Save, Don’t save, Cancel. Save is the
 * default either way, and nothing is red: not saving is a choice, not a mistake.
 */
export function UnsavedChanges({ mac = isMac }: { mac?: boolean }) {
  const question = useUnsavedQuestion((s) => s.question);
  if (!question) return null;
  const save = (
    <Button variant="primary" size="lg" data-autofocus onClick={() => question.answer("save")}>
      Save
    </Button>
  );
  const discard = (
    <Button size="lg" onClick={() => question.answer("discard")}>
      Don’t save
    </Button>
  );
  const cancel = (
    <Button size="lg" onClick={() => question.answer("cancel")}>
      Cancel
    </Button>
  );
  return (
    <Dialog
      label="Unsaved changes"
      size="sm"
      title={<>Save the changes to {question.name}?</>}
      description="The HTML tab holds edits that are not in the deck file yet. Without saving, they are lost."
      onClose={() => question.answer("cancel")}
    >
      {mac ? (
        <DialogActions aside={discard}>
          {cancel}
          {save}
        </DialogActions>
      ) : (
        <DialogActions>
          {save}
          {discard}
          {cancel}
        </DialogActions>
      )}
    </Dialog>
  );
}
