import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useApp } from "../store";
import { SlideFrame } from "./SlideFrame";

const NEXT = new Set(["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"]);
const PREV = new Set(["ArrowLeft", "ArrowUp", "PageUp", "Backspace"]);

/** Full-screen slideshow of the open deck, starting at the selected slide. */
export function Presenter() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const areaRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width: w, height: h } = entry.contentRect;
      setWidth(Math.min(w, (h * 16) / 9));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const window_ = getCurrentWindow();
    void window_.setFullscreen(true);
    const exit = () => useApp.getState().setPresenting(false);
    const handle = (key: string) => {
      if (NEXT.has(key)) useApp.getState().selectRelative(1);
      else if (PREV.has(key)) useApp.getState().selectRelative(-1);
      else if (key === "Escape") exit();
    };
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      handle(event.key);
    };
    // Keys pressed while a slide iframe has focus are forwarded by the injected stage script.
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "slop:key") handle(String(event.data.key));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
      void window_.setFullscreen(false);
    };
  }, []);

  if (!deck || !selected) return null;
  return (
    <div
      ref={areaRef}
      className="fixed inset-0 z-50 flex cursor-none items-center justify-center bg-black"
      onClick={() => useApp.getState().selectRelative(1)}
    >
      <div style={{ width }} className="pointer-events-none">
        <SlideFrame key={selected} deckId={deck.id} slide={selected} />
      </div>
    </div>
  );
}
