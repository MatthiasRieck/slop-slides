import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

import { leaveForWindowClose, useApp } from "../store";
import { confirmDiscardDrawing } from "../svgStore";

/** The app's name, and its window's title with nothing open. */
export const APP_NAME = "SlopSlide";

/**
 * Whether the window may close: the user is asked about what closing it would lose, as when the
 * open file gives way to another (unsaved HTML edits, a drawing with changes not accepted, the
 * agent's running turn). False when they stay.
 */
export function confirmWindowClose(): Promise<boolean> {
  return leaveForWindowClose(confirmDiscardDrawing);
}

/** Keeps the window open when the user, asked what closing it would lose, stays (see {@link confirmWindowClose}). */
export function useCloseGuard() {
  useEffect(() => {
    let asking = false;
    const listening = getCurrentWindow().onCloseRequested(async (event) => {
      // Asked again while the question is still open, the window stays as well.
      if (asking) return event.preventDefault();
      asking = true;
      try {
        if (!(await confirmWindowClose())) event.preventDefault();
      } finally {
        asking = false;
      }
    });
    // Without a window to listen to (the browser preview), there is nothing to guard.
    const stop = listening.then(
      (unlisten) => unlisten,
      () => () => {},
    );
    return () => void stop.then((unlisten) => unlisten());
  }, []);
}

/** The window's title for what is open: the deck and its folder, the folder alone, or the app's name. */
export function windowTitle(deckTitle: string | null, workspaceName: string | null): string {
  if (!workspaceName) return APP_NAME;
  return deckTitle ? `${deckTitle} — ${workspaceName}` : workspaceName;
}

/** Names the window after what is open in it, so that several windows can be told apart. */
export function useWindowTitle() {
  const title = useApp((s) => windowTitle(s.deck?.title ?? null, s.workspace?.name ?? null));
  useEffect(() => {
    document.title = title;
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
  }, [title]);
}
