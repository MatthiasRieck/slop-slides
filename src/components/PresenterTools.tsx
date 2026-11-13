import { CircleDot, Eraser, Highlighter, MousePointer2, PenLine, Redo2, Trash2, Undo2 } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import {
  canRedoInk,
  canUndoInk,
  DEFAULT_COLORS,
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
 */
export function useAnnotations(slideKey: string, store?: InkStore): Annotations {
  const [tool, setToolState] = useState<Tool>("pointer");
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

  const commit = (next: Stroke[], history: InkHistory) => {
    const histories = { ...live.current.histories, [slideKey]: history };
    live.current = { strokes: next, histories };
    setHistories(histories);
    setInk((all) => ({ ...all, [slideKey]: next }));
  };
  const change = (fn: (strokes: Stroke[]) => Stroke[]) => {
    const before = live.current.strokes;
    const after = fn(before);
    if (after.length === before.length && after.every((stroke, i) => stroke === before[i])) return;
    commit(after, inkChanged(live.current.histories[slideKey], before, after));
  };

  const setTool = (next: Tool) => setToolState(next);
  const setColor = (color: string) => {
    const target: InkTool = tool === "highlighter" ? "highlighter" : "pen";
    setColors((c) => ({ ...c, [target]: color }));
    if (tool !== "pen" && tool !== "highlighter") setToolState("pen");
  };
  const addStroke = (stroke: Stroke) => change((s) => [...s, stroke]);
  const erase = (index: number) => change((s) => s.filter((_, i) => i !== index));
  const clear = () => change(() => []);
  const undo = () => {
    const back = undoInk(live.current.histories[slideKey], live.current.strokes);
    if (back) commit(back.strokes, back.history);
  };
  const redo = () => {
    const again = redoInk(live.current.histories[slideKey], live.current.strokes);
    if (again) commit(again.strokes, again.history);
  };

  const handleKey = (key: string, mod: boolean, shift = false): boolean => {
    const lower = key.toLowerCase();
    if (mod) {
      if (lower !== "z") return false;
      if (shift) redo();
      else undo();
    } else if (key === "Escape") {
      if (tool === "pointer") return false;
      setToolState("pointer");
    } else if (TOOL_KEYS[lower]) {
      const next = TOOL_KEYS[lower];
      setToolState(tool === next ? "pointer" : next);
    } else if (lower === "c") {
      clear();
    } else {
      return false;
    }
    setPeek((n) => n + 1);
    return true;
  };

  return {
    tool,
    setTool,
    colors,
    setColor,
    strokes,
    addStroke,
    erase,
    undo,
    redo,
    canUndo: canUndoInk(histories[slideKey], strokes),
    canRedo: canRedoInk(histories[slideKey], strokes),
    clear,
    handleKey,
    peek,
  };
}

/** No ink on a slide; one array, so a slide without ink keeps its (empty) history. */
const NO_STROKES: Stroke[] = [];

/**
 * Transparent layer over the slide that draws ink, the laser dot and, while the laser is
 * dragged, its trail, which stays a moment and then thins away. `zoom` is how far the
 * layer has been enlarged along with a zoomed slide: the ink is drawn at that size, as
 * vectors, so it stays sharp, and thickens with the slide.
 */
export function AnnotationLayer({ annotations, zoom = 1 }: { annotations: Annotations; zoom?: number }) {
  const { tool, colors, strokes, addStroke, erase } = annotations;
  const layerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Stroke | null>(null);
  const [laser, setLaser] = useState<{ x: number; y: number } | null>(null);
  const [trails, setTrails] = useState<TrailPoint[][]>([]);
  const [now, setNow] = useState(() => performance.now());
  const tracing = useRef(false);
  const trailRef = useRef<HTMLCanvasElement>(null);
  const trailCore = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const active = tool !== "pointer";

  // Ink is stored in fractions of the layer but drawn in pixels, so strokes keep their width
  // (times the zoom) as the layer resizes.
  useLayoutEffect(() => {
    const el = layerRef.current!;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({ width: el.offsetWidth || rect.width, height: el.offsetHeight || rect.height });
    };
    measure();
    // Redraw before the resized layer is painted: a zoom resizes it at once, and ink drawn a
    // frame later at the old size flickers.
    const observer = new ResizeObserver(() => flushSync(measure));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: switching tools clears any in-progress drawing
  useEffect(() => {
    setDraft(null);
    setLaser(null);
    setTrails([]);
    tracing.current = false;
  }, [tool]);

  // Animate trails until the last one has faded.
  const fading = trails.length > 0;
  useEffect(() => {
    if (!fading) return;
    let frame = requestAnimationFrame(function tick() {
      const time = performance.now();
      setNow(time);
      setTrails((t) => pruneTrails(t, time));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [fading]);

  // The trail is painted on a canvas rather than drawn as glowing SVG: WebKit leaves stale,
  // clipped pieces of a filtered SVG's glow behind as it changes.
  useLayoutEffect(() => {
    const canvas = trailRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const scale = window.devicePixelRatio || 1;
    trailCore.current ??= document.createElement("canvas");
    const core = trailCore.current;
    const coreCtx = core.getContext("2d");
    if (!coreCtx) return;
    // Only the part of the layer on screen gets a canvas: zoomed in, the layer is many times
    // the screen's size, and glowing a canvas that big every frame makes the trail crawl.
    const { left, top } = layerRef.current!.getBoundingClientRect();
    const area = visibleArea(
      { left, top, width: size.width, height: size.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    Object.assign(canvas.style, {
      left: `${area.x}px`,
      top: `${area.y}px`,
      width: `${area.width}px`,
      height: `${area.height}px`,
    });
    for (const c of [canvas, core]) {
      const [w, h] = [Math.round(area.width * scale), Math.round(area.height * scale)];
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
    }
    paintTrails(ctx, coreCtx, trails, now, size.width, size.height, scale, area);
  }, [trails, now, size]);

  const at = (event: ReactPointerEvent) =>
    toFraction(event.clientX, event.clientY, layerRef.current!.getBoundingClientRect());

  const eraseUnder = (event: ReactPointerEvent) => {
    const hit = (event.target as Element).closest?.("[data-stroke]");
    if (hit) erase(Number(hit.getAttribute("data-stroke")));
  };

  const tracePoint = (event: ReactPointerEvent): TrailPoint => {
    const [x, y] = at(event);
    return { x, y, t: performance.now() };
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
      const point = tracePoint(event);
      setNow(point.t);
      setTrails((t) => [...t, [point]]);
      return;
    }
    if (tool === "eraser") eraseUnder(event);
    if (tool !== "pen" && tool !== "highlighter") return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDraft({ tool, color: colors[tool], points: [at(event)] });
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    if (tool === "laser") {
      const rect = layerRef.current!.getBoundingClientRect();
      setLaser({ x: event.clientX - rect.left, y: event.clientY - rect.top });
      if (tracing.current && event.buttons & 1) {
        const t = performance.now();
        const points = movedThrough(event).map(([x, y]) => ({ x, y, t }));
        setNow(t);
        // The trail being drawn may have faded away entirely while the pointer rested.
        setTrails((ts) => (ts.length ? [...ts.slice(0, -1), [...ts[ts.length - 1]!, ...points]] : [points]));
      }
    } else if (tool === "eraser" && event.buttons & 1) {
      eraseUnder(event);
    } else if (draft) {
      const points = movedThrough(event);
      setDraft((d) => d && { ...d, points: [...d.points, ...points] });
    }
  };

  const finish = () => {
    if (draft) addStroke(draft);
    setDraft(null);
    tracing.current = false;
  };

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
        setLaser(null);
      }}
    >
      <svg role="img" aria-label="Presentation annotations" className="absolute inset-0 size-full">
        {[...strokes, ...(draft ? [draft] : [])].map((stroke, i) => {
          const { opacity } = INK_STYLE[stroke.tool];
          const width = INK_STYLE[stroke.tool].width * zoom;
          const points = toPixels(stroke.points, size.width, size.height);
          const common = {
            "data-stroke": i < strokes.length ? i : undefined,
            style: { pointerEvents: tool === "eraser" ? ("visiblePainted" as const) : ("none" as const) },
          };
          if (isDot(points)) {
            const [[cx, cy]] = points as [[number, number]];
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: strokes are only appended or cleared
              <circle key={i} {...common} cx={cx} cy={cy} r={width / 2} fill={stroke.color} fillOpacity={opacity} />
            );
          }
          return (
            <path
              // biome-ignore lint/suspicious/noArrayIndexKey: strokes are only appended or cleared
              key={i}
              {...common}
              d={strokePath(points)}
              fill="none"
              stroke={stroke.color}
              strokeWidth={width}
              strokeOpacity={opacity}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
      </svg>
      {trails.length > 0 && (
        <canvas ref={trailRef} data-testid="laser-trail" className="pointer-events-none absolute" />
      )}
      {laser && (
        <div
          data-testid="laser"
          className="pointer-events-none absolute -translate-1/2 rounded-full"
          style={{
            left: laser.x,
            top: laser.y,
            width: LASER_SIZE,
            height: LASER_SIZE,
            background: `rgb(${LASER_RGB})`,
            boxShadow: laserShadow,
          }}
        />
      )}
    </div>
  );
}

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
