import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronLeft, ChevronRight, Maximize } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { zoomBox } from "../lib/ink";
import { cn, fileUrl } from "../lib/utils";
import { useApp } from "../store";
import { AnnotationLayer, PresenterToolbar, useAnnotations, useReveal } from "./PresenterTools";

/**
 * Full-screen slideshow. Plays the deck file with its own embedded player (the same thing
 * anyone you share the file with sees), starting at the selected slide. On top sit the
 * presenter's tools: laser pointer, pen, highlighter and eraser. With `show`, the backend adds
 * the pasteboard (src-tauri/assets/pasteboard.js), so the slide can be zoomed with the mouse
 * wheel or a pinch and panned with a swipe or the middle button; 0 fits it again.
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
  // How the slide is zoomed and panned; the ink goes along with it.
  const [zoom, setZoom] = useState({ x: 0, y: 0, k: 1 });
  const nav = useReveal(annotations.peek);
  const moved = !(zoom.x === 0 && zoom.y === 0 && zoom.k === 1);

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
      if (key === "0" && !mod) {
        fitSlide(frameRef.current);
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
      if (event.data?.type === "slop:zoom") {
        const { x, y, k } = event.data;
        if ([x, y, k].every(Number.isFinite)) setZoom({ x, y, k });
      }
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
        src={`${fileUrl(deck.id, `v=${deck.shellHash}&show`)}${hash}`}
        sandbox="allow-scripts"
        onLoad={(event) => event.currentTarget.focus()}
        className="size-full border-0"
      />
      <div
        data-testid="annotation-zoom"
        className="pointer-events-none absolute"
        style={zoomBox(zoom.x, zoom.y, zoom.k)}
      >
        <AnnotationLayer annotations={annotations} zoom={zoom.k} />
      </div>
      {moved && (
        <button
          type="button"
          title="Back to the slide, fit to the screen (0)"
          // Keep keyboard focus where it was, so Space still advances the slide.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => fitSlide(frameRef.current)}
          className="absolute right-32 bottom-4 z-10 flex items-center gap-1.5 rounded-xl border border-white/10 bg-neutral-900/85 px-2.5 py-1.5 text-xs text-white/80 tabular-nums shadow-lg backdrop-blur hover:text-white [&_svg]:size-3.5"
        >
          <Maximize />
          {Math.round(zoom.k * 100)}%
        </button>
      )}
      <div data-testid="nav-zone" className="absolute right-0 bottom-0 z-10 flex gap-1 p-4" {...nav.zoneProps}>
        {(
          [
            ["Previous slide", "ArrowLeft", ChevronLeft],
            ["Next slide", "ArrowRight", ChevronRight],
          ] as const
        ).map(([label, key, Icon]) => (
          <button
            key={key}
            type="button"
            title={label}
            aria-label={label}
            // Keep keyboard focus where it was, so Space still advances the slide.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => frameRef.current?.contentWindow?.postMessage({ type: "slop:go", key }, "*")}
            data-visible={nav.visible}
            className={cn(
              "flex size-9 items-center justify-center rounded-xl border border-white/10 bg-neutral-900/85 text-white/80 shadow-lg backdrop-blur transition-opacity duration-200 hover:text-white [&_svg]:size-5",
              nav.visible ? "opacity-100" : "opacity-0",
            )}
          >
            <Icon />
          </button>
        ))}
      </div>
      <PresenterToolbar annotations={annotations} onExit={() => useApp.getState().setPresenting(false)} />
    </div>
  );
}

/** Asks the show's pasteboard to fit the slide to the screen again. */
function fitSlide(frame: HTMLIFrameElement | null) {
  frame?.contentWindow?.postMessage({ type: "slop:camera", home: true }, "*");
}
