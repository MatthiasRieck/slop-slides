import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronLeft, ChevronRight, type LucideIcon, Maximize, PanelRight, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, type Deck, errorMessage } from "../lib/api";
import { zoomBox } from "../lib/ink";
import { layoutTimeline } from "../lib/timeline";
import { playTimeline } from "../lib/timelinePlayback";
import { cn, fileUrl } from "../lib/utils";
import { loadVideoOptions } from "../lib/video";
import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { PresenterPanel } from "./PresenterPanel";
import { AnnotationLayer, PresenterToolbar, useAnnotations, useReveal } from "./PresenterTools";

const PANEL_KEY = "slopslide.presenterPanel";

// Placing the show on its screens and closing the presenter view run one after the other, in
// the order asked: they take a moment off the main thread, and a show can end as it starts.
let placing: Promise<unknown> = Promise.resolve();
function inOrder<T>(command: () => Promise<T>): Promise<T> {
  const run = placing.then(command);
  placing = run.catch(() => {});
  return run;
}

/**
 * Full-screen slideshow. Plays the deck file with its own embedded player (the same thing
 * anyone you share the file with sees), starting at the selected slide. On top sit the
 * presenter's tools: laser pointer, pen, highlighter and eraser. With `show`, the backend adds
 * the pasteboard (src-tauri/assets/pasteboard.js), so the slide can be zoomed with the mouse
 * wheel or a pinch and panned with a swipe or the middle button; 0 fits it again. Play runs
 * the show by itself, speaking each slide's narration (see `useAutoplay`). N opens the presenter
 * view beside the slide (see `PresenterPanel`), in this same window: it is for a screen the
 * audience doesn't see.
 */
