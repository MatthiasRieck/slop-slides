import { AlertTriangle, Check, ChevronLeft, ChevronRight, Maximize, Pencil, Redo2, Sparkles, Undo2, Wand2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { SKETCH_TARGET_ATTR, useApp } from "../store";
import { EditToolbar } from "./EditToolbar";
import { AnnotationLayer, useAnnotations } from "./PresenterTools";
import { SketchToolbar } from "./SketchToolbar";
import { SlideFrame, useSlideVersion } from "./SlideFrame";
import type { Slide } from "../lib/api";
import { EDIT_TOOL_KEYS, familyOf, familyOfKind, parseSelection, type EditSelection, type EditStyle, type EditTool } from "../lib/editTools";
import type { Stroke } from "../lib/ink";
import { cn } from "../lib/utils";

/** The stage area's padding (Tailwind p-8), which the pasteboard covers too. */
const AREA_PADDING = 32;
const STAGE_W = 1920;

/** The current slide, fit to the available space with letterboxing. */
export function Stage() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const sketches = useApp((s) => s.sketches);
  const reviewVisible = useApp((s) => s.reviewVisible);
  const editing = useApp((s) => s.editing);
  const running = useApp((s) => s.running);
  const canUndo = useApp((s) => s.slideUndo.length > 0);
  const canRedo = useApp((s) => s.slideRedo.length > 0);
  const editTool = useApp((s) => s.editTool);
  const editStyles = useApp((s) => s.editStyles);
  const annotations = useAnnotations(selected ?? "", {
    ink: reviewVisible ? sketches : NO_INK,
    setInk: useApp.getState().setSketches,
  });
  const areaRef = useRef<HTMLDivElement>(null);
  const pasteboard = usePasteboard(areaRef);
  const editFrames = useSlideEditing(areaRef, pasteboard.resetView);
  const postToEditor = editFrames.post;
  const overflow = editFrames.overflow;
  const view = pasteboard.view;
  const [width, setWidth] = useState(0);
  // The preview fills the whole area around the slide: an endless pasteboard to pan and zoom on.
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

  // Drawing and editing take turns: picking a pen leaves edit mode. It also shows the review
  // marks, so the new ones are not drawn blind.
  useEffect(() => {
    if (annotations.tool === "pointer") return;
    useApp.getState().setEditing(false);
    useApp.getState().setReviewVisible(true);
  }, [annotations.tool]);
  // The editor in the preview adds what the toolbar's tool says, styled like its defaults.
  useEffect(() => {
    if (editing) postToEditor(toolMessage(editTool, editStyles));
  }, [editing, editTool, editStyles, postToEditor]);
  const restyle = (changes: EditStyle) => {
    const selection = editFrames.selection;
    // Restyling also sets how the next one of its kind looks.
    const family = selection ? familyOfKind(selection.kind) : familyOf(editTool);
    if (family) useApp.getState().setEditStyle(family, changes);
    if (selection) postToEditor({ type: "slop:edit-style", style: changes });
  };
  const toggleEditing = () => {
    if (!editing) annotations.setTool("pointer");
    useApp.getState().setEditing(!editing);
  };

  if (!deck) return null;
  const index = deck.slides.findIndex((s) => s.id === selected);
  const slide = deck.slides[index];

  return (
    <div className="flex h-full flex-col bg-canvas">
      {slide && editing && (
        <div className="relative z-20 flex shrink-0 justify-center px-3 pt-2">
          <EditToolbar
            tool={editTool}
            selection={editFrames.selection}
            styles={editStyles}
            onTool={(tool) => useApp.getState().setEditTool(tool)}
            onStyle={restyle}
            onOrder={(to) => postToEditor({ type: "slop:edit-order", to })}
            onDelete={() => postToEditor({ type: "slop:edit-delete" })}
          />
        </div>
      )}
      {/* Clips the ink, which zooms past the slide along with the pasteboard, so it stays off the bar below. */}
      <div ref={areaRef} data-testid="stage-area" className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-8">
        {slide ? (
          // The slide's frame (outline, shadow, the edit-mode ring) is drawn in the preview, so it
          // pans and zooms with the slide.
          <div style={{ width }} {...{ [SKETCH_TARGET_ATTR]: "" }} data-editing={editing || undefined} className="relative">
            <CurrentSlide
              deckId={deck.id}
              slide={slide}
              editing={editing}
              arena={arena}
              canvas={areaRef}
              onFrameReady={(frame) => {
                pasteboard.onFrameReady(frame);
                editFrames.onFrameReady(frame);
              }}
            />
            {/* Ink sits on the slide, wherever the pasteboard has moved it. */}
            <div
              data-testid="annotation-view"
              className="pointer-events-none absolute inset-0 origin-top-left"
              style={pasteboard.current && width ? { transform: viewTransform(pasteboard.current, width / STAGE_W) } : undefined}
            >
              <AnnotationLayer annotations={annotations} />
            </div>
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
                  title="Edit the slide: click to select, drag to move, drag the handles to scale or rotate, double-click to edit text; the toolbar above adds text, shapes and drawings and restyles the selection"
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
                onClick={pasteboard.resetView}
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
  /** The panel around the slide; its colors frame the slide and dim what lies outside it in the editor. */
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
        const canvas = props.canvas.current;
        if (canvas) frame.contentWindow?.postMessage({ type: "slop:canvas", ...canvasColors(canvas) }, "*");
        props.onFrameReady(frame);
      }}
    />
  );
}

