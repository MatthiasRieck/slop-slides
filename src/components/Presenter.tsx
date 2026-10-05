import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";

import { deckFileUrl } from "../lib/utils";
import { useApp } from "../store";
import { AnnotationLayer, PresenterToolbar, useAnnotations } from "./PresenterTools";

/**
 * Full-screen slideshow. Plays deck.html with its own embedded player (the same thing
 * anyone you share the file with sees), starting at the selected slide. On top sit the
 * presenter's tools: laser pointer, pen, highlighter and eraser.
 */
export function Presenter() {
  const deck = useApp((s) => s.deck);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Start where the editor is; afterwards the player owns navigation.
  const startRef = useRef(useApp.getState().selected);
  // Ink belongs to the slide it was drawn on; the player reports each slide by position.
  const [slideKey, setSlideKey] = useState("");
  const annotations = useAnnotations(slideKey);
  const handleKeyRef = useRef(annotations.handleKey);
  handleKeyRef.current = annotations.handleKey;

  useEffect(() => {
    const window_ = getCurrentWindow();
    void window_.setFullscreen(true);
    const exit = () => useApp.getState().setPresenting(false);
    /** Tool shortcuts first; Escape puts a tool away before it ends the show. */
    const handle = (key: string, mod: boolean) => {
      if (handleKeyRef.current(key, mod)) return true;
      if (key === "Escape") {
        exit();
        return true;
      }
      return false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (handle(event.key, event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        return;
      }
      // Focus is here after drawing or using the toolbar: pass the key on to the player.
      const frame = frameRef.current;
      frame?.contentWindow?.postMessage({ type: "slop:go", key: event.key }, "*");
      frame?.focus();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.data?.type === "slop:key") handle(String(event.data.key), Boolean(event.data.mod));
      if (event.data?.type === "slop:slide") {
        if (typeof event.data.index === "number") setSlideKey(String(event.data.index));
        // Keep the editor's selection in step so leaving the show lands on the same slide.
        if (event.data.id) useApp.getState().select(String(event.data.id));
      }
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
      <AnnotationLayer annotations={annotations} />
      <PresenterToolbar annotations={annotations} onExit={() => useApp.getState().setPresenting(false)} />
    </div>
  );
}
