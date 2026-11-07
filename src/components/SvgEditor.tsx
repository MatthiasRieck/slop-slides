import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  CornerLeftUp,
  Maximize,
  Minus,
  Moon,
  Plus,
  Redo2,
  RotateCcw,
  Shapes,
  Sun,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SWATCHES } from "../lib/palette";
import {
  addHandle,
  type Backdrop,
  backdropFor,
  displayCopy,
  editMarkup,
  elementsOf,
  type Handle,
  handlesOf,
  hexOf,
  labelOf,
  moveHandle,
  type Point,
  parseSvg,
  presentationOf,
  removeHandle,
  restack,
  serializeSvg,
  setPresentation,
  translateBy,
  viewBoxOf,
} from "../lib/svgEdit";
import { cn, deckFileUrl, isMac } from "../lib/utils";
import { useApp } from "../store";
import { isDirty, type SvgAncestor, type SvgEdit, useSvgEditor } from "../svgStore";
import { Button, ToolButton } from "./Button";
import { Field, inputClass, wideSelectClass } from "./Field";
import { SectionLabel } from "./SectionLabel";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 64;
/** Room left around the drawing when it is fit to the canvas, in pixels. */
const FIT_MARGIN = 32;
/** A press moves this many pixels before it drags. */
const DRAG_THRESHOLD = 3;
/** Changes to the same field this close together are one undo step. */
const COALESCE_MS = 800;
/** The checkerboard behind the drawing, as squares and the ground between them. */
const CHECKERS: Record<Backdrop, { ground: string; check: string }> = {
  light: { ground: "var(--paper)", check: "color-mix(in srgb, var(--paper) 90%, var(--stage))" },
  dark: { ground: "var(--color-neutral-900)", check: "var(--color-neutral-800)" },
};

/**
 * The SVG editor, in a sidebar tab: one drawing from a slide (opened with the "Edit SVG" button
 * on the slide in edit mode), edited in memory. Click an element to select it and drag it to
 * move it; drag a shape's points (and its curves' control points) to reshape it, drag the small
 * dots between them to add points and double-click a point to take it out. Its look, any of its
 * attributes, its place among the layers and the drawing's markup can all be changed. Accept
 * saves the drawing into the slide; Discard goes back to the slide's.
 */
export function SvgEditor() {
  const edit = useSvgEditor((s) => s.edit);
  if (!edit) return <NoDrawing />;
  // A different drawing starts afresh: nothing selected, fit to the canvas.
  return <DrawingEditor key={`${edit.deckId}|${edit.slide}|${String(edit.path)}`} edit={edit} />;
}

function NoDrawing() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <Shapes className="size-6 text-muted-foreground" />
      <h2 className="text-sm font-medium">No drawing open</h2>
      <p className="max-w-64 text-xs text-muted-foreground">
        In edit mode, select an SVG drawing on a slide and press <strong>Edit SVG</strong> beside it.
      </p>
    </div>
  );
}

type InspectorTab = "properties" | "layers" | "markup";