/** The panel's color, and the app's accent and border colors, resolved so the preview can use them. */
function canvasColors(canvas: HTMLElement) {
  const panel = canvas.parentElement ?? canvas;
  const probe = document.createElement("span");
  panel.appendChild(probe);
  const resolve = (variable: string) => {
    probe.style.color = `var(${variable})`;
    return getComputedStyle(probe).color;
  };
  const colors = { color: getComputedStyle(panel).backgroundColor, accent: resolve("--primary"), border: resolve("--border") };
  probe.remove();
  return colors;
}

/** CSS transform that puts what lies on the slide (`scale` CSS px per slide px) where the view has it. */
function viewTransform(view: PasteboardView, scale: number) {
  return `translate(${view.x * scale}px, ${view.y * scale}px) scale(${view.k})`;
}

/**
 * Follows how the pasteboard in the stage's preview (src-tauri/assets/pasteboard.js) is panned
 * and zoomed, and puts that view back whenever the slide reloads, in view and in edit mode.
 * Each slide starts centered at full size.
 */
function usePasteboard(areaRef: React.RefObject<HTMLDivElement | null>) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [view, setView] = useState<PasteboardView | null>(null);

  useEffect(() => {
    const fromStage = (source: MessageEventSource | null) =>
      Array.from(areaRef.current?.querySelectorAll("iframe") ?? []).some((f) => f.contentWindow === source);
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type !== "slop:view" || !fromStage(event.source)) return;
      if (data.slide === useApp.getState().selected && [data.x, data.y, data.k].every(Number.isFinite)) {
        setView({ slide: data.slide, x: data.x, y: data.y, k: data.k });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [areaRef]);

  const current = useApp((s) => s.selected);
  useEffect(() => {
    setView(null);
  }, [current]);

  const shown = view?.slide === current ? view : null;
  return {
    /** The view of the current slide, if it has moved; null when centered at full size. */
    current: shown,
    view: shown && !(shown.x === 0 && shown.y === 0 && shown.k === 1) ? shown : null,
    resetView: () => frame.current?.contentWindow?.postMessage({ type: "slop:camera", home: true }, "*"),
    onFrameReady: (loaded: HTMLIFrameElement) => {
      frame.current = loaded;
      if (view && view.slide === useApp.getState().selected) {
        loaded.contentWindow?.postMessage({ type: "slop:camera", x: view.x, y: view.y, k: view.k }, "*");
      }
    },
  };
}

