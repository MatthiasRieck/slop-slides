import { Eraser, Highlighter, MousePointer2, PenLine, Trash2, Undo2, Wand2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import {
  DEFAULT_COLORS,
  INK_COLORS,
  INK_STYLE,
  isDot,
  strokePath,
  TOOL_KEYS,
  toFraction,
  toPixels,
  type InkTool,
  type Stroke,
  type Tool,
} from "../lib/ink";
import { cn } from "../lib/utils";

/** How long the toolbar stays visible after a keyboard shortcut changes something. */
const PEEK_MS = 1500;

export interface Annotations {
  tool: Tool;
  setTool: (tool: Tool) => void;
  colors: Record<InkTool, string>;
  setColor: (color: string) => void;
  /** Strokes on the slide being shown. */
  strokes: Stroke[];
  addStroke: (stroke: Stroke) => void;
  erase: (index: number) => void;
  undo: () => void;
  clear: () => void;
  /** Handles a presenter shortcut; returns false for keys that are not one. */
  handleKey: (key: string, mod: boolean) => boolean;
  /** Bumped by keyboard shortcuts so the toolbar can briefly show what changed. */
  peek: number;
}

/** Where ink lives, per slide key; by default in the hook's own state. */
export interface InkStore {
  ink: Record<string, Stroke[]>;
  setInk: (update: (all: Record<string, Stroke[]>) => Record<string, Stroke[]>) => void;
}

/** Laser, pen, highlighter and eraser state, with ink kept per slide for the whole show. */
export function useAnnotations(slideKey: string, store?: InkStore): Annotations {
  const [tool, setToolState] = useState<Tool>("pointer");
  const [colors, setColors] = useState(DEFAULT_COLORS);
  const [localInk, setLocalInk] = useState<Record<string, Stroke[]>>({});
  const { ink, setInk } = store ?? { ink: localInk, setInk: setLocalInk };
  const [peek, setPeek] = useState(0);
  const strokes = ink[slideKey] ?? [];

  const update = (fn: (strokes: Stroke[]) => Stroke[]) =>
    setInk((all) => ({ ...all, [slideKey]: fn(all[slideKey] ?? []) }));

  const setTool = (next: Tool) => setToolState(next);
  const setColor = (color: string) => {
    const target: InkTool = tool === "highlighter" ? "highlighter" : "pen";
    setColors((c) => ({ ...c, [target]: color }));
    if (tool !== "pen" && tool !== "highlighter") setToolState("pen");
  };
  const addStroke = (stroke: Stroke) => update((s) => [...s, stroke]);
  const erase = (index: number) => update((s) => s.filter((_, i) => i !== index));
  const undo = () => update((s) => s.slice(0, -1));
  const clear = () => update(() => []);

  const handleKey = (key: string, mod: boolean): boolean => {
    const lower = key.toLowerCase();
    if (mod) {
      if (lower !== "z") return false;
      undo();
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

  return { tool, setTool, colors, setColor, strokes, addStroke, erase, undo, clear, handleKey, peek };
}

/** Transparent layer over the slide that draws ink and the laser dot. */
export function AnnotationLayer({ annotations }: { annotations: Annotations }) {
  const { tool, colors, strokes, addStroke, erase } = annotations;
  const layerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Stroke | null>(null);
  const [laser, setLaser] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const active = tool !== "pointer";

  // Ink is stored in fractions of the layer but drawn in pixels, so strokes keep their width.
  useLayoutEffect(() => {
    const el = layerRef.current!;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setDraft(null);
    setLaser(null);
  }, [tool]);

  const at = (event: ReactPointerEvent) =>
    toFraction(event.clientX, event.clientY, layerRef.current!.getBoundingClientRect());

  const eraseUnder = (event: ReactPointerEvent) => {
    const hit = (event.target as Element).closest?.("[data-stroke]");
    if (hit) erase(Number(hit.getAttribute("data-stroke")));
  };

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    if (tool === "eraser") eraseUnder(event);
    if (tool !== "pen" && tool !== "highlighter") return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDraft({ tool, color: colors[tool], points: [at(event)] });
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    if (tool === "laser") {
      const rect = layerRef.current!.getBoundingClientRect();
      setLaser({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    } else if (tool === "eraser" && event.buttons & 1) {
      eraseUnder(event);
    } else if (draft) {
      const point = at(event);
      setDraft((d) => d && { ...d, points: [...d.points, point] });
    }
  };

  const finish = () => {
    if (draft) addStroke(draft);
    setDraft(null);
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
      <svg className="absolute inset-0 size-full">
        {[...strokes, ...(draft ? [draft] : [])].map((stroke, i) => {
          const { width, opacity } = INK_STYLE[stroke.tool];
          const points = toPixels(stroke.points, size.width, size.height);
          const common = {
            "data-stroke": i < strokes.length ? i : undefined,
            style: { pointerEvents: tool === "eraser" ? ("visiblePainted" as const) : ("none" as const) },
          };
          if (isDot(points)) {
            const [[cx, cy]] = points as [[number, number]];
            return <circle key={i} {...common} cx={cx} cy={cy} r={width / 2} fill={stroke.color} fillOpacity={opacity} />;
          }
          return (
            <path
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
      {laser && (
        <div
          data-testid="laser"
          className="pointer-events-none absolute size-4 -translate-1/2 rounded-full bg-red-500"
          style={{
            left: laser.x,
            top: laser.y,
            boxShadow: "0 0 8px 4px rgb(239 68 68 / 70%), 0 0 24px 10px rgb(239 68 68 / 35%)",
          }}
        />
      )}
    </div>
  );
}

/**
 * Tool palette in the bottom-left corner. Hidden while presenting; appears when the mouse
 * moves into the corner, and briefly after a keyboard shortcut.
 */
export function PresenterToolbar({ annotations, onExit }: { annotations: Annotations; onExit: () => void }) {
  const { tool, setTool, colors, setColor, strokes, undo, clear, peek } = annotations;
  const [hovered, setHovered] = useState(false);
  const [peeking, setPeeking] = useState(true);

  useEffect(() => {
    setPeeking(true);
    const timer = setTimeout(() => setPeeking(false), PEEK_MS);
    return () => clearTimeout(timer);
  }, [peek]);

  const visible = hovered || peeking;
  const inking = tool === "pen" || tool === "highlighter";

  return (
    <div
      data-testid="presenter-toolbar-zone"
      className="absolute bottom-0 left-0 z-10 p-4"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        role="toolbar"
        aria-label="Presenter tools"
        data-visible={visible}
        className={cn(
          "flex items-center gap-1 rounded-xl border border-white/10 bg-neutral-900/85 p-1.5 text-white shadow-lg backdrop-blur transition-opacity duration-200",
          visible ? "opacity-100" : "opacity-0",
        )}
      >
        <ToolButton label="Pointer (Esc)" active={tool === "pointer"} onClick={() => setTool("pointer")}>
          <MousePointer2 />
        </ToolButton>
        <ToolButton label="Laser pointer (L)" active={tool === "laser"} onClick={() => setTool("laser")}>
          <Wand2 />
        </ToolButton>
        <ToolButton label="Pen (P)" active={tool === "pen"} onClick={() => setTool("pen")}>
          <PenLine />
        </ToolButton>
        <ToolButton label="Highlighter (H)" active={tool === "highlighter"} onClick={() => setTool("highlighter")}>
          <Highlighter />
        </ToolButton>
        <ToolButton label="Eraser (E)" active={tool === "eraser"} onClick={() => setTool("eraser")}>
          <Eraser />
        </ToolButton>
        {inking && (
          <div className="mx-1 flex items-center gap-1">
            {INK_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Color ${color}`}
                aria-pressed={colors[tool] === color}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setColor(color)}
                className={cn(
                  "size-5 rounded-full border border-white/30",
                  colors[tool] === color && "ring-2 ring-white ring-offset-1 ring-offset-neutral-900",
                )}
                style={{ background: color }}
              />
            ))}
          </div>
        )}
        <div className="mx-1 h-5 w-px bg-white/15" />
        <ToolButton label="Undo (⌘Z)" disabled={strokes.length === 0} onClick={undo}>
          <Undo2 />
        </ToolButton>
        <ToolButton label="Clear slide (C)" disabled={strokes.length === 0} onClick={clear}>
          <Trash2 />
        </ToolButton>
        <ToolButton label="End show (Esc)" onClick={onExit}>
          <X />
        </ToolButton>
      </div>
    </div>
  );
}

function ToolButton(props: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      // Keep keyboard focus where it was, so Space still advances the slide instead of re-clicking.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4",
        props.active && "bg-white/20 text-white",
      )}
    >
      {props.children}
    </button>
  );
}
