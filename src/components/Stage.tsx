import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  LayoutTemplate,
  Lock,
  Maximize,
  Redo2,
  Sparkles,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, errorMessage, type Slide } from "../lib/api";
import { type EditGeometry, parseGeometry } from "../lib/arrange";
import { catchDrops, type DropPoint, imageSize, isImage } from "../lib/drop";
import {
  type DeckColor,
  defaultsFrom,
  EDIT_TOOL_KEYS,
  type EditElement,
  type EditSelection,
  type EditStyle,
  type EditTool,
  type FontChoice,
  familyOf,
  familyOfKind,
  IMAGE_FILE_TYPES,
  parseDeckColors,
  parseElement,
  parseFonts,
  parseHexColor,
  parseSelection,
} from "../lib/editTools";
import { type Stroke, zoomBox } from "../lib/ink";
import { type Pixels, pixelsOf } from "../lib/slideSize";
import { cn, deckFileUrl } from "../lib/utils";
import { deckMode, SKETCH_TARGET_ATTR, searchHighlight, useApp } from "../store";
import { EditContextMenu, type EditMenuAction } from "./EditContextMenu";
import { EditToolbar } from "./EditToolbar";
import { AnnotationLayer, useAnnotations } from "./PresenterTools";
import { ShortcutHelp } from "./ShortcutHelp";
import { SketchToolbar } from "./SketchToolbar";
import { SlideFrame, useSlideVersion } from "./SlideFrame";
import { LayoutPicker, Popover } from "./Templates";

/** The stage area's padding (Tailwind p-8), which the pasteboard covers too. */
const AREA_PADDING = 32;

