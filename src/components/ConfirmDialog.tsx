import { useConfirmQuestion } from "../store/confirm";
import { Button } from "./Button";
import { Dialog, DialogActions } from "./Dialog";

/**
 * Asks the app's yes-or-no questions (see `confirmAction` in ../store/confirm.ts), one at a time.
 * Mounted once, for the whole app; it shows while a question is open. Escape and the cancel
 * button say no. The focus starts on the button that goes ahead, unless that deletes or discards
 * something: then it starts on the one that stays, so Enter by habit loses nothing.
 */
export function ConfirmDialog() {
  const question = useConfirmQuestion((s) => s.question);
  if (!question) return null;
  const { destructive = false } = question;
  return (
    <Dialog
      // One dialog per question: the next in line opens afresh, with the focus where it starts.
      key={question.title + question.message}
      label={question.title}
      size="sm"
      title={question.title}
      description={question.message}
      onClose={() => question.answer(false)}
    >
      <DialogActions>
        <Button size="lg" data-autofocus={destructive || undefined} onClick={() => question.answer(false)}>
          {question.cancelLabel ?? "Cancel"}
        </Button>
        <Button
          variant={destructive ? "destructive" : "primary"}
          size="lg"
          data-autofocus={!destructive || undefined}
          onClick={() => question.answer(true)}
        >
          {question.confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
