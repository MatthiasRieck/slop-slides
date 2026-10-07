import {
  ChevronLeft,
  ChevronRight,
  Eraser,
  Eye,
  EyeOff,
  Hand,
  Highlighter,
  LayoutList,
  MessageSquare,
  PenLine,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import type { Slide } from "../lib/api";
import { deckPageVersion, fitSlide, swipeDirection, type Size } from "../lib/deviceView";
import { INK_COLORS, type Stroke, type Tool } from "../lib/ink";
import { cn } from "../lib/utils";
import { useApp } from "../store";
import { ChatPanel } from "./ChatPanel";
import { AnnotationLayer, useAnnotations, type Annotations } from "./PresenterTools";
import { SlideFrame } from "./SlideFrame";

/**
 * The open deck on a phone or tablet: the current slide, fit to the screen, and a bar of tools
 * below it. The desktop's slide pages (a 1920×1080 page per thumbnail, a pasteboard around the
 * stage) are more than iOS lets a page hold, so here there is one page for the deck, sized to
 * the slide (see findings.md). The stack is kept flat for speed: no zoom or pan (iOS redraws
 * transformed and resized pages, and blurs anything over them, on every change), and the bar
 * sits beside the slide, not over it. Marks drawn here are the deck's review marks, as in the
 * editor, and go to the agent from the chat.
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

  // A pen shows the review marks, so the new ones are not drawn blind.
  useEffect(() => {
    if (annotations.tool !== "pointer") useApp.getState().setReviewVisible(true);
  }, [annotations.tool]);

  useDeviceKeyboard();

  if (!deck) return null;
  const index = deck.slides.findIndex((s) => s.id === selected);
  const slide = deck.slides[index];

  return (
    <div
      data-testid="device-deck"
      className="fixed inset-0 flex flex-col overflow-hidden bg-neutral-950 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] text-white select-none"
    >
      {slide ? (
        <SlideArea deckId={deck.id} slide={slide} annotations={annotations} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center text-sm text-white/60">
          No slides yet. Ask the agent for some in the chat.
        </div>
      )}

      <nav className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-white/10 px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
        <BarButton label="All decks" onClick={() => void useApp.getState().closeDeck()}>
          <ChevronLeft />
        </BarButton>
        {slide && <InkTools annotations={annotations} />}
        <div className="flex items-center gap-1">
          {deck.slides.length > 0 && (
            <>
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
            </>
          )}
          <BarButton label="Chat" active={sheet === "chat"} onClick={() => setSheet("chat")}>
            <MessageSquare />
            {running && <span data-testid="agent-running" className="absolute right-1 top-1 size-2 animate-pulse rounded-full bg-primary" />}
          </BarButton>
        </div>
      </nav>

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
 * The slide, fit to the space above the bar, with its marks on top. With the hand, a swipe
 * changes slides; with a pen, a finger or pencil draws.
 */
function SlideArea(props: { deckId: string; slide: Slide; annotations: Annotations }) {
  const { annotations } = props;
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Size>({ width: 0, height: 0 });
  const swipe = useRef<{ pointer: number; x: number; y: number } | null>(null);
  // One page holds the whole deck and switches slides in place (`slop:show`); it reloads only
  // when the deck changes, starting on the slide shown then.
  const version = useApp((s) => (s.deck ? deckPageVersion(s.deck, s.assetsRev) : ""));
  const [loaded, setLoaded] = useState({ slide: props.slide.id, version });
  if (loaded.version !== version) setLoaded({ slide: props.slide.id, version });
  const pageRef = useRef<HTMLDivElement>(null);
  const current = useRef(props.slide.id);
  current.current = props.slide.id;
  const showSlide = (frame: HTMLIFrameElement) =>
    frame.contentWindow?.postMessage({ type: "slop:show", slide: current.current }, "*");

  useLayoutEffect(() => {
    const el = areaRef.current!;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setArea({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // `touch-action: none` alone does not always keep Safari from scrolling or zooming on a drag,
  // and when it takes the touch over it cancels the pointer, cutting off the stroke or swipe.
  useEffect(() => {
    const el = areaRef.current!;
    const hold = (event: TouchEvent) => event.preventDefault();
    el.addEventListener("touchmove", hold, { passive: false });
    return () => el.removeEventListener("touchmove", hold);
  }, []);
  useEffect(() => {
    pageRef.current?.querySelectorAll("iframe").forEach(showSlide);
  }, [props.slide.id]);

  const slide = fitSlide(area);

  // Pens get the pointer first (the ink layer is on top); only the hand swipes.
  const onDown = (event: ReactPointerEvent) => {
    if (annotations.tool !== "pointer") return;
    // A second finger is not a swipe.
    swipe.current = swipe.current ? null : { pointer: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onUp = (event: ReactPointerEvent) => {
    const start = swipe.current;
    if (start?.pointer !== event.pointerId) return;
    swipe.current = null;
    const direction = swipeDirection(event.clientX - start.x, event.clientY - start.y);
    if (direction) useApp.getState().selectRelative(direction);
  };

  return (
    <div
      ref={areaRef}
      data-testid="device-stage"
      className="flex min-h-0 flex-1 items-center justify-center"
      style={{ touchAction: "none" }}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerCancel={() => (swipe.current = null)}
    >
      {slide.width > 0 && (
        <div data-testid="device-slide" className="relative shrink-0" style={{ width: slide.width, height: slide.height }}>
          {/* Slides show in their final state: the fade and the staggered entrance animations take
              over a second per slide, which made every swipe look slow. */}
          <div ref={pageRef} className="absolute inset-0">
            <SlideFrame deckId={props.deckId} slideId={loaded.slide} version={version} still onFrameReady={showSlide} />
          </div>
          {/* Touches go to the view, not into the slide's page. */}
          <div className="absolute inset-0" />
          <AnnotationLayer annotations={annotations} />
        </div>
      )}
    </div>
  );
}

/** Hand, pen, highlighter, eraser and their colors, undo and clear, and showing the marks. */
function InkTools({ annotations }: { annotations: Annotations }) {
  const { tool, setTool, colors, setColor, strokes, undo, clear } = annotations;
  const reviewVisible = useApp((s) => s.reviewVisible);
  const hasReview = useApp((s) => Object.values(s.sketches).some((marks) => marks.length > 0));
  const inking = tool === "pen" || tool === "highlighter";
  const pick = (next: Tool) => setTool(tool === next ? "pointer" : next);

  return (
    <div role="toolbar" aria-label="Sketch tools" className="flex items-center gap-0.5">
      <BarButton label="Swipe between slides" active={tool === "pointer"} onClick={() => setTool("pointer")}>
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
