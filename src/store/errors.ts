// Telling the user what happened, in the app's toasts: what went wrong (it stays until dismissed),
// and what there is to know or what worked (they go away by themselves). The slices pass in the
// store they get; the rest of the app uses the versions bound to `useApp` that ../store.ts exports.
import { errorMessage } from "../lib/api";
import type { AppState, AppStore } from "./types";
import type { ToastAction } from "./ui";

/** Shows what went wrong in `app`'s toasts, after `prefix` when there is one. */
export function showErrorIn(app: AppStore, error: unknown, prefix = ""): void {
  app.getState().showToast("error", prefix + errorMessage(error));
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
  prefix = "",
): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    showErrorIn(app, error, prefix);
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
