import { ask } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";

/** Whether the user gives up unsaved changes, asked with the native dialog or, without it, the browser's. */
export async function confirmDiscard(message: string): Promise<boolean> {
  try {
    return await ask(message, { title: "Unsaved changes", kind: "warning", okLabel: "Discard" });
  } catch {
    return window.confirm(message);
  }
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

/** Whether the user stops the agent's running turn, which `message` says leaving would take. */
export async function confirmStopAgent(message: string): Promise<boolean> {
  try {
    return await ask(message, {
      title: "The agent is still working",
      kind: "warning",
      okLabel: "Stop the agent",
      cancelLabel: "Cancel",
    });
  } catch {
    return window.confirm(message);
  }
}
