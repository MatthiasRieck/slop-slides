import { CircleDot, Eraser, Highlighter, MousePointer2, PenLine, Redo2, Trash2, Undo2 } from "lucide-react";
import {
  memo,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import {
  appendStrokePath,
  canRedoInk,
  canUndoInk,
  clipArea,
  DEFAULT_COLORS,
  type GrowingPath,
  growingPath,
  INK_COLORS,
  INK_STYLE,
  type InkHistory,
  type InkTool,
  inkChanged,
  inkColorName,
  isDot,
  LASER_GLOW,
  LASER_RGB,
  LASER_SIZE,
  paintTrails,
  pruneTrails,
  redoInk,
  type Stroke,
  strokePath,
  TOOL_KEYS,
  type Tool,
  type TrailPoint,
  toFraction,
  toPixels,
  trailBounds,
  trailsFading,
  undoInk,
  visibleArea,
} from "../lib/ink";
import { cn } from "../lib/utils";
import { ToolButton } from "./Button";

const laserShadow = LASER_GLOW.map((g) => `0 0 ${g.blur}px ${g.spread}px rgb(${LASER_RGB} / ${g.opacity})`).join(", ");

export interface Annotations {
  tool: Tool;
  setTool: (tool: Tool) => void;
  colors: Record<InkTool, string>;
  setColor: (color: string) => void;
  /** Strokes on the slide being shown. */
  strokes: Stroke[];
  addStroke: (stroke: Stroke) => void;
  erase: (index: number) => void;
  /** Takes back the last change to the slide's ink: a stroke drawn, one erased, or all of them cleared. */
  undo: () => void;
  /** Makes the change undone last again. */
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  clear: () => void;
  /** Handles a presenter shortcut; returns false for keys that are not one. */
  handleKey: (key: string, mod: boolean, shift?: boolean) => boolean;
  /** Bumped by keyboard shortcuts so the toolbar can briefly show what changed. */
  peek: number;
}

/** Where ink lives, per slide key; by default in the hook's own state. */
export interface InkStore {
  ink: Record<string, Stroke[]>;
  setInk: (update: (all: Record<string, Stroke[]>) => Record<string, Stroke[]>) => void;
}

/**
 * Laser, pen, highlighter and eraser state, with ink kept per slide for the whole show, and what
 * became of each slide's ink (see `InkHistory`), so drawing, erasing and clearing can all be
 * undone and redone.
 *
 * What it gives back is the same object until something in it changes, and its functions are
 * the same for good: what takes them (the ink layer, the tools, effects that put a tool away)
 * then neither renders nor runs again for nothing.
 */
export function useAnnotations(slideKey: string, store?: InkStore): Annotations {
  const [tool, setTool] = useState<Tool>("pointer");
  const [colors, setColors] = useState(DEFAULT_COLORS);
  const [localInk, setLocalInk] = useState<Record<string, Stroke[]>>({});
  const { ink, setInk } = store ?? { ink: localInk, setInk: setLocalInk };
  const [histories, setHistories] = useState<Record<string, InkHistory>>({});
  const [peek, setPeek] = useState(0);
  const strokes = ink[slideKey] ?? NO_STROKES;
  // The ink and its history as they are now: several changes can come before the next render
  // (the eraser dragged over strokes), and each builds on the one before.
  const live = useRef({ strokes, histories });
  live.current = { strokes, histories };
  // What the functions below work on, as of the latest render.
  const now = useRef({ slideKey, tool, setInk });
  now.current = { slideKey, tool, setInk };

  const actions = useMemo(() => {
    const commit = (next: Stroke[], history: InkHistory) => {
      const { slideKey, setInk } = now.current;
      const histories = { ...live.current.histories, [slideKey]: history };
      live.current = { strokes: next, histories };
      setHistories(histories);
      setInk((all) => ({ ...all, [slideKey]: next }));
    };
    const change = (fn: (strokes: Stroke[]) => Stroke[]) => {
      const before = live.current.strokes;
      const after = fn(before);
      if (after.length === before.length && after.every((stroke, i) => stroke === before[i])) return;
      commit(after, inkChanged(live.current.histories[now.current.slideKey], before, after));
    };
    const clear = () => change(() => []);
    const undo = () => {
      const back = undoInk(live.current.histories[now.current.slideKey], live.current.strokes);
      if (back) commit(back.strokes, back.history);
    };
    const redo = () => {
      const again = redoInk(live.current.histories[now.current.slideKey], live.current.strokes);
      if (again) commit(again.strokes, again.history);
    };
    return {
      setColor: (color: string) => {
        const { tool } = now.current;
        const target: InkTool = tool === "highlighter" ? "highlighter" : "pen";
        setColors((c) => ({ ...c, [target]: color }));
        if (tool !== "pen" && tool !== "highlighter") setTool("pen");
      },
      addStroke: (stroke: Stroke) => change((s) => [...s, stroke]),
      erase: (index: number) => change((s) => s.filter((_, i) => i !== index)),
      clear,
      undo,
      redo,
      handleKey: (key: string, mod: boolean, shift = false): boolean => {
        const { tool } = now.current;
        const lower = key.toLowerCase();
        if (mod) {
          if (lower !== "z") return false;
          if (shift) redo();
          else undo();
        } else if (key === "Escape") {
          if (tool === "pointer") return false;
          setTool("pointer");
        } else if (TOOL_KEYS[lower]) {
          const next = TOOL_KEYS[lower];
          setTool(tool === next ? "pointer" : next);
        } else if (lower === "c") {
          clear();
        } else {
          return false;
        }
        setPeek((n) => n + 1);
        return true;
      },
    };
  }, []);

  const canUndo = canUndoInk(histories[slideKey], strokes);
  const canRedo = canRedoInk(histories[slideKey], strokes);
  return useMemo(
    () => ({ tool, setTool, colors, strokes, canUndo, canRedo, peek, ...actions }),
    [tool, colors, strokes, canUndo, canRedo, peek, actions],
  );
}

/** No ink on a slide; one array, so a slide without ink keeps its (empty) history. */
const NO_STROKES: Stroke[] = [];

/** A number for each stroke, to tell them apart by as others around them are erased. */
const strokeIds = new WeakMap<Stroke, number>();
let lastStrokeId = 0;
function strokeId(stroke: Stroke): number {
  let id = strokeIds.get(stroke);
  if (id === undefined) {
    id = ++lastStrokeId;
    strokeIds.set(stroke, id);
  }
  return id;
}

/** How a stroke is drawn, whatever its points: its color and how wide and see-through its tool makes it. */
function strokeLook(tool: InkTool, color: string, zoom: number) {
  const { opacity, width } = INK_STYLE[tool];
  return { color, opacity, width: width * zoom };
}

/**
 * One stroke of the slide's ink, on a layer `width` by `height` pixels. Its path is worked out
 * again only when the stroke or the layer's size changes: not while another stroke is drawn,
 * erased or undone, and not for the zoom alone, which only thickens it.
 */
const InkStroke = memo(function InkStroke(props: {
  stroke: Stroke;
  index: number;
  width: number;
  height: number;
  zoom: number;
  /** The eraser is out, so the stroke takes the pointer. */
  erasable: boolean;
}) {
  const { stroke, width, height } = props;
  const shape = useMemo(() => {
    const points = toPixels(stroke.points, width, height);
    return isDot(points) ? { dot: points[0]!, d: "" } : { dot: null, d: strokePath(points) };
  }, [stroke, width, height]);
  const look = strokeLook(stroke.tool, stroke.color, props.zoom);
  const common = {
    "data-stroke": props.index,
    style: { pointerEvents: props.erasable ? ("visiblePainted" as const) : ("none" as const) },
  };
  if (shape.dot) {
    const [cx, cy] = shape.dot;
    return <circle {...common} cx={cx} cy={cy} r={look.width / 2} fill={look.color} fillOpacity={look.opacity} />;
  }
  return (
    <path
      {...common}
      d={shape.d}
      fill="none"
      stroke={look.color}
      strokeWidth={look.width}
      strokeOpacity={look.opacity}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
});

/** The stroke being drawn: what it will be saved as, and its path on the layer as it grows. */
interface Draft {
  stroke: Stroke;
  path: GrowingPath;
}

/** Where the layer has the laser dot, from its top-left corner. */
const dotPlace = (at: { x: number; y: number }) => `translate(${at.x}px, ${at.y}px)`;

/**
 * Transparent layer over the slide that draws ink, the laser dot and, while the laser is
 * dragged, its trail, which stays a moment and then thins away. `zoom` is how far the
 * layer has been enlarged along with a zoomed slide: the ink is drawn at that size, as
 * vectors, so it stays sharp, and thickens with the slide.
 *
 * What follows the pointer is drawn without rendering: the stroke in hand grows by its new points
 * only, the laser dot is moved, and the trail is painted on its canvas, so a move costs the same
 * however much ink the slide has. The ink itself renders when a stroke is finished or taken away.
 */
export const AnnotationLayer = memo(function AnnotationLayer({
  annotations,
  zoom = 1,
}: {
  annotations: Annotations;
  zoom?: number;
}) {
  const { tool, colors, strokes, addStroke, erase } = annotations;
  const layerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const sizeNow = useRef(size);
  sizeNow.current = size;
  const active = tool !== "pointer";

  // The look of the stroke being drawn, which mounts what draws it; its points are `draft`'s.
  const [drafting, setDrafting] = useState<Pick<Stroke, "tool" | "color"> | null>(null);
  const draft = useRef<Draft | null>(null);
  const draftLine = useRef<SVGPathElement>(null);
  const draftDot = useRef<SVGCircleElement>(null);

  const [laserShown, setLaserShown] = useState(false);
  const laserAt = useRef({ x: 0, y: 0 });
  const laserRef = useRef<HTMLDivElement>(null);

  // Whether there are trails, which mounts their canvas; the trails themselves are `trails`'.
  const [trailing, setTrailing] = useState(false);
  const trails = useRef<TrailPoint[][]>([]);
  const tracing = useRef(false);
  const trailRef = useRef<HTMLCanvasElement>(null);
  const trailCore = useRef<HTMLCanvasElement>(null);
  // The trails were painted since the last frame of their fading.
  const paintedThisFrame = useRef(false);

  // Ink is stored in fractions of the layer but drawn in pixels, so strokes keep their width
  // (times the zoom) as the layer resizes.
  useLayoutEffect(() => {
    const el = layerRef.current!;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const next = { width: el.offsetWidth || rect.width, height: el.offsetHeight || rect.height };
      // A layer that is the size it was has nothing to draw again.
      if (sizeNow.current.width !== next.width || sizeNow.current.height !== next.height) setSize(next);
    };
    measure();
    // Redraw before the resized layer is painted: a zoom resizes it at once, and ink drawn a
    // frame later at the old size flickers.
    const observer = new ResizeObserver(() => flushSync(measure));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Shows the stroke being drawn as its path is now: a dot until it has moved. */
  const drawDraft = () => {
    const [line, dot, current] = [draftLine.current, draftDot.current, draft.current];
    if (!line || !dot || !current) return;
    const { points, d } = current.path;
    const still = isDot(points);
    if (still) {
      dot.setAttribute("cx", String(points[0]![0]));
      dot.setAttribute("cy", String(points[0]![1]));
    } else {
      line.setAttribute("d", d);
    }
    dot.style.display = still ? "" : "none";
    line.style.display = still ? "none" : "";
  };

  // The stroke being drawn shows as soon as its elements are there, and at the layer's new size
  // should it resize under the pen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `drawDraft` draws what the refs hold
  useLayoutEffect(() => {
    const current = draft.current;
    if (!current) return;
    current.path = growingPath();
    appendStrokePath(current.path, toPixels(current.stroke.points, size.width, size.height));
    drawDraft();
  }, [drafting, size]);

  /**
   * Paints the trails as they are at `time`, on a canvas over only what they and their glow
   * reach of the part of the layer on screen: zoomed in, the layer is many times the screen's
   * size, and glowing a canvas that big every frame makes the trail crawl.
   */
  const paintTrail = (time: number) => {
    const canvas = trailRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const scale = window.devicePixelRatio || 1;
    trailCore.current ??= document.createElement("canvas");
    const core = trailCore.current;
    const coreCtx = core.getContext("2d");
    if (!coreCtx) return;
    const { width, height } = sizeNow.current;
    const { left, top } = layerRef.current!.getBoundingClientRect();
    const onScreen = visibleArea(
      { left, top, width, height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    const reach = trailBounds(trails.current, width, height);
    const area = clipArea(reach ?? { x: 0, y: 0, width: 0, height: 0 }, onScreen);
    const place = { left: `${area.x}px`, top: `${area.y}px`, width: `${area.width}px`, height: `${area.height}px` };
    for (const [side, value] of Object.entries(place) as [keyof typeof place, string][]) {
      if (canvas.style[side] !== value) canvas.style[side] = value;
    }
    for (const c of [canvas, core]) {
      const [w, h] = [Math.round(area.width * scale), Math.round(area.height * scale)];
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
    }
    paintTrails(ctx, coreCtx, trails.current, time, width, height, scale, area);
    paintedThisFrame.current = true;
  };

  // The trails show as soon as their canvas is there, and at the layer's new size.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `paintTrail` paints what the refs hold
  useLayoutEffect(() => {
    if (trailing) paintTrail(performance.now());
  }, [trailing, size]);

  // Thins the trails away, frame by frame, until the last one has gone. Held trails look the
  // same from one frame to the next: only a move of the laser paints them then.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `paintTrail` paints what the refs hold
  useEffect(() => {
    if (!trailing) return;
    let frame = requestAnimationFrame(function tick() {
      const time = performance.now();
      const fading = trailsFading(trails.current, time);
      trails.current = pruneTrails(trails.current, time);
      if (trails.current.length === 0) {
        setTrailing(false);
        return;
      }
      if (fading && !paintedThisFrame.current) paintTrail(time);
      paintedThisFrame.current = false;
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [trailing]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: switching tools clears any in-progress drawing
  useEffect(() => {
    draft.current = null;
    setDrafting(null);
    setLaserShown(false);
    trails.current = [];
    setTrailing(false);
    tracing.current = false;
  }, [tool]);

  const at = (event: ReactPointerEvent) =>
    toFraction(event.clientX, event.clientY, layerRef.current!.getBoundingClientRect());

  const eraseUnder = (event: ReactPointerEvent) => {
    const hit = (event.target as Element).closest?.("[data-stroke]");
    if (hit) erase(Number(hit.getAttribute("data-stroke")));
  };

  /**
   * Where the pointer went since the last move, as fractions of the layer: the browser hands
   * out one move per frame, but keeps the samples in between, which a fast stroke needs.
   */
  const movedThrough = (event: ReactPointerEvent): [number, number][] => {
    const rect = layerRef.current!.getBoundingClientRect();
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
    return (samples.length ? samples : [event]).map((e) => toFraction(e.clientX, e.clientY, rect));
  };

  const onPointerDown = (event: ReactPointerEvent) => {
    if (!active || event.button !== 0) return;
    // Capturing the pointer alone still lets native selection highlight the slide/frame.
    event.preventDefault();
    if (tool === "laser") {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      tracing.current = true;
      const [x, y] = at(event);
      trails.current = [...trails.current, [{ x, y, t: performance.now() }]];
      setTrailing(true);
      return;
    }
    if (tool === "eraser") eraseUnder(event);
    if (tool !== "pen" && tool !== "highlighter") return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    draft.current = { stroke: { tool, color: colors[tool], points: [at(event)] }, path: growingPath() };
    setDrafting({ tool, color: colors[tool] });
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    if (tool === "laser") {
      const rect = layerRef.current!.getBoundingClientRect();
      laserAt.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (laserRef.current) laserRef.current.style.transform = dotPlace(laserAt.current);
      else setLaserShown(true);
      if (tracing.current && event.buttons & 1) {
        const t = performance.now();
        const points = movedThrough(event).map(([x, y]) => ({ x, y, t }));
        // The trail being drawn may have faded away entirely while the pointer rested.
        const drawn = trails.current.at(-1);
        if (drawn) drawn.push(...points);
        else trails.current = [points];
        if (trailRef.current) paintTrail(t);
        else setTrailing(true);
      }
    } else if (tool === "eraser" && event.buttons & 1) {
      eraseUnder(event);
    } else if (draft.current) {
      const points = movedThrough(event);
      draft.current.stroke.points.push(...points);
      appendStrokePath(draft.current.path, toPixels(points, size.width, size.height));
      drawDraft();
    }
  };

  const finish = () => {
    if (draft.current) addStroke(draft.current.stroke);
    draft.current = null;
    setDrafting(null);
    tracing.current = false;
  };

  const draftLook = drafting && strokeLook(drafting.tool, drafting.color, zoom);

  return (
    <div
      ref={layerRef}
      data-testid="annotation-layer"
      className="absolute inset-0"
      style={{
        pointerEvents: active ? "auto" : "none",
        cursor: tool === "laser" ? "none" : tool === "eraser" ? "cell" : active ? "crosshair" : undefined,
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onPointerLeave={() => {
        finish();
        setLaserShown(false);
      }}
    >
      <svg role="img" aria-label="Presentation annotations" className="absolute inset-0 size-full">
        {strokes.map((stroke, i) => (
          <InkStroke
            key={strokeId(stroke)}
            stroke={stroke}
            index={i}
            width={size.width}
            height={size.height}
            zoom={zoom}
            erasable={tool === "eraser"}
          />
        ))}
        {draftLook && (
          // One of the two shows (see `drawDraft`): a stroke that has not moved yet is a dot.
          <g data-testid="ink-draft" pointerEvents="none">
            <circle ref={draftDot} r={draftLook.width / 2} fill={draftLook.color} fillOpacity={draftLook.opacity} />
            <path
              ref={draftLine}
              fill="none"
              stroke={draftLook.color}
              strokeWidth={draftLook.width}
              strokeOpacity={draftLook.opacity}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        )}
      </svg>
      {trailing && <canvas ref={trailRef} data-testid="laser-trail" className="pointer-events-none absolute" />}
      {laserShown && (
        <div
          ref={laserRef}
          data-testid="laser"
          className="pointer-events-none absolute top-0 left-0 -translate-1/2 rounded-full"
          style={{
            transform: dotPlace(laserAt.current),
            width: LASER_SIZE,
            height: LASER_SIZE,
            background: `rgb(${LASER_RGB})`,
            boxShadow: laserShadow,
          }}
        />
      )}
    </div>
  );
});

/**
 * The presenter's ink tools, as the buttons of a toolbar: the tools, the colors of the pen and
 * the highlighter while one is picked, then undo, redo and clear. They leave keyboard focus where
 * it was, so Space still advances the slide instead of pressing the button again.
 */
export function InkTools({ annotations }: { annotations: Annotations }) {
  const { tool, setTool, colors, setColor, strokes, undo, redo, canUndo, canRedo, clear } = annotations;
  const inking = tool === "pen" || tool === "highlighter";

  return (
    <>
      <ToolButton
        variant="presenter"
        keepFocus
        label="Pointer (Esc)"
        active={tool === "pointer"}
        onClick={() => setTool("pointer")}
      >
        <MousePointer2 />
      </ToolButton>
      <ToolButton
        variant="presenter"
        keepFocus
        label="Laser pointer (L)"
        active={tool === "laser"}
        onClick={() => setTool("laser")}
      >
        <CircleDot />
      </ToolButton>
      <ToolButton variant="presenter" keepFocus label="Pen (P)" active={tool === "pen"} onClick={() => setTool("pen")}>
        <PenLine />
      </ToolButton>
      <ToolButton
        variant="presenter"
        keepFocus
        label="Highlighter (H)"
        active={tool === "highlighter"}
        onClick={() => setTool("highlighter")}
      >
        <Highlighter />
      </ToolButton>
      <ToolButton
        variant="presenter"
        keepFocus
        label="Eraser (E)"
        active={tool === "eraser"}
        onClick={() => setTool("eraser")}
      >
        <Eraser />
      </ToolButton>
      {inking && (
        <div className="mx-1 flex items-center gap-1">
          {INK_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={inkColorName(color)}
              title={inkColorName(color)}
              aria-pressed={colors[tool] === color}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setColor(color)}
              className={cn(
                "size-5 rounded-full border border-foreground/20",
                colors[tool] === color && "ring-2 ring-foreground ring-offset-1 ring-offset-background",
              )}
              style={{ background: color }}
            />
          ))}
        </div>
      )}
      <div className="mx-1 h-5 w-px bg-foreground/15" />
      <ToolButton
        variant="presenter"
        keepFocus
        label="Undo"
        shortcut="mod+z"
        disabled={!canUndo}
        disabledReason="Nothing to undo on this slide"
        onClick={undo}
      >
        <Undo2 />
      </ToolButton>
      <ToolButton
        variant="presenter"
        keepFocus
        label="Redo"
        shortcut="mod+shift+z"
        disabled={!canRedo}
        disabledReason="Nothing to redo on this slide"
        onClick={redo}
      >
        <Redo2 />
      </ToolButton>
      <ToolButton
        variant="presenter"
        keepFocus
        label="Clear slide (C)"
        disabled={strokes.length === 0}
        disabledReason="No ink on this slide"
        onClick={clear}
      >
        <Trash2 />
      </ToolButton>
    </>
  );
}
