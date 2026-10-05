import { ChevronLeft, ChevronRight, Move, Sparkles, Wand2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { SKETCH_TARGET_ATTR, useApp } from "../store";
import { AnnotationLayer, useAnnotations } from "./PresenterTools";
import { SketchToolbar } from "./SketchToolbar";
import { SlideFrame, useSlideVersion } from "./SlideFrame";
import type { Slide } from "../lib/api";
import { cn } from "../lib/utils";

/** The current slide, fit to the available space with letterboxing. */
export function Stage() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const sketches = useApp((s) => s.sketches);
  const editing = useApp((s) => s.editing);
  const running = useApp((s) => s.running);
  const annotations = useAnnotations(selected ?? "", { ink: sketches, setInk: useApp.getState().setSketches });
  const areaRef = useRef<HTMLDivElement>(null);
  const editFrames = useSlideEditing(areaRef);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width: w, height: h } = entry.contentRect;
      setWidth(Math.max(0, Math.min(w, (h * 16) / 9)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useSlideKeyboard();
  useSketchKeyboard(annotations.tool !== "pointer", () => annotations.setTool("pointer"));

  // Drawing and editing take turns: picking a pen leaves edit mode.
  useEffect(() => {
    if (annotations.tool !== "pointer") useApp.getState().setEditing(false);
  }, [annotations.tool]);
  const toggleEditing = () => {
    if (!editing) annotations.setTool("pointer");
    useApp.getState().setEditing(!editing);
  };

  if (!deck) return null;
  const index = deck.slides.findIndex((s) => s.id === selected);
  const slide = deck.slides[index];

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center p-8">
        {slide ? (
          <div
            style={{ width }}
            {...{ [SKETCH_TARGET_ATTR]: "" }}
            className="relative overflow-hidden rounded-lg shadow-[0_20px_50px_-24px_rgb(0_0_0/0.45)] ring-1 ring-border"
          >
            <CurrentSlide deckId={deck.id} slide={slide} editing={editing} onFrameReady={editFrames.onFrameReady} />
            <AnnotationLayer annotations={annotations} />
          </div>
        ) : (
          <EmptyStage />
        )}
      </div>
      {deck.slides.length > 0 && (
        <div className="grid h-10 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 text-xs text-muted-foreground">
          <div className="flex min-w-0 items-center gap-0.5">
            {slide && (
              <>
                <button
                  type="button"
                  aria-label="Edit text and move elements"
                  title="Edit text and move elements: click to select, drag to move, double-click to edit text"
                  aria-pressed={editing}
                  onClick={toggleEditing}
                  className={cn(
                    "rounded-md p-1 hover:bg-accent hover:text-foreground [&_svg]:size-4",
                    editing && "bg-accent text-foreground",
                  )}
                >
                  <Move />
                </button>
                <div className="mx-1 h-4 w-px bg-border" />
                <SketchToolbar annotations={annotations} />
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Previous slide"
              onClick={() => useApp.getState().selectRelative(-1)}
              disabled={index <= 0}
              className="rounded-md p-1 hover:bg-accent hover:text-foreground disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="tabular-nums">
              {index + 1} / {deck.slides.length}
            </span>
            <button
              type="button"
              aria-label="Next slide"
              onClick={() => useApp.getState().selectRelative(1)}
              disabled={index >= deck.slides.length - 1}
              className="rounded-md p-1 hover:bg-accent hover:text-foreground disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
          <div className="flex min-w-0 items-center justify-end">
            {slide?.moved && (
              <button
                type="button"
                title="Ask the agent to rebuild this slide's layout around the elements you moved, using a screenshot"
                disabled={running}
                onClick={() => {
                  editFrames.clearSelection();
                  // Give the preview a frame to drop its selection outline before the screenshot.
                  requestAnimationFrame(() => requestAnimationFrame(() => void useApp.getState().tidyLayout()));
                }}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <Wand2 className="size-3.5" />
                Tidy layout
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CurrentSlide(props: {
  deckId: string;
  slide: Slide;
  editing: boolean;
  onFrameReady: (frame: HTMLIFrameElement) => void;
}) {
  const editReload = useApp((s) => s.editReload);
  return (
    <SlideFrame
      deckId={props.deckId}
      slideId={props.slide.id}
      version={useSlideVersion(props.slide)}
      editKey={props.editing ? String(editReload) : undefined}
      onFrameReady={props.onFrameReady}
    />
  );
}

/**
 * Connects the stage to the slide editor running in its preview (src-tauri/assets/editor.js):
 * saves the markup it posts, keeps the selection across the reload that follows, and
 * handles undo and leaving edit mode.
 */
function useSlideEditing(areaRef: React.RefObject<HTMLDivElement | null>) {
  // What to select again once the edited slide reloads.
  const restore = useRef<{ slide: string; path: number[] } | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const fromStage = (source: MessageEventSource | null) =>
      Array.from(areaRef.current?.querySelectorAll("iframe") ?? []).some((f) => f.contentWindow === source);
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      const { editing, selected } = useApp.getState();
      if (!editing || !fromStage(event.source)) return;
      if (data?.type === "slop:edit-commit" && data.slide === selected && typeof data.markup === "string") {
        restore.current = Array.isArray(data.select) ? { slide: data.slide, path: data.select } : null;
        void useApp.getState().saveSlideEdit(data.slide, data.markup);
      } else if (data?.type === "slop:key") {
        if (data.mod && String(data.key).toLowerCase() === "z") void useApp.getState().undoSlideEdit();
        else if (data.key === "Escape") useApp.getState().setEditing(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!useApp.getState().editing || target?.closest("input, textarea, [contenteditable]")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        void useApp.getState().undoSlideEdit();
      }
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey);
    };
  }, [areaRef]);

  return {
    onFrameReady: (loaded: HTMLIFrameElement) => {
      frame.current = loaded;
      const { editing, selected } = useApp.getState();
      const again = restore.current;
      if (editing && again && again.slide === selected) {
        loaded.contentWindow?.postMessage({ type: "slop:edit-select", path: again.path }, "*");
      }
    },
    clearSelection: () => {
      restore.current = null;
      frame.current?.contentWindow?.postMessage({ type: "slop:edit-select", path: null }, "*");
    },
  };
}

function EmptyStage() {
  return (
    <div className="flex max-w-sm flex-col items-center gap-3 text-center">
      <div className="rounded-full bg-accent p-3 text-muted-foreground">
        <Sparkles className="size-5" />
      </div>
      <h2 className="text-base font-medium">Start with a conversation</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Tell the agent what the presentation is about, who it is for, and how long it should be.
        Slides appear here as they are written.
      </p>
    </div>
  );
}

/** Escape puts a sketch tool away, unless the user is typing. */
function useSketchKeyboard(active: boolean, putAway: () => void) {
  const putAwayRef = useRef(putAway);
  putAwayRef.current = putAway;
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "Escape" || target?.closest("input, textarea, [contenteditable]")) return;
      if (useApp.getState().presenting) return;
      putAwayRef.current();
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}

/**
 * Arrow keys / PageUp / PageDown move between slides unless the user is typing. Also handles
 * keys the slide preview forwards as `slop:key` messages, so navigation keeps working after
 * clicking into the slide (which moves focus into its iframe).
 */
function useSlideKeyboard() {
  useEffect(() => {
    const navigate = (key: string) => {
      if (useApp.getState().presenting) return false;
      if (["ArrowDown", "ArrowRight", "PageDown"].includes(key)) useApp.getState().selectRelative(1);
      else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(key)) useApp.getState().selectRelative(-1);
      else return false;
      return true;
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      if (navigate(event.key)) event.preventDefault();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "slop:key") return;
      const fromSlide = Array.from(document.querySelectorAll("iframe")).some(
        (frame) => frame.contentWindow === event.source,
      );
      if (fromSlide) navigate(String(event.data.key));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, []);
}
