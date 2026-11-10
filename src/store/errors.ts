// Showing what went wrong in the app's error banner. The slices pass in the store they get; the
// rest of the app uses the versions bound to `useApp` that ../store.ts exports.
import { errorMessage } from "../lib/api";
import type { AppStore } from "./types";

/** Shows what went wrong in `app`'s error banner, after `prefix` when there is one. */
export function showErrorIn(app: AppStore, error: unknown, prefix = ""): void {
  app.setState({ error: prefix + errorMessage(error) });
}

/** Runs `action`, showing what goes wrong in `app`'s error banner; undefined when it failed. */
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
