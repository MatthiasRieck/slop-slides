import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";

/**
 * Asks for the user's attention while they are in another window: the dock icon bounces once, or
 * the taskbar button lights up, until the app's window is used again. Does nothing while the
 * window has the focus, and nothing where the system has no such thing.
 */
export function requestAttention() {
  if (typeof document === "undefined" || document.hasFocus()) return;
  void Promise.resolve()
    .then(() => getCurrentWindow().requestUserAttention(UserAttentionType.Informational))
    .catch(() => {
      // Being noticed is a courtesy: a window that cannot ask goes without.
    });
}
