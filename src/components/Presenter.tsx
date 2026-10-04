import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";

import { deckFileUrl } from "../lib/utils";
import { useApp } from "../store";

/**
 * Full-screen slideshow. Plays deck.html with its own embedded player (the same thing
 * anyone you share the file with sees), starting at the selected slide.
 */
export function Presenter() {
  const deck = useApp((s) => s.deck);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Start where the editor is; afterwards the player owns navigation.
  const startRef = useRef(useApp.getState().selected);

  useEffect(() => {
    const window_ = getCurrentWindow();
    void window_.setFullscreen(true);
    const exit = () => useApp.getState().setPresenting(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") exit();
      else frameRef.current?.focus();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.data?.type === "slop:key" && event.data.key === "Escape") exit();
      // Keep the editor's selection in step so leaving the show lands on the same slide.
      if (event.data?.type === "slop:slide" && event.data.id) useApp.getState().select(String(event.data.id));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
      void window_.setFullscreen(false);
    };
  }, []);

  if (!deck) return null;
  const hash = startRef.current ? `#${encodeURIComponent(startRef.current)}` : "";
  return (
    <div className="fixed inset-0 z-50 bg-black">
      <iframe
        ref={frameRef}
        title="Presentation"
        src={`${deckFileUrl(deck.id, "deck.html", `v=${deck.shellHash}`)}${hash}`}
        sandbox="allow-scripts"
        onLoad={(event) => event.currentTarget.focus()}
        className="size-full border-0"
      />
    </div>
  );
}