/** The current slide, fit to the available space with letterboxing. */
export function Stage() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const sketches = useApp((s) => s.sketches);
  const reviewVisible = useApp((s) => s.reviewVisible);
  const editing = useApp((s) => s.editing);
  const mode = useApp(deckMode);
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
  const canvas = pixelsOf(deck);
  // The preview fills the whole area around the slide: an endless pasteboard to pan and zoom on.
  const [arena, setArena] = useState<{ width: number; height: number } | undefined>();
  // The slide as large as fits the area, in its own shape.
  const width = arena
    ? Math.max(
        0,
        Math.min(arena.width - 2 * AREA_PADDING, ((arena.height - 2 * AREA_PADDING) * canvas.width) / canvas.height),
      )
    : 0;

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width: w, height: h } = entry.contentRect;
      setArena({ width: w + 2 * AREA_PADDING, height: h + 2 * AREA_PADDING });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useSlideKeyboard();
  useSketchKeyboard(annotations.tool !== "pointer", () => annotations.setTool("pointer"));

  // Picking a pen shows the review marks, so the new ones are not drawn blind.
  useEffect(() => {
    if (annotations.tool !== "pointer") useApp.getState().setReviewVisible(true);
  }, [annotations.tool]);
  // The sketch tools are review mode's: leaving it puts them away.
  const putToolAway = annotations.setTool;
  useEffect(() => {
    if (mode !== "review") putToolAway("pointer");
  }, [mode, putToolAway]);
  // The editor in the preview adds what the toolbar's tool says, styled like its defaults.
  useEffect(() => {
    if (editing) postToEditor(toolMessage(editTool, editStyles));
  }, [editing, editTool, editStyles, postToEditor]);
  // The preview marks what the toolbar's search finds on this slide.
  const highlight = useApp(useShallow(searchHighlight));
  useEffect(() => {
    postToEditor({ type: "slop:search", ...highlight });
  }, [highlight, postToEditor]);
  const restyle = (changes: EditStyle) => {
    const selection = editFrames.selection;
    // Restyling also sets how the next one of its kind looks; styling a few words does not.
    const family = selection ? familyOfKind(selection.kind) : familyOf(editTool);
    if (family && !selection?.editing) useApp.getState().setEditStyle(family, defaultsFrom(changes));
    if (selection) postToEditor({ type: "slop:edit-style", style: changes });
  };

  const index = deck?.slides.findIndex((s) => s.id === selected) ?? -1;
  const slide = deck?.slides[index];
  const locked = !!slide?.locked;
  // A locked slide cannot be edited: going to one, or locking this one, leaves edit mode.
  useEffect(() => {
    if (locked && editing) useApp.getState().setEditing(false);
  }, [locked, editing]);

  if (!deck) return null;

  return (
    <div className="flex h-full flex-col bg-canvas">
      {slide && editing && (
        <ModeBar>
          <EditToolbar
            tool={editTool}
            selection={editFrames.selection}
            styles={editStyles}
            sizeMode={editFrames.sizeMode}
            onSizeMode={editFrames.setSizeMode}
            fonts={editFrames.fonts}
            colors={editFrames.colors}
            background={editFrames.background}
            slides={deck?.slides.map((s, i) => ({ id: s.id, label: `${i + 1}. ${s.id}` })) ?? []}
            onTool={(tool) => useApp.getState().setEditTool(tool)}
            onStyle={restyle}
            onList={(list) => postToEditor({ type: "slop:edit-list", list })}
            onLink={(href) => postToEditor({ type: "slop:edit-link", href })}
            onBackground={(color) => postToEditor({ type: "slop:edit-background", color })}
            onPickImage={editFrames.pickImage}
            onReturnFocus={editFrames.focus}
            onOrder={(to) => postToEditor({ type: "slop:edit-order", to })}
            onDelete={editFrames.deleteSelection}
            geometry={editFrames.geometry}
            onArrange={postToEditor}
          />
          <EditBar canUndo={canUndo} canRedo={canRedo} />
        </ModeBar>
      )}
      {slide && mode === "review" && (
        <ModeBar>
          <SketchToolbar annotations={annotations} />
          <div className="flex-1" />
        </ModeBar>
      )}
      {/* Clips the ink, which zooms past the slide along with the pasteboard, so it stays off the bar below. */}
      <div
        ref={areaRef}
        data-testid="stage-area"
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-8"
      >
        {slide ? (
          // The slide's frame (outline, shadow, the edit-mode ring) is drawn in the preview, so it
          // pans and zooms with the slide.
          <div
            style={{ width }}
            {...{ [SKETCH_TARGET_ATTR]: "" }}
            data-editing={editing || undefined}
            className="relative"
          >
            <CurrentSlide
              deckId={deck.id}
              slide={slide}
              size={canvas}
              editing={editing}
              arena={arena}
              canvas={areaRef}
              onFrameReady={(frame) => {
                pasteboard.onFrameReady(frame);
                editFrames.onFrameReady(frame);
                const search = searchHighlight(useApp.getState());
                if (search.query) postToEditor({ type: "slop:search", ...search });
              }}
            />
            {/* Ink sits on the slide, wherever the pasteboard has moved it. */}
            <div
              data-testid="annotation-view"
              className="pointer-events-none absolute"
              style={inkBox(pasteboard.current, width / canvas.width)}
            >
              <AnnotationLayer annotations={annotations} zoom={pasteboard.current?.k} />
            </div>
          </div>
        ) : (
          <EmptyStage />
        )}
      </div>
      {editFrames.menu && (
        <EditContextMenu
          {...editFrames.menu}
          running={running}
          onAction={editFrames.runMenuAction}
          onClose={editFrames.closeMenu}
        />
      )}
      {editing && <ShortcutHelp />}
      {deck.slides.length > 0 && (
        <div className="grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)] items-center gap-2 px-3 text-xs text-muted-foreground">
          <div />
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
          <div className="flex items-center justify-end">
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
            {locked && (
              <span
                title="Locked: neither you nor the agent can change this slide. Unlock it in the slide list."
                className="mr-1 flex items-center gap-1 rounded-md px-1.5 py-1"
              >
                <Lock className="size-3.5" />
                Locked
              </span>
            )}
            {slide && <ChangeLayoutButton disabled={running || locked} />}
            {slide && (
              <button
                type="button"
                title="Prepare a message, with a screenshot, asking the agent to rebuild this slide's layout, fixing overflow and clipping and keeping the elements you moved, rotated or scaled"
                disabled={running || locked}
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

/** The stage's own tools row, in the place of the deck toolbar, for the modes that work on the slide. */
function ModeBar({ children }: { children: ReactNode }) {
  return (
    <div className="relative z-20 flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-background px-3 py-1 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

/** Opens the template layouts, to have the agent rebuild the current slide on one. */
function ChangeLayoutButton(props: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title="Rebuild this slide on a template layout"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => setOpen((v) => !v)}
        className="mr-1 flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <LayoutTemplate className="size-3.5" />
        Layout
      </button>
      {open && (
        <Popover anchor={buttonRef} placement="above" width={560} label="Change layout" onClose={() => setOpen(false)}>
          <LayoutPicker mode="change" onDone={() => setOpen(false)} />
        </Popover>
      )}
    </>
  );
}

/** The end of the edit tools: history, and leaving edit mode. */
function EditBar(props: { canUndo: boolean; canRedo: boolean }) {
  const icon =
    "rounded-md p-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-4";
  const app = useApp.getState;
  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        aria-label="Undo"
        title="Undo (⌘Z)"
        disabled={!props.canUndo}
        onClick={() => void app().undoSlideEdit()}
        className={icon}
      >
        <Undo2 />
      </button>
      <button
        type="button"
        aria-label="Redo"
        title="Redo (⇧⌘Z)"
        disabled={!props.canRedo}
        onClick={() => void app().redoSlideEdit()}
        className={icon}
      >
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
  size: Pixels;
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
      size={props.size}
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
  const colors = {
    color: getComputedStyle(panel).backgroundColor,
    accent: resolve("--primary"),
    border: resolve("--border"),
  };
  probe.remove();
  return colors;
}

/** Puts what lies on the slide (`scale` CSS px per slide px) where the view has it. */
function inkBox(view: PasteboardView | null, scale: number) {
  return view && scale ? zoomBox(view.x * scale, view.y * scale, view.k) : zoomBox(0, 0, 1);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different slide starts centered
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
 * handles undo and leaving edit mode. Images dropped on the stage go onto the slide. The
 * editor copies elements through the system clipboard, and ⌘V pastes from it: an element
 * copied there, images (saved as assets) or text from anywhere.
 */
function useSlideEditing(areaRef: React.RefObject<HTMLDivElement | null>, resetView: () => void) {
  const [sizeMode, setSizeMode] = useState<"resize" | "stretch">("resize");
  // What to select again once the edited slide reloads.
  const restore = useRef<{ slide: string; path: number[]; also: number[][] } | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [overflow, setOverflow] = useState<{ slide: string; items: string[] } | null>(null);
  // What the editor has selected, and on which slide.
  const [selection, setSelection] = useState<{ slide: string; selection: EditSelection | null } | null>(null);
  // The fonts the deck's styles use, for the toolbar's font list.
  const [fonts, setFonts] = useState<FontChoice[]>(NO_FONTS);
  // Where the selection is, and on which slide.
  const [geometry, setGeometry] = useState<{ slide: string; geometry: EditGeometry | null } | null>(null);
  const [colors, setColors] = useState<DeckColor[]>(NO_COLORS);
  const [background, setBackground] = useState<string | null>(null);
  // The menu a right-click in the editor opened, in the app's pixels.
  const [menu, setMenu] = useState<{ x: number; y: number; element: EditElement | null } | null>(null);

  const paste = useCallback(async () => {
    const { deck, editing, selected } = useApp.getState();
    if (!deck || !editing || !selected) return;
    try {
      const pasted = await api.pasteFromClipboard(deck.id);
      const loaded = frame.current;
      const now = useApp.getState();
      if (!now.editing || now.selected !== selected || !loaded?.contentWindow) return;
      if (pasted.kind === "element") {
        loaded.contentWindow.postMessage({ type: "slop:edit-paste", html: pasted.html }, "*");
      } else if (pasted.kind === "text") {
        loaded.contentWindow.postMessage(
          { type: "slop:edit-paste-text", text: pasted.text, style: now.editStyles.text },
          "*",
        );
      } else if (pasted.kind === "slide") {
        await useApp.getState().pasteSlide();
      } else if (pasted.kind === "images") {
        const images = await Promise.all(
          pasted.images.map(async (src) => ({ src, ...(await imageSize(deckFileUrl(deck.id, src))) })),
        );
        // The editor puts them where the pointer is, or in the middle of the view.
        loaded.contentWindow.postMessage({ type: "slop:edit-paste-images", images }, "*");
      }
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    /** ⌘C / ⌘X / ⌘V while editing; `fromApp` when pressed outside the slide. True when handled. */
    const runClipboardKey = (key: string, shift: boolean, fromApp: boolean) => {
      const lower = key.toLowerCase();
      if (shift) return false;
      // ⌘A and ⌘D pressed outside the slide still mean the slide's elements.
      if (fromApp && (lower === "a" || lower === "d") && !window.getSelection()?.toString()) {
        frame.current?.contentWindow?.postMessage(
          { type: lower === "a" ? "slop:edit-select-all" : "slop:edit-duplicate" },
          "*",
        );
        return true;
      }
      if (lower === "v") {
        void paste();
        return true;
      }
      // In the slide, the editor copies by itself; in the app, copying selected text comes first.
      if ((lower === "c" || lower === "x") && fromApp && !window.getSelection()?.toString()) {
        frame.current?.contentWindow?.postMessage({ type: "slop:edit-copy", cut: lower === "x" }, "*");
        return true;
      }
      return false;
    };
    const fromStage = (source: MessageEventSource | null) =>
      Array.from(areaRef.current?.querySelectorAll("iframe") ?? []).some((f) => f.contentWindow === source);
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      const { editing, selected } = useApp.getState();
      if (!editing || !fromStage(event.source)) return;
      if (data?.type === "slop:edit-commit" && data.slide === selected && typeof data.markup === "string") {
        restore.current = Array.isArray(data.select)
          ? { slide: data.slide, path: data.select, also: Array.isArray(data.also) ? data.also : [] }
          : null;
        void useApp.getState().saveSlideEdit(data.slide, data.markup);
      } else if (data?.type === "slop:edit-overflow" && data.slide === selected && Array.isArray(data.items)) {
        setOverflow({ slide: data.slide, items: data.items.map(String) });
      } else if (data?.type === "slop:edit-selection" && data.slide === selected) {
        setSelection({ slide: data.slide, selection: parseSelection(data.selection) });
      } else if (data?.type === "slop:edit-geometry" && data.slide === selected) {
        setGeometry({ slide: data.slide, geometry: parseGeometry(data.geometry) });
      } else if (data?.type === "slop:edit-tool" && data.slide === selected && typeof data.tool === "string") {
        // The editor put its tool away by itself (after adding a shape, or on Escape).
        if (data.tool in TOOL_NAMES) useApp.getState().setEditTool(data.tool as EditTool);
      } else if (data?.type === "slop:edit-fonts" && data.slide === selected) {
        setFonts(parseFonts(data.fonts));
      } else if (data?.type === "slop:edit-colors" && data.slide === selected) {
        setColors(parseDeckColors(data.colors));
      } else if (data?.type === "slop:edit-background" && data.slide === selected) {
        setBackground(parseHexColor(data.color));
      } else if (data?.type === "slop:edit-menu" && data.slide === selected) {
        // The preview is scaled down to fit; the editor gives the point in its own pixels.
        const rect = frame.current?.getBoundingClientRect();
        const k = rect && frame.current?.clientWidth ? rect.width / frame.current.clientWidth : 1;
        setMenu({
          x: (rect?.left ?? 0) + Number(data.x) * k,
          y: (rect?.top ?? 0) + Number(data.y) * k,
          element: parseElement(data.element),
        });
      } else if (data?.type === "slop:edit-paste-request" && data.slide === selected) {
        // ⌘⇧V while typing: the clipboard's text, without its formatting.
        api
          .readClipboardText()
          .then((text) => {
            if (useApp.getState().editing && text) {
              frame.current?.contentWindow?.postMessage({ type: "slop:edit-insert-text", text }, "*");
            }
          })
          .catch((error) => useApp.getState().setError(errorMessage(error)));
      } else if (data?.type === "slop:edit-copied" && data.slide === selected && typeof data.html === "string") {
        api
          .copyToClipboard(data.html, String(data.text ?? ""), useApp.getState().deck?.id ?? null)
          .catch((error) => useApp.getState().setError(errorMessage(error)));
      } else if (data?.type === "slop:key") {
        if (data.mod)
          runHistoryKey(String(data.key), Boolean(data.shift)) ||
            runClipboardKey(String(data.key), Boolean(data.shift), false);
        else runEditKey(String(data.key));
      }
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!useApp.getState().editing || target?.closest("input, textarea, select, [contenteditable]")) return;
      if (event.metaKey || event.ctrlKey) {
        if (runHistoryKey(event.key, event.shiftKey) || runClipboardKey(event.key, event.shiftKey, true))
          event.preventDefault();
      } else if (!event.altKey && runEditKey(event.key, true)) {
        event.preventDefault();
      }
    };
    // A press anywhere in the app but the edit toolbar ends typing in the slide, keeping the
    // text; the toolbar restyles the text being typed (see editor.js).
    const onPress = (event: PointerEvent) => {
      if (!useApp.getState().editing) return;
      if ((event.target as Element | null)?.closest?.("[data-edit-toolbar]")) return;
      frame.current?.contentWindow?.postMessage({ type: "slop:edit-finish" }, "*");
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPress, true);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPress, true);
    };
  }, [areaRef, paste]);

  // Images dropped on the stage while editing are saved as assets and put on the slide where
  // they landed; anything else dropped there goes on to the chat.
  useEffect(() => {
    const insert = async (deckId: string, slide: string, paths: string[], point: DropPoint) => {
      try {
        const refs = await api.importAssets(deckId, paths);
        const images = await Promise.all(
          refs.map(async (src) => ({ src, ...(await imageSize(deckFileUrl(deckId, src))) })),
        );
        const { editing, selected } = useApp.getState();
        const loaded = frame.current;
        if (!editing || selected !== slide || !loaded?.contentWindow || images.length === 0) return;
        // The preview is scaled down to fit; the editor wants the point in its own pixels.
        const rect = loaded.getBoundingClientRect();
        const k = loaded.clientWidth ? rect.width / loaded.clientWidth : 1;
        loaded.contentWindow.postMessage(
          { type: "slop:edit-insert-images", images, x: (point.x - rect.left) / k, y: (point.y - rect.top) / k },
          "*",
        );
      } catch (error) {
        useApp.getState().setError(errorMessage(error));
      }
    };
    const covers = (point: DropPoint) => {
      const { deck, editing, selected } = useApp.getState();
      const area = areaRef.current?.getBoundingClientRect();
      const inside =
        !!area && point.x >= area.left && point.x <= area.right && point.y >= area.top && point.y <= area.bottom;
      return !!deck && editing && !!selected && !!frame.current && inside;
    };
    return catchDrops((paths, point) => {
      const { deck, selected } = useApp.getState();
      const images = paths.filter(isImage);
      if (!deck || !selected || images.length === 0 || !covers(point)) return paths;
      void insert(deck.id, selected, images, point);
      return paths.filter((p) => !isImage(p));
    }, covers);
  }, [areaRef]);

  const current = useApp((s) => s.selected);
  const editing = useApp((s) => s.editing);

  const post = useCallback((data: unknown) => frame.current?.contentWindow?.postMessage(data, "*"), []);

  const closeMenu = () => {
    setMenu(null);
    frame.current?.focus();
  };
  const runMenuAction = (action: EditMenuAction) => {
    const element = menu?.element;
    closeMenu();
    if (action === "cut" || action === "copy") post({ type: "slop:edit-copy", cut: action === "cut" });
    else if (action === "paste") void paste();
    else if (action === "duplicate") post({ type: "slop:edit-duplicate" });
    else if (action === "delete") post({ type: "slop:edit-delete" });
    else if (action === "ask" || action === "tidy") {
      if (!element) return;
      // The screenshot shows the whole slide, with the element selected and the menu gone.
      resetView();
      const { askAboutElement, tidyElement } = useApp.getState();
      const handOver = action === "ask" ? askAboutElement : tidyElement;
      requestAnimationFrame(() => requestAnimationFrame(() => void handOver(element)));
    } else post({ type: "slop:edit-order", to: action });
  };

  return {
    sizeMode,
    setSizeMode: (mode: "resize" | "stretch") => {
      setSizeMode(mode);
      post({ type: "slop:edit-size-mode", mode });
    },
    overflow: editing && overflow?.slide === current ? overflow.items : NO_OVERFLOW,
    /** What the editor has selected, as its toolbar shows it. */
    selection: editing && selection?.slide === current ? selection.selection : null,
    /** Where the selection is, for the arrange controls. */
    geometry: editing && geometry?.slide === current ? geometry.geometry : null,
    /** The open context menu, and what it does. */
    menu: editing ? menu : null,
    closeMenu,
    runMenuAction,
    /** Sends a message to the slide editor in the preview. */
    post,
    /** The fonts the deck uses. */
    fonts,
    /** The colors in the deck's CSS variables. */
    colors,
    /** The current slide's background color. */
    background,
    /** Picks image files: to add to the slide, or with `replace`, to put in the selected image. */
    pickImage: async (replace: boolean) => {
      const { deck, selected } = useApp.getState();
      if (!deck || !selected) return;
      try {
        const picked = await open({
          multiple: !replace,
          filters: [{ name: "Images", extensions: IMAGE_FILE_TYPES }],
        });
        const paths = [picked ?? []].flat();
        if (paths.length === 0) return;
        const refs = await api.importAssets(deck.id, paths);
        const images = await Promise.all(
          refs.map(async (src) => ({ src, ...(await imageSize(deckFileUrl(deck.id, src))) })),
        );
        const now = useApp.getState();
        if (!now.editing || now.selected !== selected) return;
        if (replace && images[0]) post({ type: "slop:edit-replace-image", src: images[0].src });
        else post({ type: "slop:edit-paste-images", images });
      } catch (error) {
        useApp.getState().setError(errorMessage(error));
      }
    },
    /** Gives focus back to the slide, as after typing a value into the toolbar. */
    focus: () => frame.current?.focus(),
    deleteSelection: () => post({ type: "slop:edit-delete" }),
    onFrameReady: (loaded: HTMLIFrameElement) => {
      frame.current = loaded;
      // A fresh editor starts with the select tool and nothing selected; it reports a restored
      // selection itself.
      setSelection(null);
      setGeometry(null);
      setMenu(null);
      const { editing, selected, editTool, editStyles } = useApp.getState();
      if (editing) {
        post({ type: "slop:edit-size-mode", mode: sizeMode });
        post(toolMessage(editTool, editStyles));
      }
      const again = restore.current;
      if (editing && again && again.slide === selected) {
        const also = again.also.length > 0 ? { also: again.also } : {};
        loaded.contentWindow?.postMessage({ type: "slop:edit-select", path: again.path, ...also }, "*");
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
const NO_FONTS: FontChoice[] = [];
const NO_COLORS: DeckColor[] = [];
const TOOL_NAMES: Record<EditTool, true> = {
  select: true,
  text: true,
  rect: true,
  rounded: true,
  ellipse: true,
  triangle: true,
  star: true,
  bubble: true,
  draw: true,
  line: true,
  arrow: true,
  paint: true,
};

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
        Tell the agent what the presentation is about, who it is for, and how long it should be. Slides appear here as
        they are written.
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
 * Arrow keys / PageUp / PageDown move between slides unless the user is typing, and ⌘C / ⌘V
 * copy and paste whole slides outside edit mode. Also handles
 * keys the slide preview forwards as `slop:key` messages, so navigation keeps working after
 * clicking into the slide. The preview cancels presses on it (to pan, select and drag), which
 * leaves focus where it was, e.g. in the chat composer: it asks for focus with `slop:focus`.
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
    // Out of edit mode, ⌘C / ⌘V copy the selected slide and paste one after it, also from
    // another window (edit mode copies and pastes elements, see useSlideEditing).
    const clipboard = (key: string, shift: boolean, fromApp: boolean) => {
      const { editing, presenting, copySlide, pasteSlide } = useApp.getState();
      if (editing || presenting || shift) return false;
      // Copying selected text comes first.
      if (fromApp && window.getSelection()?.toString()) return false;
      const lower = key.toLowerCase();
      if (lower === "c") void copySlide();
      else if (lower === "v") void pasteSlide();
      else return false;
      return true;
    };
    // Out of edit mode, whose keys these are on the slide: the slide rail's history and moves
    // (⌘↑ / ⌘↓, also out of a section), and Delete and Escape for the slides picked in it.
    const rail = (key: string, mod: boolean, shift: boolean) => {
      const app = useApp.getState();
      if (app.editing || app.presenting) return false;
      const lower = key.toLowerCase();
      if (mod && lower === "z" && !shift) void app.undoDeckEdit();
      else if (mod && ((lower === "z" && shift) || lower === "y")) void app.redoDeckEdit();
      else if (mod && key === "ArrowUp") void app.moveSlides(-1);
      else if (mod && key === "ArrowDown") void app.moveSlides(1);
      else if (!mod && app.railSelected.length > 0 && (key === "Delete" || key === "Backspace"))
        void app.deleteSlides(app.railSelected);
      else if (!mod && app.railSelected.length > 0 && key === "Escape") app.clearRailSelection();
      else return false;
      return true;
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey && clipboard(event.key, event.shiftKey, true)) event.preventDefault();
      else if (!event.altKey && rail(event.key, mod, event.shiftKey)) event.preventDefault();
      else if (navigate(event.key)) event.preventDefault();
    };
    const onMessage = (event: MessageEvent) => {
      const type = event.data?.type;
      if (type !== "slop:key" && type !== "slop:focus") return;
      const slide = Array.from(document.querySelectorAll("iframe")).find(
        (frame) => frame.contentWindow === event.source,
      );
      if (!slide) return;
      if (type === "slop:focus") slide.focus();
      else {
        const key = String(event.data.key);
        const [mod, shift] = [Boolean(event.data.mod), Boolean(event.data.shift)];
        if (!(mod && clipboard(key, shift, false)) && !rail(key, mod, shift)) navigate(key);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, []);
}
