// The questions the app asks before doing what cannot be taken back, all asked in the app's own
// dialog (components/ConfirmDialog.tsx and components/UnsavedChanges.tsx), never in a native alert.
// What the deck's history can undo is not asked about: it is done, with Undo offered in a toast.
import { create } from "zustand";

/** A yes-or-no question: what is about to happen, and what the two buttons say. */
export interface ConfirmOptions {
  /** The question, as the dialog's heading: "Delete your recording?". */
  title: string;
  /** What saying yes does, and what is lost by it. */
  message: string;
  /** The button that goes ahead, named by what it does: "Delete", not "OK". */
  confirmLabel: string;
  /** The button that stays; "Cancel" unless given. */
  cancelLabel?: string;
  /** Whether going ahead deletes or discards something: the button warns with its color. */
  destructive?: boolean;
}

/** A question that is open, for the dialog that asks it. */
export interface ConfirmQuestion extends ConfirmOptions {
  answer: (confirmed: boolean) => void;
}

/** The question the dialog shows (null while none is asked), and those waiting for their turn behind it. */
export const useConfirmQuestion = create<{ question: ConfirmQuestion | null; waiting: ConfirmQuestion[] }>(() => ({
  question: null,
  waiting: [],
}));

/**
 * Asks the user, in the app, whether to go ahead; true when they do. Escape and the cancel button
 * are a no. Questions asked while one is open wait for their turn, in the order they were asked.
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const question: ConfirmQuestion = {
      ...options,
      answer: (confirmed) => {
        const { question: open, waiting } = useConfirmQuestion.getState();
        // Answered once: a second press of a button changes nothing.
        if (open !== question) return;
        const [next = null, ...rest] = waiting;
        useConfirmQuestion.setState({ question: next, waiting: rest });
        resolve(confirmed);
      },
    };
    const { question: open, waiting } = useConfirmQuestion.getState();
    useConfirmQuestion.setState(open ? { waiting: [...waiting, question] } : { question });
  });
}

/** Whether the user gives up unsaved changes, which `message` says leaving would lose. */
export function confirmDiscard(message: string): Promise<boolean> {
  return confirmAction({ title: "Unsaved changes", message, confirmLabel: "Discard", destructive: true });
}

/** Whether the user stops the agent's running turn, which `message` says leaving would take. */
export function confirmStopAgent(message: string): Promise<boolean> {
  return confirmAction({
    title: "The agent is still working",
    message,
    confirmLabel: "Stop the agent",
    cancelLabel: "Cancel",
    destructive: true,
  });
}

/** What the user does about unsaved edits that leaving would lose: save them, give them up, or stay. */
export type UnsavedAnswer = "save" | "discard" | "cancel";

/** The question about unsaved edits that is open, for the dialog that asks it (components/UnsavedChanges.tsx). */
export interface UnsavedQuestion {
  /** The file the edits are to, as the question names it. */
  name: string;
  answer: (answer: UnsavedAnswer) => void;
}

/** The open question about unsaved edits; null while none is asked. */
export const useUnsavedQuestion = create<{ question: UnsavedQuestion | null }>(() => ({ question: null }));

/**
 * Asks, in the app, what to do about the unsaved edits to `name`. One question is open at a
 * time: asked again meanwhile, the first is answered as cancelled.
 */
export function askUnsaved(name: string): Promise<UnsavedAnswer> {
  useUnsavedQuestion.getState().question?.answer("cancel");
  return new Promise((resolve) => {
    const question: UnsavedQuestion = {
      name,
      answer: (answer) => {
        // Answered once: a second press of a button changes nothing.
        if (useUnsavedQuestion.getState().question !== question) return;
        useUnsavedQuestion.setState({ question: null });
        resolve(answer);
      },
    };
    useUnsavedQuestion.setState({ question });
  });
}
