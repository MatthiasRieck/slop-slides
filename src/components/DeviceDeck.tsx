import {
  ChevronLeft,
  ChevronRight,
  Eraser,
  Eye,
  EyeOff,
  Hand,
  Highlighter,
  LayoutList,
  Maximize,
  MessageSquare,
  PenLine,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import type { Slide } from "../lib/api";
import {
  clampView,
  doubleTapView,
  fitSlide,
  HOME,
  pageScale,
  pinchView,
  swipeDirection,
  type DeviceView,
  type Point,
  type Size,
} from "../lib/deviceView";
import { INK_COLORS, type Stroke, type Tool } from "../lib/ink";
import { cn } from "../lib/utils";
import { useApp } from "../store";
import { ChatPanel } from "./ChatPanel";
import { AnnotationLayer, useAnnotations, type Annotations } from "./PresenterTools";
import { SlideFrame, useSlideVersion } from "./SlideFrame";

/** Longest press (ms) and furthest move (CSS px) that still count as a tap. */
const TAP_MS = 300;
const TAP_SLOP = 10;
/** Longest gap (ms) and distance (CSS px) between the taps of a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 40;

/**
 * The open deck on a phone or tablet: the current slide, full screen, and nothing else of the
 * desktop editor. The desktop's slide pages (a 1920×1080 page per thumbnail, a pasteboard around
 * the stage) are more than iOS lets a page hold, so here there is one page, sized to the screen
 * (see findings.md). The view zooms and pans the slide itself, and swipes change slides. Marks
 * drawn here are the deck's review marks, as in the editor, and go to the agent from the chat.
 */
export function DeviceDeck() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const sketches = useApp((s) => s.sketches);
  const reviewVisible = useApp((s) => s.reviewVisible);
  const running = useApp((s) => s.running);
  const annotations = useAnnotations(selected ?? "", {
    ink: reviewVisible ? sketches : NO_INK,
    setInk: useApp.getState().setSketches,
  });
  const [sheet, setSheet] = useState<"chat" | "slides" | null>(null);
  const [chrome, setChrome] = useState(true);

  // A pen shows the review marks, so the new ones are not drawn blind.
  useEffect(() => {
    if (annotations.tool !== "pointer") useApp.getState().setReviewVisible(true);
  }, [annotations.tool]);

  useDeviceKeyboard();

  if (!deck) return null;
  const index = deck.slides.findIndex((s) => s.id === selected);
  const slide = deck.slides[index];

  return (
    <div data-testid="device-deck" className="fixed inset-0 overflow-hidden bg-neutral-950 text-white select-none">
      {slide ? (
        <SlideViewport
          key={slide.id}
          deckId={deck.id}
          slide={slide}
          annotations={annotations}
          onTap={() => setChrome((c) => !c)}
        />
      ) : (
        <div className="flex h-full items-center justify-center px-8 text-center text-sm text-white/60">
          No slides yet. Ask the agent for some in the chat.
        </div>
      )}

      <header
        className={cn(
          "absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 pb-6 pt-[max(0.5rem,env(safe-area-inset-top))] transition-opacity",
          !chrome && "pointer-events-none opacity-0",
        )}
      >
        <BarButton label="All decks" onClick={() => void useApp.getState().closeDeck()}>
          <ChevronLeft />
        </BarButton>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{deck.title}</span>
        <BarButton label="Chat" active={sheet === "chat"} onClick={() => setSheet("chat")}>
          <MessageSquare />
          {running && <span data-testid="agent-running" className="absolute right-1 top-1 size-2 animate-pulse rounded-full bg-primary" />}
        </BarButton>
      </header>

      {deck.slides.length > 0 && (
        <footer
          className={cn(
            "absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-gradient-to-t from-black/70 to-transparent px-3 pt-6 pb-[max(0.5rem,env(safe-area-inset-bottom))] transition-opacity",
            !chrome && "pointer-events-none opacity-0",
          )}
        >
          {slide && <InkTools annotations={annotations} />}
          <div className="flex items-center gap-1">
            <BarButton label="Previous slide" disabled={index <= 0} onClick={() => useApp.getState().selectRelative(-1)}>
              <ChevronLeft />
            </BarButton>
            <button
              type="button"
              aria-label="All slides"
              onClick={() => setSheet("slides")}
              className="flex h-9 items-center gap-1.5 rounded-full px-3 text-sm tabular-nums hover:bg-white/10 [&_svg]:size-4"
            >
              <LayoutList />
              {index + 1} / {deck.slides.length}
            </button>
            <BarButton
              label="Next slide"
              disabled={index >= deck.slides.length - 1}
              onClick={() => useApp.getState().selectRelative(1)}
            >
              <ChevronRight />
            </BarButton>
          </div>
        </footer>
      )}

      {sheet === "slides" && <SlidePicker onClose={() => setSheet(null)} />}
      {sheet === "chat" && (
        <Sheet label="Chat" onClose={() => setSheet(null)} side>
          <ChatPanel />
        </Sheet>
      )}
    </div>
  );
}