export function Presenter() {
  const deck = useApp((s) => s.deck);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Start where the editor is; afterwards the player owns navigation.
  const startRef = useRef(useApp.getState().selected);
  // Ink belongs to the slide it was drawn on; the player reports each slide by position.
  const [slideKey, setSlideKey] = useState("");
  // The slide on screen, as the player reports it.
  const [current, setCurrent] = useState<string | null>(null);
  const annotations = useAnnotations(slideKey);
  const handleKeyRef = useRef(annotations.handleKey);
  handleKeyRef.current = annotations.handleKey;
  // How the slide is zoomed and panned; the ink goes along with it.
  const [zoom, setZoom] = useState({ x: 0, y: 0, k: 1 });
  const nav = useReveal(annotations.peek);
  const moved = !(zoom.x === 0 && zoom.y === 0 && zoom.k === 1);
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem(PANEL_KEY) === "true");
  const [startedAt, setStartedAt] = useState(() => Date.now());
  useEffect(() => localStorage.setItem(PANEL_KEY, String(panelOpen)), [panelOpen]);

  useEffect(() => {
    const window_ = getCurrentWindow();
    // With several screens, the show first moves to the one picked (and the presenter view opens).
    const screens = useApp.getState().screens;
    let ended = false;
    let placed = false;
    if (screens) {
      // A moment later: StrictMode runs this twice in dev, and closing a presenter view that
      // macOS is still taking full screen makes the system beep.
      queueMicrotask(() => {
        if (ended) return;
        placed = true;
        inOrder(() => api.presentOn(screens.audience, screens.presenter))
          .catch((error) => useApp.getState().setError(errorMessage(error)))
          .finally(() => {
            if (!ended) void window_.setFullscreen(true);
          });
      });
    } else {
      void window_.setFullscreen(true);
    }
    const exit = () => useApp.getState().setPresenting(false);
    /** Tool shortcuts first; Escape puts a tool away before it ends the show. */
    const handle = (key: string, mod: boolean) => {
      if (handleKeyRef.current(key, mod)) return true;
      if (key === "Escape") {
        exit();
        return true;
      }
      if (key === "0" && !mod) {
        fitSlide(frameRef.current);
        return true;
      }
      if (key.toLowerCase() === "n" && !mod) {
        setPanelOpen((open) => !open);
        return true;
      }
      return false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (handle(event.key, event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        return;
      }
      // Focus is here after drawing or using the toolbar: pass the key on to the player.
      const frame = frameRef.current;
      frame?.contentWindow?.postMessage({ type: "slop:go", key: event.key }, "*");
      frame?.focus();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.data?.type === "slop:key") handle(String(event.data.key), Boolean(event.data.mod));
      if (event.data?.type === "slop:zoom") {
        const { x, y, k } = event.data;
        if ([x, y, k].every(Number.isFinite)) setZoom({ x, y, k });
      }
      if (event.data?.type === "slop:slide") {
        if (typeof event.data.index === "number") setSlideKey(String(event.data.index));
        setCurrent(event.data.id ? String(event.data.id) : null);
        // Keep the editor's selection in step so leaving the show lands on the same slide.
        if (event.data.id) useApp.getState().select(String(event.data.id));
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
      ended = true;
      void window_.setFullscreen(false);
      if (placed) void inOrder(() => api.closePresenterView()).catch(() => {});
    };
  }, []);

  const go = (key: string) => frameRef.current?.contentWindow?.postMessage({ type: "slop:go", key }, "*");
  // The presenter view in a window of its own (on another screen) is fed from here.
  const separate = useApp((s) => s.screens?.presenter != null);
  usePresenterFeed(separate ? deck : null, current ?? startRef.current, go);
  const autoplay = useAutoplay(deck, current, () => go("ArrowRight"));

  if (!deck) return null;
  const hash = startRef.current ? `#${encodeURIComponent(startRef.current)}` : "";
  return (
    <div className="fixed inset-0 z-50 flex bg-stage">
      <div className="relative min-w-0 flex-1 overflow-hidden">
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: The load handler focuses the presentation for keyboard navigation. */}
        <iframe
          ref={frameRef}
          title="Presentation"
          src={`${fileUrl(deck.id, `v=${deck.shellHash}&show`)}${hash}`}
          sandbox="allow-scripts"
          onLoad={(event) => event.currentTarget.focus()}
          className="size-full border-0"
        />
        <div
          data-testid="annotation-zoom"
          className="pointer-events-none absolute"
          style={zoomBox(zoom.x, zoom.y, zoom.k)}
        >
          <AnnotationLayer annotations={annotations} zoom={zoom.k} />
        </div>
        {moved && (
          <button
            type="button"
            title="Back to the slide, fit to the screen (0)"
            // Keep keyboard focus where it was, so Space still advances the slide.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => fitSlide(frameRef.current)}
            className="dark absolute right-44 bottom-4 z-10 flex items-center gap-1.5 rounded-xl border border-foreground/10 bg-overlay px-2.5 py-1.5 text-xs text-foreground/80 tabular-nums shadow-lg backdrop-blur hover:text-foreground [&_svg]:size-3.5"
          >
            <Maximize />
            {Math.round(zoom.k * 100)}%
          </button>
        )}
        <div data-testid="nav-zone" className="absolute right-0 bottom-0 z-10 flex gap-1 p-4" {...nav.zoneProps}>
          {(
            [
              { label: "Previous slide", title: "Previous slide", onClick: () => go("ArrowLeft"), Icon: ChevronLeft },
              autoplay.playing
                ? { label: "Pause", title: "Pause", onClick: autoplay.toggle, Icon: Pause }
                : {
                    label: "Play",
                    title: "Play: speak each slide's narration and move on by itself",
                    onClick: autoplay.toggle,
                    Icon: Play,
                  },
              { label: "Next slide", title: "Next slide", onClick: () => go("ArrowRight"), Icon: ChevronRight },
              {
                label: "Presenter view",
                title: "Presenter view: notes, the next slide and the time (N)",
                onClick: () => setPanelOpen((open) => !open),
                Icon: PanelRight,
              },
            ] satisfies { label: string; title: string; onClick: () => void; Icon: LucideIcon }[]
          ).map(({ label, title, onClick, Icon }) => (
            <button
              key={label}
              type="button"
              title={title}
              aria-label={label}
              // Keep keyboard focus where it was, so Space still advances the slide.
              onMouseDown={(event) => event.preventDefault()}
              onClick={onClick}
              data-visible={nav.visible}
              className={cn(
                "dark flex size-9 items-center justify-center rounded-xl border border-foreground/10 bg-overlay text-foreground/80 shadow-lg backdrop-blur transition-opacity duration-200 hover:text-foreground [&_svg]:size-5",
                // While playing, the pause button stays in view.
                nav.visible || label === "Pause" ? "opacity-100" : "opacity-0",
              )}
            >
              <Icon />
            </button>
          ))}
        </div>
        <PresenterToolbar annotations={annotations} onExit={() => useApp.getState().setPresenting(false)} />
      </div>
      {panelOpen && !separate && (
        <PresenterPanel
          deck={deck}
          slide={current ?? startRef.current}
          startedAt={startedAt}
          onRestart={() => setStartedAt(Date.now())}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </div>
  );
}

/** What the show tells the presenter view window: the deck and the slide on screen. */
export interface PresenterState {
  deck: Deck;
  slide: string | null;
}

/**
 * Keeps the presenter view window up to date (it asks for the state when it opens, and gets it
 * again on every change) and passes on the keys pressed there to the show. Does nothing without
 * a deck.
 */
function usePresenterFeed(deck: Deck | null, slide: string | null, go: (key: string) => void) {
  const state = useRef<PresenterState | null>(null);
  state.current = deck ? { deck, slide } : null;
  const goRef = useRef(go);
  goRef.current = go;
  const active = deck !== null;
  useEffect(() => {
    if (deck) void emit("presenter:state", { deck, slide });
  }, [deck, slide]);
  useEffect(() => {
    if (!active) return;
    const sub = Promise.all([
      listen("presenter:ready", () => state.current && void emit("presenter:state", state.current)),
      listen<string>("presenter:key", (event) => goRef.current(event.payload)),
      listen("presenter:exit", () => useApp.getState().setPresenting(false)),
    ]);
    return () =>
      void sub.then((offs) => {
        for (const off of offs) off();
      });
  }, [active]);
}

/**
 * Runs the show by itself while playing, on the video export's timeline (see `layoutTimeline`):
 * each slide shows for its time, then `next` moves on, and narration (up-to-date audio only,
 * from the Narration tab) plays at its time, carrying on across slides when it runs over.
 * Pausing stops the narration; playing again starts over from the start of the slide. Moving to
 * another slide meanwhile goes on from there. The show stops playing after the last slide.
 */
export function useAutoplay(deck: Deck | null, current: string | null, next: () => void) {
  const [playing, setPlaying] = useState(false);
  // Bumped to start over from the slide on screen, when something else moved to it.
  const [from, setFrom] = useState(0);
  const nextRef = useRef(next);
  nextRef.current = next;
  const currentRef = useRef(current);
  currentRef.current = current;
  // The slide the timeline is on; another one on screen means someone else moved the show.
  const onTimeline = useRef<string | null>(null);
  useEffect(() => {
    if (playing && current && current !== onTimeline.current) setFrom((n) => n + 1);
  }, [playing, current]);
  useEffect(() => {
    const slide = currentRef.current;
    onTimeline.current = slide;
    if (!playing || !deck || !slide || from < 0) return;
    const { audio, audioDeck } = useNarration.getState();
    const shown = deck.slides.filter((s) => !s.hidden);
    const spoken = Object.fromEntries(
      shown.map((s) => {
        const said = audioDeck === deck.id && audio[s.id]?.state === "ready";
        return [s.id, said ? (audio[s.id]?.seconds ?? null) : null];
      }),
    );
    const timeline = layoutTimeline(shown, spoken, loadVideoOptions());
    const start = timeline.slides.find((s) => s.id === slide)?.start;
    // A hidden slide has no place on the timeline.
    if (start === undefined) return void nextRef.current();
    return playTimeline(deck.id, timeline, start, {
      slide: (index) => {
        onTimeline.current = timeline.slides[index]?.id ?? null;
        nextRef.current();
      },
      ended: () => setPlaying(false),
    });
  }, [playing, deck, from]);
  return { playing, toggle: () => setPlaying((p) => !p) };
}

/** Asks the show's pasteboard to fit the slide to the screen again. */
function fitSlide(frame: HTMLIFrameElement | null) {
  frame?.contentWindow?.postMessage({ type: "slop:camera", home: true }, "*");
}
