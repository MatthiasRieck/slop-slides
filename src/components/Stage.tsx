import { AlertTriangle, Check, ChevronLeft, ChevronRight, Maximize, Pencil, Redo2, Sparkles, Undo2, Wand2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { SKETCH_TARGET_ATTR, useApp } from "../store";
import { AnnotationLayer, useAnnotations } from "./PresenterTools";
import { SketchToolbar } from "./SketchToolbar";
import { SlideFrame, useSlideVersion } from "./SlideFrame";
import type { Slide } from "../lib/api";
import { cn } from "../lib/utils";

/** The stage area's padding (Tailwind p-8), which the editor's pasteboard covers too. */
const AREA_PADDING = 32;

/** The current slide, fit to the available space with letterboxing. */
export function Stage() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const sketches = useApp((s) => s.sketches);
  const editing = useApp((s) => s.editing);
  const running = useApp((s) => s.running);
  const canUndo = useApp((s) => s.slideUndo.length > 0);
  const canRedo = useApp((s) => s.slideRedo.length > 0);
  const annotations = useAnnotations(selected ?? "", { ink: sketches, setInk: useApp.getState().setSketches });
  const areaRef = useRef<HTMLDivElement>(null);
  const editFrames = useSlideEditing(areaRef);
  const overflow = editFrames.overflow;
  const view = editFrames.view;
  const [width, setWidth] = useState(0);
  // While editing, the preview fills the whole area around the slide: an endless pasteboard.
  const [arena, setArena] = useState<{ width: number; height: number } | undefined>();

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width: w, height: h } = entry.contentRect;
      setWidth(Math.max(0, Math.min(w, (h * 16) / 9)));
      setArena({ width: w + 2 * AREA_PADDING, height: h + 2 * AREA_PADDING });
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
      <div ref={areaRef} className="relative flex min-h-0 flex-1 items-center justify-center p-8">
        {slide && editing && (
          <span className="pointer-events-none absolute top-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground shadow-sm [&_svg]:size-3">
            <Pencil />
            Editing
          </span>
        )}
        {slide ? (
          <div
            style={{ width }}
            {...{ [SKETCH_TARGET_ATTR]: "" }}
            data-editing={editing || undefined}
            className={cn(
              "relative shadow-[0_20px_50px_-24px_rgb(0_0_0/0.45)] ring-1 ring-border",
              !editing && "overflow-hidden rounded-lg",
              editing && "ring-2 ring-primary ring-offset-4 ring-offset-canvas",
            )}
          >
            <CurrentSlide deckId={deck.id} slide={slide} editing={editing} arena={arena} canvas={areaRef} onFrameReady={editFrames.onFrameReady} />
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
                  title="Edit the slide: click to select, drag to move, drag the handles to scale or rotate, double-click to edit text"
                  aria-pressed={editing}
                  onClick={toggleEditing}
                  className={cn(
                    "rounded-md p-1 hover:bg-accent hover:text-foreground [&_svg]:size-4",
                    editing && "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
                  )}
                >
                  <Pencil />
                </button>
                <div className="mx-1 h-4 w-px bg-border" />
                {editing ? (
                  <EditBar canUndo={canUndo} canRedo={canRedo} />
                ) : (
                  <SketchToolbar annotations={annotations} />
                )}
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
            {view && (
              <button
                type="button"
                title="Back to the slide, centered at full size (0)"
                onClick={editFrames.resetView}
                className="mr-1 flex items-center gap-1 rounded-md px-1.5 py-1 tabular-nums hover:bg-accent hover:text-foreground"
              >
                <Maximize className="size-3.5" />
                {Math.round(view.k * 100)}%
              </button>
            )}
            {overflow.length > 0 && (
              <span
                title={`Runs past the slide or is cut off:\n${overflow.join("\n")}`}
                className="mr-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-amber-600 dark:text-amber-400"
              >
                <AlertTriangle className="size-3.5" />
                Overflow
              </span>
            )}
            {slide && (
              <button
                type="button"
                title="Ask the agent to rebuild this slide's layout, fixing overflow and clipping and keeping the elements you moved, rotated or scaled, using a screenshot"
                disabled={running}
                onClick={() => {
                  editFrames.clearSelection();
                  // Give the preview a frame to drop its selection outline before the screenshot.
                  requestAnimationFrame(() => requestAnimationFrame(() => void useApp.getState().tidyLayout(overflow)));
                }}
                className={cn(
                  "flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
                  (slide.moved || overflow.length > 0) && "font-medium text-foreground",
                )}
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

/** Shown in place of the sketch tools while editing: history and leaving edit mode. */
function EditBar(props: { canUndo: boolean; canRedo: boolean }) {
  const icon = "rounded-md p-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-4";
  const app = useApp.getState;
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <button type="button" aria-label="Undo" title="Undo (⌘Z)" disabled={!props.canUndo} onClick={() => void app().undoSlideEdit()} className={icon}>
        <Undo2 />
      </button>
      <button type="button" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!props.canRedo} onClick={() => void app().redoSlideEdit()} className={icon}>
        <Redo2 />
      </button>
      <div className="mx-1 h-4 w-px bg-border" />
      <button
        type="button"
        title="Undo all edits made since entering edit mode"
        onClick={() => void app().discardSlideEdits()}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
      >
        <X />
        Discard
      </button>
      <button
        type="button"
        title="Keep the edits and leave edit mode (Esc)"
        onClick={() => app().setEditing(false)}
        className="flex items-center gap-1 rounded-md bg-primary px-1.5 py-1 font-medium text-primary-foreground hover:bg-primary/90 [&_svg]:size-3.5"
      >
        <Check />
        Accept
      </button>
    </div>
  );
}

function CurrentSlide(props: {
  deckId: string;
  slide: Slide;
  editing: boolean;
  /** The panel around the slide; its color dims what lies outside the slide in the editor. */
  canvas: React.RefObject<HTMLElement | null>;
  arena?: { width: number; height: number };
  onFrameReady: (frame: HTMLIFrameElement) => void;
}) {
  const editReload = useApp((s) => s.editReload);
  return (
    <SlideFrame
      deckId={props.deckId}
      slideId={props.slide.id}
      version={useSlideVersion(props.slide)}
      editKey={props.editing ? String(editReload) : undefined}
      arena={props.arena}
      onFrameReady={(frame) => {
        if (props.editing && props.canvas.current) {
          const color = getComputedStyle(props.canvas.current.parentElement ?? props.canvas.current).backgroundColor;
          frame.contentWindow?.postMessage({ type: "slop:edit-canvas", color }, "*");
        }
        props.onFrameReady(frame);
      }}
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
  const [overflow, setOverflow] = useState<{ slide: string; items: string[] } | null>(null);
  // How the editor has panned and zoomed its pasteboard; kept to put it back after each reload.
  const [view, setView] = useState<EditView | null>(null);

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
      } else if (data?.type === "slop:edit-overflow" && data.slide === selected && Array.isArray(data.items)) {
        setOverflow({ slide: data.slide, items: data.items.map(String) });
      } else if (data?.type === "slop:edit-view" && data.slide === selected && [data.x, data.y, data.k].every(Number.isFinite)) {
        setView({ slide: data.slide, x: data.x, y: data.y, k: data.k });
      } else if (data?.type === "slop:key") {
        if (data.mod) runHistoryKey(String(data.key), Boolean(data.shift));
        else if (data.key === "Escape") useApp.getState().setEditing(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!useApp.getState().editing || target?.closest("input, textarea, [contenteditable]")) return;
      if ((event.metaKey || event.ctrlKey) && runHistoryKey(event.key, event.shiftKey)) event.preventDefault();
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey);
    };
  }, [areaRef]);

  const current = useApp((s) => s.selected);
  const editing = useApp((s) => s.editing);

  // Each visit to a slide's editor starts with the slide centered.
  useEffect(() => {
    setView(null);
  }, [current, editing]);

  const shown = editing && view?.slide === current ? view : null;
  const resetView = () => frame.current?.contentWindow?.postMessage({ type: "slop:edit-camera", home: true }, "*");

  return {
    overflow: editing && overflow?.slide === current ? overflow.items : NO_OVERFLOW,
    view: shown && !(shown.x === 0 && shown.y === 0 && shown.k === 1) ? shown : null,
    resetView,
    onFrameReady: (loaded: HTMLIFrameElement) => {
      frame.current = loaded;
      const { editing, selected } = useApp.getState();
      if (!editing) return;
      if (view?.slide === selected) {
        loaded.contentWindow?.postMessage({ type: "slop:edit-camera", x: view.x, y: view.y, k: view.k }, "*");
      }
      const again = restore.current;
      if (again && again.slide === selected) {
        loaded.contentWindow?.postMessage({ type: "slop:edit-select", path: again.path }, "*");
      }
    },
    // Takes the selection, wires and any panning out of the preview, for a screenshot of just the slide.
    clearSelection: () => {
      restore.current = null;
      resetView();
      frame.current?.contentWindow?.postMessage({ type: "slop:edit-select", path: null, quiet: true }, "*");
    },
  };
}

const NO_OVERFLOW: string[] = [];

/** The editor's pasteboard: pan in slide pixels and zoom, relative to the slide centered at full size. */
interface EditView {
  slide: string;
  x: number;
  y: number;
  k: number;
}

/** ⌘Z undoes, ⇧⌘Z / ⌘Y redo; true when the key was one of them. */
function runHistoryKey(key: string, shift: boolean) {
  const lower = key.toLowerCase();
  if (lower === "z" && !shift) void useApp.getState().undoSlideEdit();
  else if ((lower === "z" && shift) || lower === "y") void useApp.getState().redoSlideEdit();
  else return false;
  return true;
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