/** The pasteboard's view: pan in slide pixels and zoom, relative to the slide centered at full size. */
interface PasteboardView {
  slide: string;
  x: number;
  y: number;
  k: number;
}

/**
 * Connects the stage to the slide editor running in its preview (src-tauri/assets/editor.js):
 * saves the markup it posts, keeps the selection across the reload that follows, and
 * handles undo and leaving edit mode.
 */
function useSlideEditing(areaRef: React.RefObject<HTMLDivElement | null>, resetView: () => void) {
  // What to select again once the edited slide reloads.
  const restore = useRef<{ slide: string; path: number[] } | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [overflow, setOverflow] = useState<{ slide: string; items: string[] } | null>(null);
  const [selection, setSelection] = useState<{ slide: string; selection: EditSelection | null } | null>(null);

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
      } else if (data?.type === "slop:edit-selection" && data.slide === selected) {
        setSelection({ slide: data.slide, selection: parseSelection(data.selection) });
      } else if (data?.type === "slop:edit-tool" && data.slide === selected && typeof data.tool === "string") {
        // The editor put its tool away by itself (after adding a shape, or on Escape).
        if (data.tool in TOOL_NAMES) useApp.getState().setEditTool(data.tool as EditTool);
      } else if (data?.type === "slop:key") {
        if (data.mod) runHistoryKey(String(data.key), Boolean(data.shift));
        else runEditKey(String(data.key));
      }
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!useApp.getState().editing || target?.closest("input, textarea, select, [contenteditable]")) return;
      if (event.metaKey || event.ctrlKey) {
        if (runHistoryKey(event.key, event.shiftKey)) event.preventDefault();
      } else if (!event.altKey && runEditKey(event.key, true)) {
        event.preventDefault();
      }
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

  const post = useCallback((data: unknown) => frame.current?.contentWindow?.postMessage(data, "*"), []);

  return {
    overflow: editing && overflow?.slide === current ? overflow.items : NO_OVERFLOW,
    /** What the editor has selected, as its toolbar shows it. */
    selection: editing && selection?.slide === current ? selection.selection : null,
    /** Sends a message to the slide editor in the preview. */
    post,
    onFrameReady: (loaded: HTMLIFrameElement) => {
      frame.current = loaded;
      const { editing, selected, editTool, editStyles } = useApp.getState();
      // A reloaded editor starts with the select tool and nothing selected, unless it is told
      // what to select again (and then reports it).
      if (editing) post(toolMessage(editTool, editStyles));
      const again = restore.current;
      if (editing && again && again.slide === selected) {
        loaded.contentWindow?.postMessage({ type: "slop:edit-select", path: again.path }, "*");
      } else {
        setSelection(null);
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
const TOOL_NAMES: Record<EditTool, true> = { select: true, text: true, rect: true, rounded: true, ellipse: true, draw: true };

/** Picks the editor's tool, with the style of what it adds. */
function toolMessage(tool: EditTool, styles: Record<string, EditStyle>) {
  const family = familyOf(tool);
  return { type: "slop:edit-tool", tool, style: family ? styles[family] : undefined };
}

/**
 * Edit mode's plain keys: a tool's shortcut picks it, Escape puts the tool away or else leaves
 * edit mode. `fromApp` when pressed in the app rather than forwarded by the slide, where
 * Escape belongs to whatever has focus. True when the key was one of them.
 */
function runEditKey(key: string, fromApp = false) {
  const app = useApp.getState();
  const tool = EDIT_TOOL_KEYS[key.toLowerCase()];
  if (tool && key.length === 1) {
    app.setEditTool(tool);
  } else if (key === "Escape" && app.editTool !== "select") {
    app.setEditTool("select");
  } else if (key === "Escape" && !fromApp) {
    app.setEditing(false);
  } else {
    return false;
  }
  return true;
}
const NO_INK: Record<string, Stroke[]> = {};

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
