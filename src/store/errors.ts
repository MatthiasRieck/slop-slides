// Telling the user what happened, in the app's toasts: what went wrong (it stays until dismissed),
// and what there is to know or what worked (they go away by themselves). The slices pass in the
// store they get; the rest of the app uses the versions bound to `useApp` that ../store.ts exports.
import { errorMessage } from "../lib/api";
import type { AppState, AppStore } from "./types";
import type { ToastAction } from "./ui";

/** What an error toast says beyond the error itself. */
export interface ErrorAbout {
  /** What was being done, as the start of the sentence: "Could not open the deck". */
  doing?: string;
  /** A way on from it, as a button in the toast: Retry, Open settings. */
  action?: ToastAction;
  /** Whether it is about the running slide show, and so shows during it (the others wait for its end). */
  duringShow?: boolean;
}

/** What is said when an error brings nothing a person can read. */
export const UNREADABLE_ERROR = "Something unexpected went wrong";

/** Past this length an error is no sentence any more: its first line shows, the rest on request. */
const LONG_ERROR = 400;

const firstLine = (text: string) => text.split("\n", 1)[0]!.trim();

/** The message inside a service's JSON answer, wherever the common shapes keep it. */
function messageIn(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { error, message, detail } = body as Record<string, unknown>;
  for (const candidate of [message, error, detail]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return messageIn(error);
}

/**
 * An error as a person reads it: `text` is the sentence to show, and `details` the whole raw
 * message when `text` is only its gist. An ordinary message is shown as it is. A service's raw
 * answer (a JSON body, an HTML page), a stack trace or a wall of text never is: what it says in
 * words is picked out of it, and the rest waits behind the toast's Details.
 */
export function readableError(error: unknown): { text: string; details?: string } {
  const raw = errorMessage(error).trim();
  if (!raw) return { text: UNREADABLE_ERROR };
  // What comes before the raw part says what failed: "API error 429: {…}".
  const lead = (to: number) =>
    raw
      .slice(0, to)
      .trim()
      .replace(/[:\s]+$/, "");
  const brace = raw.indexOf("{");
  if (brace >= 0) {
    try {
      const said = messageIn(JSON.parse(raw.slice(brace)));
      const text = [lead(brace), said].filter(Boolean).join(": ");
      return { text: text || UNREADABLE_ERROR, details: raw };
    } catch {
      // Braces in an ordinary sentence.
    }
  }
  const page = raw.search(/<(!doctype|html)\b/i);
  if (page >= 0) return { text: lead(page) || UNREADABLE_ERROR, details: raw };
  if (/\n\s+at /.test(raw) || raw.length > LONG_ERROR) {
    const line = firstLine(raw);
    return { text: line.length > LONG_ERROR ? `${line.slice(0, LONG_ERROR)}…` : line, details: raw };
  }
  return { text: raw };
}

/**
 * Shows what went wrong in `app`'s toasts, as "what was being done: what happened" when `about`
 * says what was being done, with the button it offers. A plain string is put before the message
 * as it is. What the error says is made readable first (see `readableError`).
 */
export function showErrorIn(app: AppStore, error: unknown, about: string | ErrorAbout = ""): void {
  const { text, details } = readableError(error);
  const { doing, action, duringShow } = typeof about === "string" ? ({} as ErrorAbout) : about;
  const said = typeof about === "string" ? about + text : doing ? `${doing}: ${text}` : text;
  const more = { ...(details !== undefined && { details }), ...(duringShow && { duringShow }) };
  app.getState().showToast("error", said, action, Object.keys(more).length > 0 ? more : undefined);
}

/** Tells the user something worth knowing that is no failure; `action` is a button to act on it. */
export function showInfoIn(app: AppStore, text: string, action?: ToastAction): void {
  app.getState().showToast("info", text, action);
}

/** Tells the user that something they asked for is done; `action` is a button to go on from it. */
export function showSuccessIn(app: AppStore, text: string, action?: ToastAction): void {
  app.getState().showToast("success", text, action);
}

/** Runs `action`, showing what goes wrong in `app`'s toasts; undefined when it failed. */
export async function reportingErrorsIn<T>(
  app: AppStore,
  action: () => Promise<T>,
  about: string | ErrorAbout = "",
): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    showErrorIn(app, error, about);
    return undefined;
  }
}

/** The error shown last and not dismissed yet; null when none is. */
export function lastError(state: Pick<AppState, "toasts">): string | null {
  return state.toasts.findLast((toast) => toast.kind === "error")?.text ?? null;
}

/** What the toasts of `kind` say, oldest first. */
export function toastTexts(state: Pick<AppState, "toasts">, kind: "info" | "success"): string[] {
  return state.toasts.filter((toast) => toast.kind === kind).map((toast) => toast.text);
}
