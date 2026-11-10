import { errorMessage } from "../../lib/api";
import { useApp } from "../../store";

/** Shows what went wrong in the app's error banner, after `prefix` when there is one. */
export function showError(error: unknown, prefix = "") {
  useApp.getState().setError(prefix + errorMessage(error));
}

/** Runs `action`, showing what goes wrong in the app's error banner; undefined when it failed. */
export async function reportingErrors<T>(action: () => Promise<T>, prefix = ""): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    showError(error, prefix);
    return undefined;
  }
}
