import { ask } from "@tauri-apps/plugin-dialog";

/** Whether the user gives up unsaved changes, asked with the native dialog or, without it, the browser's. */
export async function confirmDiscard(message: string): Promise<boolean> {
  try {
    return await ask(message, { title: "Unsaved changes", kind: "warning", okLabel: "Discard" });
  } catch {
    return window.confirm(message);
  }
}
