// For tests of what asks about unsaved HTML edits (see `askUnsaved` in ../store/confirm.ts): the
// question is asked in the app, so a test answers it as the dialog's buttons would.
import { expect, vi } from "vitest";

import type { UnsavedAnswer } from "../store/confirm";

/** The store holding the open question, as loaded now (a test may have reset the modules). */
const questions = async () => (await import("../store/confirm")).useUnsavedQuestion;

/** Waits for the question about unsaved edits and answers it; resolves to the file it named. */
export async function answerUnsaved(answer: UnsavedAnswer): Promise<string> {
  const store = await questions();
  await vi.waitFor(() => expect(store.getState().question).not.toBeNull());
  const question = store.getState().question!;
  question.answer(answer);
  return question.name;
}

/** Whether a question about unsaved edits is open. */
export async function unsavedAsked(): Promise<boolean> {
  return (await questions()).getState().question !== null;
}
