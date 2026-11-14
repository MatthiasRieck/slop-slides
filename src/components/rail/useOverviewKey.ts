import { useEffect } from "react";

import { keepsKey } from "../../lib/keys";
import { hasOpenLayer } from "../../lib/layers";
import { deckMode, useApp } from "../../store";

/** The key that shows every slide as a grid, and the stage again (a `formatKeys` spec). */
export const OVERVIEW_KEY = "g";

const isFrame = (source: MessageEventSource | null) =>
  Array.from(document.querySelectorAll("iframe")).some((frame) => frame.contentWindow === source);

/** Shows the grid of all slides, or the stage again; false where there is no stage to swap it with. */
function toggleOverview(): boolean {
  const app = useApp.getState();
  const mode = deckMode(app);
  if (!app.deck || app.deck.slides.length === 0 || app.presenting || (mode !== "view" && mode !== "edit")) return false;
  app.setOverview(!app.overview);
  return true;
}

/**
 * G shows every slide as a grid in the place of the stage, and the stage again: in View and in
 * Edit, pressed in the app or in the slide (whose preview forwards its keys as `slop:key`). Not
 * while typing, with a menu or dialog open, or during a show.
 */
export function useOverviewKey() {
  useEffect(() => {
    const isKey = (key: string) => key.toLowerCase() === OVERVIEW_KEY;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isKey(event.key)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return;
      if (keepsKey(event) || hasOpenLayer()) return;
      if (toggleOverview()) event.preventDefault();
    };
    const onMessage = (event: MessageEvent) => {
      const { type, key, mod, shift, alt } = event.data ?? {};
      if (type !== "slop:key" || typeof key !== "string" || !isKey(key) || mod || shift || alt) return;
      if (isFrame(event.source) && !hasOpenLayer()) toggleOverview();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, []);
}