function DrawingEditor({ edit }: { edit: SvgEdit }) {
  const svg = useMemo(() => parseSvg(edit.draft), [edit.draft]);
  const deckId = useApp((s) => s.deck?.id);
  const [selected, setSelected] = useState<number | null>(null);
  const [point, setPoint] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [tab, setTab] = useState<InspectorTab>("properties");
  // The backdrop the user picked; null follows the drawing's colors.
  const [picked, setPicked] = useState<Backdrop | null>(null);
  const auto = useMemo(() => (svg ? backdropFor(svg, edit.color, edit.vars) : "light"), [svg, edit.color, edit.vars]);
  const backdrop = picked ?? auto;
  const lastChange = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const dirty = isDirty(edit);
  const elements = useMemo(() => (svg ? elementsOf(svg) : []), [svg]);
  const element = selected !== null ? (elements[selected] ?? null) : null;

  // Undo or markup edits can take the selected element away.
  useEffect(() => {
    if (selected !== null && selected >= elements.length) setSelected(null);
  }, [selected, elements.length]);

  const store = useSvgEditor.getState;
  /** Changes the drawing; changes to the same `key` in quick succession are one undo step. */
  const change = useCallback((draft: string, key?: string) => {
    const now = Date.now();
    const record = !key || key !== lastChange.current.key || now - lastChange.current.at > COALESCE_MS;
    lastChange.current = { key: key ?? "", at: now };
    useSvgEditor.getState().change(draft, record);
  }, []);
  /** Edits the element at `index` (the selected one by default). */
  const editElement = (fn: (el: Element, svg: SVGSVGElement) => unknown, key?: string, index = selected) => {
    if (index === null) return;
    change(editMarkup(useSvgEditor.getState().edit?.draft ?? edit.draft, index, fn), key);
  };

  const select = (index: number | null) => {
    setSelected(index);
    setPoint(null);
  };

  const removeSelected = () => {
    if (!element || selected === null) return;
    if (point) {
      editElement((el) => removeHandle(el, point));
      setPoint(null);
      return;
    }
    if (selected === 0) return;
    editElement((el) => el.remove());
    select(null);
  };
  const duplicateSelected = () => {
    if (selected === null || selected === 0) return;
    const count = element ? element.querySelectorAll("*").length + 1 : 1;
    editElement((el) => {
      const copy = el.cloneNode(true) as Element;
      copy.removeAttribute("id");
      for (const inner of copy.querySelectorAll("[id]")) inner.removeAttribute("id");
      el.after(copy);
    });
    select(selected + count);
  };
  const restackSelected = (forward: boolean) => {
    if (selected === null || selected === 0 || !element) return;
    const sibling = forward ? element.nextElementSibling : element.previousElementSibling;
    if (!sibling) return;
    const size = (el: Element) => el.querySelectorAll("*").length + 1;
    editElement((el) => restack(el, forward));
    select(forward ? selected + size(sibling) : selected - size(sibling));
  };
  const selectParent = () => {
    if (point) return setPoint(null);
    const parent = element?.parentElement;
    select(parent && svg?.contains(parent) ? elements.indexOf(parent) : null);
  };
  const nudge = (dx: number, dy: number) => {
    if (selected === null || selected === 0) return;
    editElement((el) => translateBy(el, dx, dy), "nudge");
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select")) return;
    const mod = isMac ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    let handled = true;
    if (mod && key === "z") (event.shiftKey ? store().redo : store().undo)();
    else if (mod && key === "y") store().redo();
    else if (mod && key === "d") duplicateSelected();
    else if (mod && key === "s") void store().accept();
    else if (!mod && (event.key === "Delete" || event.key === "Backspace")) removeSelected();
    else if (!mod && event.key === "Escape") selectParent();
    else if (!mod && event.key.startsWith("Arrow")) {
      const step = event.shiftKey ? 10 : 1;
      const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      nudge(dx, dy);
    } else handled = false;
    if (handled) event.preventDefault();
    // The slide editor's shortcuts (its tools, its undo) are not for the drawing; the app's are.
    if (handled || !mod) event.stopPropagation();
  };

  const otherDeck = deckId !== edit.deckId;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the editor's shortcuts apply anywhere in it.
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the editor's shortcuts apply anywhere in it.
    <div className="@container flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <ToolButton
          variant="panel"
          label={`Undo (${isMac ? "⌘" : "Ctrl+"}Z)`}
          disabled={!edit.past.length}
          onClick={store().undo}
        >
          <Undo2 />
        </ToolButton>
        <ToolButton
          variant="panel"
          label={`Redo (${isMac ? "⌘⇧" : "Ctrl+Shift+"}Z)`}
          disabled={!edit.future.length}
          onClick={store().redo}
        >
          <Redo2 />
        </ToolButton>
        <div className="mx-1 h-4 w-px bg-border" />
        <ZoomControls zoom={zoom} onZoom={setZoom} />
        <div className="mx-1 h-4 w-px bg-border" />
        <ToolButton
          variant="panel"
          label={`${backdrop === "dark" ? "Light" : "Dark"} backdrop (now ${backdrop}${picked ? "" : ", from the drawing's colors"})`}
          active={backdrop === "dark"}
          onClick={() => {
            const next = backdrop === "dark" ? "light" : "dark";
            // Picking what the colors suggest follows them again.
            setPicked(next === auto ? null : next);
          }}
        >
          {backdrop === "dark" ? <Moon /> : <Sun />}
        </ToolButton>
        <div className="min-w-2 flex-1" />
        {dirty && <span className="mr-1 hidden text-xs text-muted-foreground @xs:inline">Not accepted yet</span>}
        <Button
          size="md"
          disabled={!dirty || edit.saving}
          onClick={store().discard}
          title="Go back to the drawing on the slide"
        >
          <RotateCcw />
          Discard
        </Button>
        <Button
          variant="primary"
          size="md"
          disabled={!dirty || edit.saving || otherDeck || !svg}
          onClick={() => void store().accept()}
          title={
            otherDeck
              ? "Open the deck the drawing is in to save it"
              : `Save the drawing into the slide (${isMac ? "⌘" : "Ctrl+"}S)`
          }
        >
          <Check />
          {edit.saving ? "Saving…" : "Accept"}
        </Button>
      </div>
      {otherDeck && (
        <p className="border-b bg-warning/10 px-3 py-1.5 text-xs text-warning">
          This drawing is in another deck; open it to accept the changes.
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
        <div className="relative min-h-40 flex-1 basis-1/2 @3xl:basis-auto">
          {svg ? (
            <Canvas
              edit={edit}
              svg={svg}
              selected={selected}
              point={point}
              zoom={zoom}
              backdrop={backdrop}
              onZoom={setZoom}
              onSelect={select}
              onPoint={setPoint}
              onChange={change}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-xs text-destructive">
              The markup is not one &lt;svg&gt; drawing. Fix it in Markup, or undo.
            </div>
          )}
        </div>
        <div className="flex min-h-0 flex-1 basis-1/2 flex-col border-t @3xl:w-80 @3xl:flex-none @3xl:basis-auto @3xl:border-l @3xl:border-t-0">
          <div role="tablist" aria-label="Inspector" className="flex shrink-0 gap-1 border-b px-2 py-1.5">
            {(["properties", "layers", "markup"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  "rounded-md px-2 py-1 text-xs font-medium capitalize text-muted-foreground hover:bg-accent hover:text-foreground",
                  tab === id && "bg-accent text-foreground",
                )}
              >
                {id}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
            {tab === "properties" &&
              (element && selected !== null ? (
                <Properties
                  key={selected}
                  element={element}
                  root={selected === 0}
                  point={point}
                  onEdit={editElement}
                  onParent={selectParent}
                  onForward={() => restackSelected(true)}
                  onBackward={() => restackSelected(false)}
                  onDuplicate={duplicateSelected}
                  onDelete={removeSelected}
                />
              ) : (
                <p className="p-4 text-xs text-muted-foreground">
                  Click an element of the drawing, or pick one in Layers.
                </p>
              ))}
            {tab === "layers" && <Layers elements={elements} selected={selected} onSelect={select} />}
            {tab === "markup" && <Markup draft={edit.draft} onChange={(text) => change(text, "markup")} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A checkerboard of `check` squares over the ground color. */
function checkerboard(check: string) {
  const squares = `linear-gradient(45deg, ${check} 25%, transparent 25%, transparent 75%, ${check} 75%)`;
  return `${squares}, ${squares}`;
}

function ZoomControls({ zoom, onZoom }: { zoom: number | null; onZoom: (zoom: number | null) => void }) {
  const by = (factor: number) => onZoom(clampZoom((zoom ?? 1) * factor));
  return (
    <>
      <ToolButton variant="panel" label="Zoom out" onClick={() => by(1 / 1.25)}>
        <Minus />
      </ToolButton>
      <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">
        {zoom === null ? "" : `${Math.round(zoom * 100)}%`}
      </span>
      <ToolButton variant="panel" label="Zoom in" onClick={() => by(1.25)}>
        <Plus />
      </ToolButton>
      <ToolButton variant="panel" label="Fit the drawing" onClick={() => onZoom(null)}>
        <Maximize />
      </ToolButton>
    </>
  );
}

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** What the canvas draws over the drawing, in the canvas content's pixels. */
interface Overlay {
  /** The selected element's box, as a polygon (it turns with its transform). */
  outline: Point[] | null;
  handles: (Handle & { at: Point })[];
}

const NO_OVERLAY: Overlay = { outline: null, handles: [] };

interface Drag {
  pointer: number;
  start: { x: number; y: number };
  /** The drawing when the drag started; each move redoes the change from it. */
  markup: string;
  index: number;
  /** A point of the shape, or (null) the whole element. */
  handle: string | null;
  /** Screen to the user units the change is in: the element's own for a point, its parent's for a move. */
  toLocal: DOMMatrix;
  moved: boolean;
}

/** Elements that would load or run something; around a drawing they are mirrored as a <div>. */
const ACTIVE_TAGS = /^(script|style|link|iframe|frame|object|embed|template|base|meta|img|video|audio|source)$/;

/**
 * `copy` inside elements mirroring the ones it sits in on the slide (outermost first), so the
 * deck's rules that pick it out by them match; they draw no box of their own.
 */
export function withAncestors(copy: Element, ancestors: SvgAncestor[]): Element {
  let outer = copy;
  for (const { tag, attrs } of [...ancestors].reverse()) {
    let el: HTMLElement;
    try {
      el = document.createElement(ACTIVE_TAGS.test(tag) ? "div" : tag);
    } catch {
      continue;
    }
    for (const [name, value] of Object.entries(attrs)) {
      try {
        el.setAttribute(name, value);
      } catch {
        // Not a name an attribute can have.
      }
    }
    el.style.setProperty("display", "contents", "important");
    el.append(outer);
    outer = el;
  }
  return outer;
}

/**
 * The drawing, shown at `zoom` (null: fit) in a shadow root, so its styles stay inside it and the
 * app's do not reach it; with the selection's outline and points drawn over it.
 */
function Canvas(props: {
  edit: SvgEdit;
  svg: SVGSVGElement;
  selected: number | null;
  point: string | null;
  zoom: number | null;
  backdrop: Backdrop;
  onZoom: (zoom: number) => void;
  onSelect: (index: number | null) => void;
  onPoint: (id: string | null) => void;
  onChange: (draft: string, key?: string) => void;
}) {
  const { edit, svg, selected, point, zoom, backdrop, onZoom, onSelect, onPoint, onChange } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const shown = useRef<Element | null>(null);
  const drag = useRef<Drag | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(NO_OVERLAY);
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);
  const { size } = edit;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fit = room ? clampZoom(Math.min((room.w - 2 * FIT_MARGIN) / size.w, (room.h - 2 * FIT_MARGIN) / size.h)) : 1;
  const k = zoom ?? (Number.isFinite(fit) && fit > 0 ? fit : 1);
  // The zoom buttons start from the fit.
  useEffect(() => {
    if (zoom === null && room) onZoom(k);
  }, [zoom, room, k, onZoom]);

  // The deck's web fonts, which only load from the app's document.
  useEffect(() => {
    if (!edit.fonts) return;
    const fonts = document.createElement("style");
    fonts.setAttribute("data-slop-svg-fonts", "");
    fonts.textContent = edit.fonts;
    document.head.append(fonts);
    return () => fonts.remove();
  }, [edit.fonts]);

  // Draws the drawing as edited.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const copy = displayCopy(svg, (url) => deckFileUrl(edit.deckId, url));
    copy.setAttribute("viewBox", viewBoxOf(svg, size));
    copy.setAttribute("width", String(size.w * k));
    copy.setAttribute("height", String(size.h * k));
    const look = (copy as SVGElement).style;
    // Where the slide put it does not matter here, whatever the deck's rules say.
    for (const [name, value] of [
      ["position", "static"],
      ["inset", "auto"],
      ["translate", "none"],
      ["rotate", "none"],
      ["scale", "none"],
      ["transform", "none"],
      ["margin", "0"],
      ["width", `${size.w * k}px`],
      ["height", `${size.h * k}px`],
      ["min-width", "0"],
      ["min-height", "0"],
      ["max-width", "none"],
      ["max-height", "none"],
      ["display", "block"],
      ["overflow", "visible"],
    ] as const) {
      look.setProperty(name, value, "important");
    }
    const frame = document.createElement("div");
    frame.className = "frame";
    for (const [name, value] of Object.entries(edit.vars)) frame.style.setProperty(name, value);
    if (edit.color) frame.style.color = edit.color;
    frame.append(withAncestors(copy, edit.ancestors));
    const base = document.createElement("style");
    base.textContent = ":host { display: block; } .frame { line-height: normal; } a { pointer-events: none; }";
    // The deck's own rules, so a drawing styled by them looks as it does on the slide.
    const deck = document.createElement("style");
    deck.textContent = edit.css;
    root.replaceChildren(base, deck, frame);
    shown.current = copy;
  }, [svg, size, k, edit.deckId, edit.vars, edit.color, edit.css, edit.ancestors]);

  // Measures the selection on the drawing as drawn, again whenever it is drawn at another size.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a zoom or a resize moves the drawing on screen
  useLayoutEffect(() => {
    const content = contentRef.current;
    const copy = shown.current;
    const el = selected !== null && copy ? (elementsOf(copy)[selected] as SVGGraphicsElement | undefined) : undefined;
    const model = selected !== null ? elementsOf(svg)[selected] : undefined;
    if (!content || !el || !model || typeof el.getScreenCTM !== "function") return setOverlay(NO_OVERLAY);
    const ctm = el.getScreenCTM();
    if (!ctm) return setOverlay(NO_OVERLAY);
    const origin = content.getBoundingClientRect();
    const at = (x: number, y: number): Point => {
      const p = new DOMPoint(x, y).matrixTransform(ctm);
      return [p.x - origin.left, p.y - origin.top];
    };
    let outline: Point[] | null = null;
    try {
      const box = el.getBBox();
      outline = [
        at(box.x, box.y),
        at(box.x + box.width, box.y),
        at(box.x + box.width, box.y + box.height),
        at(box.x, box.y + box.height),
      ];
    } catch {
      // Not drawn (display: none, or inside <defs>).
    }
    const handles = handlesOf(model).map((h) => ({
      ...h,
      at: at(h.x, h.y),
      links: h.links?.map((l) => at(l[0], l[1])),
    }));
    setOverlay({ outline, handles });
  }, [svg, selected, k, room]);

  /** The element of the drawing at the press, by its index; null on empty canvas. */
  const pressed = (event: ReactPointerEvent): number | null => {
    const copy = shown.current;
    const target = event.nativeEvent.composedPath()[0];
    if (!copy || !(target instanceof Element) || !copy.contains(target)) return null;
    const all = elementsOf(copy);
    let index = all.indexOf(target);
    // Keep the selected group when pressing inside it, so it can be dragged as a whole.
    const current = selected !== null ? all[selected] : undefined;
    if (current && current !== copy && current.contains(target)) index = selected!;
    return index < 0 ? null : index;
  };

  const startDrag = (event: ReactPointerEvent, index: number, handle: string | null, markup: string) => {
    const copy = shown.current;
    const el = copy ? (elementsOf(copy)[index] as SVGGraphicsElement | undefined) : undefined;
    const space = handle ? el : (el?.parentElement as unknown as SVGGraphicsElement | null);
    const ctm = space && typeof space.getScreenCTM === "function" ? space.getScreenCTM() : null;
    if (!ctm) return;
    drag.current = {
      pointer: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      markup,
      index,
      handle,
      toLocal: DOMMatrix.fromMatrix(ctm).inverse(),
      moved: false,
    };
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  };

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    scrollRef.current?.focus({ preventScroll: true });
    const handle = (event.target as Element).closest?.("[data-handle]")?.getAttribute("data-handle");
    const draft = useSvgEditor.getState().edit?.draft ?? edit.draft;
    if (handle && selected !== null) {
      event.preventDefault();
      if (handle.startsWith("add:")) {
        // A new point where the dot was, dragged on from there.
        let added: string | null = null;
        const next = editMarkup(draft, selected, (el) => {
          added = addHandle(el, handle);
          return added !== null;
        });
        if (!added) return;
        onChange(next);
        onPoint(added);
        startDrag(event, selected, added, next);
        if (drag.current) drag.current.moved = true;
        return;
      }
      onPoint(handle);
      startDrag(event, selected, handle, draft);
      return;
    }
    const index = pressed(event);
    onSelect(index);
    if (index !== null && index > 0) startDrag(event, index, null, draft);
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    let x = event.clientX;
    let y = event.clientY;
    if (!d.moved && Math.hypot(x - d.start.x, y - d.start.y) < DRAG_THRESHOLD) return;
    if (event.shiftKey && !d.handle) {
      // Shift keeps a move straight across or down.
      if (Math.abs(x - d.start.x) > Math.abs(y - d.start.y)) y = d.start.y;
      else x = d.start.x;
    }
    const from = new DOMPoint(d.start.x, d.start.y).matrixTransform(d.toLocal);
    const to = new DOMPoint(x, y).matrixTransform(d.toLocal);
    const first = !d.moved;
    d.moved = true;
    const next = editMarkup(d.markup, d.index, (el) => {
      if (d.handle) {
        const h = handlesOf(el).find((hh) => hh.id === d.handle);
        if (h) moveHandle(el, d.handle, [h.x + (to.x - from.x), h.y + (to.y - from.y)]);
      } else translateBy(el, to.x - from.x, to.y - from.y);
    });
    useSvgEditor.getState().change(next, first);
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    if (drag.current?.pointer === event.pointerId) drag.current = null;
  };

  const onDoubleClick = (event: React.MouseEvent) => {
    const handle = (event.target as Element).closest?.("[data-handle]")?.getAttribute("data-handle");
    if (!handle || selected === null || handle.startsWith("add:")) return;
    const draft = useSvgEditor.getState().edit?.draft ?? edit.draft;
    let removed = false;
    const next = editMarkup(draft, selected, (el) => {
      removed = removeHandle(el, handle);
      return removed;
    });
    if (removed) {
      onChange(next);
      onPoint(null);
    }
  };

  const onWheel = (event: React.WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    onZoom(clampZoom(k * Math.exp(-event.deltaY * 0.01)));
  };

  const w = size.w * k;
  const h = size.h * k;
  return (
    <div
      ref={scrollRef}
      data-testid="svg-canvas"
      role="application"
      aria-label="Drawing"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: focus brings the drawing's keyboard shortcuts.
      tabIndex={0}
      className="absolute inset-0 overflow-auto bg-canvas outline-none"
      onWheel={onWheel}
    >
      <div
        className="flex min-h-full min-w-full items-center justify-center"
        style={{ padding: FIT_MARGIN, width: "max-content", height: "max-content" }}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer editing of the drawing; its keys are the canvas's. */}
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: pointer editing of the drawing; its keys are the canvas's. */}
        <div
          ref={contentRef}
          data-backdrop={backdrop}
          className="relative touch-none select-none"
          style={{
            width: w,
            height: h,
            // A checkerboard shows what the drawing leaves see-through.
            backgroundColor: CHECKERS[backdrop].ground,
            backgroundImage: checkerboard(CHECKERS[backdrop].check),
            backgroundSize: "16px 16px",
            backgroundPosition: "0 0, 8px 8px",
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
        >
          <div ref={hostRef} data-testid="svg-drawing" />
          <svg
            className="pointer-events-none absolute inset-0 overflow-visible"
            width={w}
            height={h}
            aria-hidden="true"
          >
            {overlay.outline && (
              <polygon
                points={overlay.outline.map((p) => p.join(",")).join(" ")}
                fill="none"
                stroke="var(--primary)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            )}
            {overlay.handles.flatMap((hd) =>
              (hd.links ?? []).map((l, i) => (
                <line
                  // biome-ignore lint/suspicious/noArrayIndexKey: a handle's links are in a fixed order.
                  key={`${hd.id}-${i}`}
                  x1={hd.at[0]}
                  y1={hd.at[1]}
                  x2={l[0]}
                  y2={l[1]}
                  stroke="var(--primary)"
                  strokeWidth={1}
                />
              )),
            )}
            {overlay.handles.map((hd) => (
              <HandleMark key={hd.id} handle={hd} active={hd.id === point} />
            ))}
          </svg>
        </div>
      </div>
    </div>
  );
}

function HandleMark({ handle, active }: { handle: Handle & { at: Point }; active: boolean }) {
  const [x, y] = handle.at;
  const title =
    handle.role === "add"
      ? "Drag to add a point here"
      : handle.removable
        ? "Drag to move; double-click to take the point out"
        : "Drag to move";
  const common = {
    "data-handle": handle.id,
    "data-role": handle.role,
    className: "pointer-events-auto cursor-move",
    stroke: "var(--primary)",
    strokeWidth: 1.5,
  };
  if (handle.role === "add") {
    return (
      <circle {...common} cx={x} cy={y} r={3.5} fill="var(--primary)" className="pointer-events-auto cursor-crosshair">
        <title>{title}</title>
      </circle>
    );
  }
  if (handle.role === "control") {
    return (
      <rect
        {...common}
        x={x - 4}
        y={y - 4}
        width={8}
        height={8}
        transform={`rotate(45 ${x} ${y})`}
        fill={active ? "var(--primary)" : "var(--handle)"}
      >
        <title>{title}</title>
      </rect>
    );
  }
  return (
    <circle {...common} cx={x} cy={y} r={5} fill={active ? "var(--primary)" : "var(--handle)"}>
      <title>{title}</title>
    </circle>
  );
}

// ---- Inspector

/** The look shown for every element: presentation attributes, by name. */
const PAINT = ["fill", "stroke"] as const;

function Properties(props: {
  element: Element;
  root: boolean;
  point: string | null;
  onEdit: (fn: (el: Element) => unknown, key?: string) => void;
  onParent: () => void;
  onForward: () => void;
  onBackward: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { element: el, root, point, onEdit } = props;
  const set = (name: string) => (value: string) => onEdit((e) => setPresentation(e, name, value), name);
  const value = (name: string) => presentationOf(el, name);
  const textOnly = /^(text|tspan|textPath|title|desc)$/.test(el.localName) && el.children.length === 0;
  const handle = point ? handlesOf(el).find((h) => h.id === point) : undefined;
  return (
    <div className="flex flex-col gap-4 p-3 text-xs">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate font-mono font-medium" title={labelOf(el)}>
          {labelOf(el)}
        </span>
        <ToolButton variant="panel" label="Select the parent (Escape)" disabled={root} onClick={props.onParent}>
          <CornerLeftUp />
        </ToolButton>
        <ToolButton
          variant="panel"
          label="Bring forward"
          disabled={root || !el.nextElementSibling}
          onClick={props.onForward}
        >
          <ArrowUp />
        </ToolButton>
        <ToolButton
          variant="panel"
          label="Send backward"
          disabled={root || !el.previousElementSibling}
          onClick={props.onBackward}
        >
          <ArrowDown />
        </ToolButton>
        <ToolButton
          variant="panel"
          label={`Duplicate (${isMac ? "⌘" : "Ctrl+"}D)`}
          disabled={root}
          onClick={props.onDuplicate}
        >
          <Copy />
        </ToolButton>
        <ToolButton
          variant="panel"
          label={point ? "Remove the point (Delete)" : "Delete (Delete)"}
          disabled={point ? !handle?.removable : root}
          onClick={props.onDelete}
        >
          <Trash2 />
        </ToolButton>
      </div>
      {handle && (
        <Section title="Point">
          <div className="flex gap-2">
            {(["x", "y"] as const).map((axis) => (
              <Field key={axis} label={axis.toUpperCase()}>
                <CommitInput
                  aria-label={`Point ${axis}`}
                  value={String(Math.round(handle[axis] * 1000) / 1000)}
                  onCommit={(text) => {
                    const n = Number.parseFloat(text);
                    if (!Number.isFinite(n)) return;
                    const to: Point = axis === "x" ? [n, handle.y] : [handle.x, n];
                    onEdit((e) => moveHandle(e, handle.id, to));
                  }}
                />
              </Field>
            ))}
          </div>
        </Section>
      )}
      <Section title="Look">
        {PAINT.map((name) => (
          <ColorField key={name} label={name === "fill" ? "Fill" : "Stroke"} value={value(name)} onChange={set(name)} />
        ))}
        <div className="flex gap-2">
          <Field label="Stroke width">
            <CommitInput aria-label="Stroke width" value={value("stroke-width")} onCommit={set("stroke-width")} live />
          </Field>
          <Field label="Opacity">
            <CommitInput aria-label="Opacity" value={value("opacity")} onCommit={set("opacity")} live />
          </Field>
        </div>
        <div className="flex gap-2">
          <Field label="Line ends">
            <select
              aria-label="Line ends"
              value={value("stroke-linecap")}
              onChange={(event) => set("stroke-linecap")(event.target.value)}
              className={wideSelectClass}
            >
              <option value="">Default</option>
              <option value="butt">Flat</option>
              <option value="round">Round</option>
              <option value="square">Square</option>
            </select>
          </Field>
          <Field label="Corners">
            <select
              aria-label="Corners"
              value={value("stroke-linejoin")}
              onChange={(event) => set("stroke-linejoin")(event.target.value)}
              className={wideSelectClass}
            >
              <option value="">Default</option>
              <option value="miter">Sharp</option>
              <option value="round">Round</option>
              <option value="bevel">Bevel</option>
            </select>
          </Field>
        </div>
        <Field label="Dashes">
          <CommitInput
            aria-label="Dashes"
            placeholder="e.g. 8 4"
            value={value("stroke-dasharray")}
            onCommit={set("stroke-dasharray")}
          />
        </Field>
      </Section>
      {textOnly && (
        <Section title="Text">
          <CommitInput
            aria-label="Text"
            multiline
            value={el.textContent ?? ""}
            onCommit={(text) =>
              onEdit((e) => {
                e.textContent = text;
              }, "text")
            }
          />
        </Section>
      )}
      <Attributes element={el} onEdit={onEdit} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel as="h2">{title}</SectionLabel>
      {children}
    </section>
  );
}

/** A paint: a color picker for plain colors, and the value as typed for anything (none, url(#…), var(--…)). */
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const hex = hexOf(value);
  return (
    <Field label={label}>
      <div className="flex gap-1.5">
        <input
          type="color"
          aria-label={`${label} color`}
          value={hex ?? SWATCHES.ink}
          onChange={(event) => onChange(event.target.value)}
          className={cn("h-7 w-9 shrink-0 cursor-pointer rounded-md border bg-background p-0.5", !hex && "opacity-50")}
        />
        <CommitInput aria-label={label} placeholder="none" value={value} onCommit={onChange} />
      </div>
    </Field>
  );
}

/**
 * A text field for a value of the drawing: it shows the value unless typed in, and changes it on
 * Enter or leaving the field (or as it is typed, when `live`). Escape takes the typing back.
 */
function CommitInput(props: {
  "aria-label": string;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  live?: boolean;
  multiline?: boolean;
}) {
  const { value, onCommit, live, multiline } = props;
  const [text, setText] = useState(value);
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setText(value);
  }, [value]);
  const commit = () => {
    typing.current = false;
    if (text !== value) onCommit(text);
  };
  const common = {
    "aria-label": props["aria-label"],
    placeholder: props.placeholder,
    value: text,
    onFocus: () => {
      typing.current = true;
    },
    onBlur: commit,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setText(event.target.value);
      if (live) onCommit(event.target.value);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        commit();
        typing.current = true;
      } else if (event.key === "Escape") {
        event.stopPropagation();
        setText(value);
      }
    },
  };
  return multiline ? (
    <textarea {...common} rows={3} className="w-full min-w-0 rounded-md border bg-background px-1.5 py-1" />
  ) : (
    <input {...common} className={inputClass} />
  );
}

/** Every attribute of the element, to change, take out or add. */
function Attributes({
  element,
  onEdit,
}: {
  element: Element;
  onEdit: (fn: (el: Element) => unknown, key?: string) => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const add = () => {
    const n = name.trim();
    if (!/^[a-zA-Z_:][-\w:.]*$/.test(n) || /^on/i.test(n)) return;
    onEdit((el) => el.setAttribute(n, value));
    setName("");
    setValue("");
  };
  return (
    <Section title="Attributes">
      <div className="flex flex-col gap-1.5">
        {[...element.attributes].map((attr) => (
          <div key={attr.name} className="flex items-center gap-1.5">
            <span className="w-24 shrink-0 truncate font-mono text-muted-foreground" title={attr.name}>
              {attr.name}
            </span>
            <CommitInput
              aria-label={`Attribute ${attr.name}`}
              value={attr.value}
              onCommit={(text) => onEdit((el) => el.setAttribute(attr.name, text), `attr:${attr.name}`)}
            />
            <ToolButton
              variant="panel"
              size="xs"
              label={`Remove ${attr.name}`}
              onClick={() => onEdit((el) => el.removeAttribute(attr.name))}
            >
              <X className="size-3.5" />
            </ToolButton>
          </div>
        ))}
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <input
            aria-label="New attribute name"
            placeholder="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={cn(inputClass, "w-24 shrink-0 font-mono")}
          />
          <input
            aria-label="New attribute value"
            placeholder="value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className={inputClass}
          />
          <ToolButton type="submit" variant="panel" size="xs" label="Add the attribute" disabled={!name.trim()}>
            <Plus className="size-3.5" />
          </ToolButton>
        </form>
      </div>
    </Section>
  );
}

/** The drawing's elements as a tree, to select any of them, even ones too small or hidden to click. */
function Layers({
  elements,
  selected,
  onSelect,
}: {
  elements: Element[];
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const root = elements[0];
  const depth = (el: Element) => {
    let n = 0;
    for (let up = el.parentElement; up && root?.contains(up); up = up.parentElement) n++;
    return n;
  };
  return (
    <ul aria-label="Layers" className="flex flex-col py-1 text-xs">
      {elements.map((el, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: an element's index is what names it.
        <li key={i}>
          <button
            type="button"
            aria-current={i === selected || undefined}
            onClick={() => onSelect(i)}
            style={{ paddingLeft: 12 + depth(el) * 12 }}
            className={cn(
              "flex w-full items-center truncate py-1 pr-3 text-left font-mono hover:bg-accent",
              i === selected && "bg-accent font-medium",
            )}
          >
            {labelOf(el)}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The drawing's markup, to edit by hand; it takes effect while it is one `<svg>`. */
function Markup({ draft, onChange }: { draft: string; onChange: (text: string) => void }) {
  const [text, setText] = useState(draft);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(draft);
  }, [draft]);
  const valid = parseSvg(text) !== null;
  return (
    <div className="flex h-full flex-col gap-1.5 p-2">
      <textarea
        aria-label="Markup"
        spellCheck={false}
        value={text}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          setText(useSvgEditor.getState().edit?.draft ?? draft);
        }}
        onChange={(event) => {
          setText(event.target.value);
          const svg = parseSvg(event.target.value);
          if (svg) onChange(serializeSvg(svg));
        }}
        className={cn(
          "min-h-40 w-full flex-1 resize-none rounded-md border bg-background p-2 font-mono text-2xs leading-relaxed",
          !valid && "border-destructive",
        )}
      />
      {!valid && (
        <p className="text-xs text-destructive">Not one &lt;svg&gt; drawing yet; the last valid markup is kept.</p>
      )}
    </div>
  );
}
