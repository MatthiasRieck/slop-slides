import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

import { api } from "../../lib/api";
import { showError, useApp } from "../../store";

// Placing the show on its screens and closing the presenter view run one after the other, in
// the order asked: they take a moment off the main thread, and a show can end as it starts.
let placing: Promise<unknown> = Promise.resolve();
function inOrder<T>(command: () => Promise<T>): Promise<T> {
  const run = placing.then(command);
  placing = run.catch(() => {});
  return run;
}

/**
 * Puts the show where it is to be seen while the component using it is there, and back after.
 * With several screens, the show first moves to the one picked (and the presenter view opens).
 * In windows, it stays as it is and the presenter view opens beside it. Otherwise, it goes full
 * screen.
 */
export function useShowPlacement() {
  useEffect(() => {
    const window_ = getCurrentWindow();
    const screens = useApp.getState().screens;
    const windowed = screens === "windows";
    let ended = false;
    let placed = false;
    if (windowed) {
      queueMicrotask(() => {
        if (ended) return;
        placed = true;
        inOrder(() => api.presentInWindows()).catch((error) => showError(error));
      });
    } else if (screens) {
      // A moment later: StrictMode runs this twice in dev, and closing a presenter view that
      // macOS is still taking full screen makes the system beep.
      queueMicrotask(() => {
        if (ended) return;
        placed = true;
        inOrder(() => api.presentOn(screens.audience, screens.presenter))
          .catch((error) => showError(error))
          .finally(() => {
            if (!ended) void window_.setFullscreen(true);
          });
      });
    } else {
      void window_.setFullscreen(true);
    }
    return () => {
      ended = true;
      if (!windowed) void window_.setFullscreen(false);
      if (placed) void inOrder(() => api.closePresenterView()).catch(() => {});
    };
  }, []);
}