/**
 * The slide, fit to the screen, with its marks on top. One finger draws with a pen, or pans a
 * zoomed slide and swipes to the next one; two fingers pinch to zoom; a double tap zooms in and
 * back out.
 */
function SlideViewport(props: { deckId: string; slide: Slide; annotations: Annotations; onTap: () => void }) {
  const { annotations } = props;
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Size>({ width: 0, height: 0 });
  const [view, setView] = useState<DeviceView>(HOME);
  // How much larger than the fit slide its page is drawn; follows the zoom once a gesture ends.
  const [page, setPage] = useState(1);
  const [pinching, setPinching] = useState(false);
  const gesture = useRef<Gesture>({ pointers: new Map(), mode: "none", view: HOME, from: [], time: 0 });
  const lastTap = useRef<{ time: number; at: Point } | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const version = useSlideVersion(props.slide);

  useLayoutEffect(() => {
    const el = areaRef.current!;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setArea({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => clearTimeout(tapTimer.current), []);

  const slide = fitSlide(area);
  // A turned or resized screen fits the slide anew.
  useEffect(() => {
    setView(HOME);
    setPage(1);
  }, [area.width, area.height]);

  const viewRef = useRef(view);
  viewRef.current = view;
  const show = (next: DeviceView) => {
    const clamped = clampView(next, slide, area);
    viewRef.current = clamped;
    setView(clamped);
  };
  const settle = () => setPage(pageScale(viewRef.current.k, slide.width));

  /** Pointer position relative to the screen's center. */
  const at = (event: ReactPointerEvent): Point => {
    const rect = areaRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };
  const pair = (g: Gesture) => [...g.pointers.values()].slice(0, 2) as [Point, Point];

  const onDown = (event: ReactPointerEvent) => {
    const g = gesture.current;
    g.pointers.set(event.pointerId, at(event));
    if (g.pointers.size === 1) {
      g.mode = annotations.tool === "pointer" ? "pan" : "ink";
      g.view = viewRef.current;
      g.from = [at(event)];
      g.time = Date.now();
    } else {
      // A second finger makes it a pinch, whatever the first one was doing; the ink never sees it.
      event.stopPropagation();
      if (g.pointers.size === 2) {
        g.mode = "pinch";
        g.view = viewRef.current;
        g.from = pair(g);
        setPinching(true);
      }
    }
  };

  const onMove = (event: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g.pointers.has(event.pointerId)) return;
    g.pointers.set(event.pointerId, at(event));
    if (g.mode === "pinch") {
      event.stopPropagation();
      if (g.pointers.size >= 2) show(pinchView(g.view, g.from as [Point, Point], pair(g)));
    } else if (g.mode === "pan" && g.view.k > 1) {
      const [from] = g.from as [Point];
      const to = at(event);
      show({ x: g.view.x + to.x - from.x, y: g.view.y + to.y - from.y, k: g.view.k });
    }
  };

  const onUp = (event: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g.pointers.has(event.pointerId)) return;
    g.pointers.delete(event.pointerId);
    const point = at(event);
    if (g.mode === "pinch") event.stopPropagation();
    if (g.pointers.size > 0) return;
    const mode = g.mode;
    g.mode = "none";
    if (mode === "pinch") {
      setPinching(false);
      settle();
    } else if (mode === "pan" && event.type === "pointerup") {
      const [from] = g.from as [Point];
      const [dx, dy] = [point.x - from.x, point.y - from.y];
      if (Math.hypot(dx, dy) < TAP_SLOP && Date.now() - g.time < TAP_MS) tap(point);
      else if (g.view.k === 1) {
        const direction = swipeDirection(dx, dy);
        if (direction) useApp.getState().selectRelative(direction);
      } else settle();
    }
  };

  // A tap shows or hides the bars, unless a second one makes it a double tap.
  const tap = (point: Point) => {
    const last = lastTap.current;
    const now = Date.now();
    clearTimeout(tapTimer.current);
    if (last && now - last.time < DOUBLE_TAP_MS && Math.hypot(point.x - last.at.x, point.y - last.at.y) < DOUBLE_TAP_SLOP) {
      lastTap.current = null;
      show(doubleTapView(viewRef.current, point));
      settle();
      return;
    }
    lastTap.current = { time: now, at: point };
    tapTimer.current = setTimeout(props.onTap, DOUBLE_TAP_MS);
  };

  const zoomed = view.k !== 1;
  return (
    <div
      ref={areaRef}
      data-testid="device-stage"
      className="absolute inset-0"
      style={{ touchAction: "none" }}
      onPointerDownCapture={onDown}
      onPointerMoveCapture={onMove}
      onPointerUpCapture={onUp}
      onPointerCancelCapture={onUp}
    >
      {slide.width > 0 && (
        <div
          data-testid="device-slide"
          className="absolute top-1/2 left-1/2"
          style={{
            width: slide.width,
            height: slide.height,
            marginLeft: -slide.width / 2,
            marginTop: -slide.height / 2,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          }}
        >
          {/* The page is drawn as large as the slide is shown (up to a limit), so it stays sharp when zoomed. */}
          <div
            data-testid="device-page"
            className="absolute top-0 left-0 origin-top-left"
            style={{ width: slide.width * page, transform: page === 1 ? undefined : `scale(${1 / page})` }}
          >
            <SlideFrame deckId={props.deckId} slideId={props.slide.id} version={version} />
          </div>
          {/* Touches go to the view, not into the slide's page. */}
          <div className="absolute inset-0" />
          <AnnotationLayer annotations={annotations} suspended={pinching} />
        </div>
      )}
      {zoomed && (
        <button
          type="button"
          aria-label="Fit the slide to the screen"
          onClick={() => {
            show(HOME);
            setPage(1);
          }}
          className="absolute top-[max(3.5rem,calc(env(safe-area-inset-top)+3rem))] right-3 flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-xs tabular-nums [&_svg]:size-3.5"
        >
          <Maximize />
          {Math.round(view.k * 100)}%
        </button>
      )}
    </div>
  );
}

interface Gesture {
  pointers: Map<number, Point>;
  /** pan: one finger, no pen (pans when zoomed, else swipes or taps); ink: the pen has it. */
  mode: "none" | "pan" | "ink" | "pinch";
  /** The view and pointers when the gesture started. */
  view: DeviceView;
  from: Point[];
  time: number;
}

/** Hand, pen, highlighter, eraser and their colors, undo and clear, and showing the marks. */
function InkTools({ annotations }: { annotations: Annotations }) {
  const { tool, setTool, colors, setColor, strokes, undo, clear } = annotations;
  const reviewVisible = useApp((s) => s.reviewVisible);
  const hasReview = useApp((s) => Object.values(s.sketches).some((marks) => marks.length > 0));
  const inking = tool === "pen" || tool === "highlighter";
  const pick = (next: Tool) => setTool(tool === next ? "pointer" : next);

  return (
    <div role="toolbar" aria-label="Sketch tools" className="flex items-center gap-0.5 rounded-full bg-black/60 p-1 backdrop-blur">
      <BarButton label="Move the slide" active={tool === "pointer"} onClick={() => setTool("pointer")}>
        <Hand />
      </BarButton>
      <BarButton label="Draw on the slide" active={tool === "pen"} onClick={() => pick("pen")}>
        <PenLine />
      </BarButton>
      <BarButton label="Highlight on the slide" active={tool === "highlighter"} onClick={() => pick("highlighter")}>
        <Highlighter />
      </BarButton>
      <BarButton label="Erase marks" active={tool === "eraser"} onClick={() => pick("eraser")}>
        <Eraser />
      </BarButton>
      {inking && (
        <div className="mx-1 flex items-center gap-1.5">
          {INK_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Color ${color}`}
              aria-pressed={colors[tool] === color}
              onClick={() => setColor(color)}
              className={cn(
                "size-6 rounded-full border border-white/30",
                colors[tool] === color && "ring-2 ring-white ring-offset-1 ring-offset-black",
              )}
              style={{ background: color }}
            />
          ))}
        </div>
      )}
      <BarButton label="Undo mark" disabled={strokes.length === 0} onClick={undo}>
        <Undo2 />
      </BarButton>
      <BarButton label="Clear marks on this slide" disabled={strokes.length === 0} onClick={clear}>
        <Trash2 />
      </BarButton>
      {hasReview && (
        <BarButton
          label={reviewVisible ? "Hide review marks" : "Show review marks"}
          onClick={() => {
            // Hidden marks can't be drawn on, so the tools go away with them.
            if (reviewVisible) setTool("pointer");
            useApp.getState().setReviewVisible(!reviewVisible);
          }}
        >
          {reviewVisible ? <Eye /> : <EyeOff />}
        </BarButton>
      )}
    </div>
  );
}

/** Every slide by number, grouped by section, to jump to. */
function SlidePicker({ onClose }: { onClose: () => void }) {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  if (!deck) return null;
  return (
    <Sheet label="Slides" onClose={onClose}>
      <ol className="flex flex-col gap-1 overflow-y-auto p-3">
        {deck.slides.map((slide, i) => {
          const section = deck.sections.find((s) => s.before === i);
          return (
            <li key={slide.id}>
              {section && <div className="px-2 pt-3 pb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">{section.title}</div>}
              <button
                type="button"
                aria-current={slide.id === selected || undefined}
                onClick={() => {
                  useApp.getState().select(slide.id);
                  onClose();
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm hover:bg-accent",
                  slide.id === selected && "bg-accent font-medium",
                  slide.hidden && "text-muted-foreground",
                )}
              >
                <span className="w-6 text-right tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{slide.id}</span>
                {slide.hidden && <span className="text-2xs">hidden</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </Sheet>
  );
}

/** A panel over the slide: the whole screen on a phone, a side panel (`side`) or centered card on a tablet. */
function Sheet(props: { label: string; side?: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <div
      role="dialog"
      aria-label={props.label}
      className={cn(
        "absolute inset-0 z-20 flex flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground select-text",
        props.side ? "md:left-auto md:w-[400px] md:border-l" : "md:inset-x-auto md:left-1/2 md:w-[420px] md:-translate-x-1/2",
      )}
      style={{ touchAction: "manipulation" }}
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-3">
        <span className="text-sm font-medium">{props.label}</span>
        <button
          type="button"
          aria-label={`Close ${props.label.toLowerCase()}`}
          onClick={props.onClose}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4"
        >
          <X />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
    </div>
  );
}

function BarButton(props: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "relative flex size-9 items-center justify-center rounded-full text-white/85 hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-5",
        props.active && "bg-white/20 text-white",
      )}
    >
      {props.children}
    </button>
  );
}

/** A tablet's keyboard: the arrow keys and Page Up / Page Down change slides, unless the user is typing. */
function useDeviceKeyboard() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable]")) return;
      if (["ArrowDown", "ArrowRight", "PageDown"].includes(event.key)) useApp.getState().selectRelative(1);
      else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(event.key)) useApp.getState().selectRelative(-1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

const NO_INK: Record<string, Stroke[]> = {};
