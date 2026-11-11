import { ask } from "@tauri-apps/plugin-dialog";

/** Whether the user gives up unsaved changes, asked with the native dialog or, without it, the browser's. */
export async function confirmDiscard(message: string): Promise<boolean> {
  try {
    return await ask(message, { title: "Unsaved changes", kind: "warning", okLabel: "Discard" });
  } catch {
    return window.confirm(message);
  }
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
