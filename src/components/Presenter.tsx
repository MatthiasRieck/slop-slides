import { ChevronLeft, ChevronRight, PanelRight, Pause, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { DarkScope } from "@/lib/darkScope";
import { dismissTopLayer, hasOpenLayer } from "../lib/layers";
import { hasPresenterWindow } from "../lib/screens";
import { onSlideClock, postSlideClock } from "../lib/slideClock";
import { loadFlag, saveFlag } from "../lib/storage";
import { cn, fileUrl } from "../lib/utils";
import { useApp } from "../store";
import { LevelDot, RecordingTime } from "./NarrationRecorder";
import { PresenterPanel } from "./PresenterPanel";
import { InkTools, useAnnotations } from "./PresenterTools";
import { ShowButton } from "./presenter/ShowButton";
import { ShowKeys } from "./presenter/ShowKeys";
import { fitSlide, ShowZoom } from "./presenter/ShowZoom";
import { useAutoplay } from "./presenter/useAutoplay";
import { usePresenterFeed } from "./presenter/usePresenterFeed";
import { useShowControls } from "./presenter/useShowControls";
import { useShowPlacement } from "./presenter/useShowPlacement";
import { type ShowSession, useShowSession } from "./presenter/useShowSession";

const PANEL_KEY = "slopslide.presenterPanel";

/** A key pressed in the show: here, in the slide's page, or in the presenter view's window. */
interface ShowKey {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** Whether a key pressed on `target` is its own rather than the show's: Tab anywhere, and Enter or Space on a control. */
function keptByControl(event: KeyboardEvent): boolean {
  if (event.key === "Tab") return true;
  const control = (event.target as Element | null)?.closest?.(
    "button, a, input, select, textarea, [role=switch], [role=checkbox], [role=combobox], [role=option]",
  );
  return Boolean(control) && (event.key === "Enter" || event.key === " ");
}

/** The slide the show starts on: the editor's, or the first one shown when presenting from the beginning. */
function startSlide(): string | null {
  const { deck, selected, presentFrom } = useApp.getState();
  if (presentFrom !== "start") return selected;
  return deck?.slides.find((s) => !s.hidden)?.id ?? null;
}

/**
 * Full-screen slideshow. Plays the deck file with its own embedded player (the same thing
 * anyone you share the file with sees), starting at the selected slide, or at the first one (see
 * `setPresenting`). With `show`, the backend adds the pasteboard (src-tauri/assets/pasteboard.js),
 * so the slide can be zoomed with the mouse wheel or a pinch and panned with a swipe or the
 * middle button; 0 fits it again.
 *
 * One bar at the bottom holds everything that operates the show: the presenter's tools (laser
 * pointer, pen, highlighter, eraser), previous and next around the slide's number, Play, the
 * presenter view and End show. It comes up only when the pointer moves near the bottom of the
 * show, and goes when it moves away or rests; the cursor comes with any move and goes once the
 * pointer rests (see `useShowControls`). Hidden, the bar takes neither a press nor the focus.
 * Play runs the show by itself, speaking each slide's narration (see `useAutoplay`). `?` lists
 * the show's keys.
 *
 * N opens the presenter view beside the slide (see `PresenterPanel`), in this same window: it is
 * for a screen the audience doesn't see. Presenting in windows, the show stays in this window as
 * it is, for a call to share, and the presenter view opens in a window of its own. The show's
 * clocks, the teleprompter and the narration recorder belong to the show, not to that panel (see
 * `useShowSession`): closed, they go on, and a pill over the slide says the microphone records.
 *
 * The editor is still there under the show. The slide on screen is the show's own to know while
 * it runs: the editor is told once, when the show ends, and lands on the slide it ended on. Told
 * of every slide, it would load each one on its covered stage and scroll its rail along. How the
 * slide is zoomed is `ShowZoom`'s to know, which alone follows every move of that.
 */
export function Presenter() {
  const deck = useApp((s) => s.deck);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Start where asked; afterwards the player owns navigation.
  const [start] = useState(startSlide);
  // The slide on screen, as the player reports it: its place among the slides shown, and its id.
  const [index, setIndex] = useState<number | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  // Ink belongs to the slide it was drawn on.
  const annotations = useAnnotations(index === null ? "" : String(index));
  const [panelOpen, setPanelOpen] = useState(() => loadFlag(PANEL_KEY, false));
  const [keysOpen, setKeysOpen] = useState(false);
  useEffect(() => saveFlag(PANEL_KEY, panelOpen), [panelOpen]);
  const controls = useShowControls(annotations.tool !== "pointer");
  const onScreen = current ?? start;
  const session = useShowSession(deck?.id ?? "", onScreen);

  useShowPlacement();

  const post = (message: unknown) => frameRef.current?.contentWindow?.postMessage(message, "*");
  /** Hands a key on to the player: one of its own (see src-tauri/assets/runtime.js), or none. */
  const go = (key: string, shift = false) => post(shift ? { type: "slop:go", key, shift } : { type: "slop:go", key });

  /** Acts on a key of the show's own; false for one that is the player's, or nobody's. */
  const handle = ({ key, mod = false, shift = false, alt = false }: ShowKey): boolean => {
    if (alt) return false;
    // Tool shortcuts first; Escape puts a tool away before it ends the show.
    if (annotations.handleKey(key, mod, shift)) {
      controls.wake();
      return true;
    }
    if (mod) return false;
    if (key === "Escape") useApp.getState().setPresenting(false);
    else if (key === "0") fitSlide(frameRef.current);
    else if (key.toLowerCase() === "n") setPanelOpen((open) => !open);
    else if (key === "?") setKeysOpen(true);
    else return false;
    return true;
  };
  /** A key that reached the show without passing the player: the show's own, or else handed on to the player. */
  const press = (pressed: ShowKey): boolean => {
    if (handle(pressed)) return true;
    if (pressed.mod || pressed.alt) return false;
    go(pressed.key, pressed.shift);
    return false;
  };
  const keys = useRef({ handle, press, move: controls.move });
  keys.current = { handle, press, move: controls.move };
  // The last slide the player said is on screen: where the editor goes when the show ends.
  const endedOn = useRef<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // What is open over the show (its keys, the timer's settings) has the keys, and so has a field.
      if (hasOpenLayer() || keptByControl(event)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (keys.current.press({ key: event.key, mod, shift: event.shiftKey, alt: event.altKey })) {
        event.preventDefault();
        return;
      }
      // Focus is here after drawing or using the bar: the next key goes to the player itself.
      if (!mod && !event.altKey) frameRef.current?.focus();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data;
      if (data?.type === "slop:key") {
        // Escape closes what is open over the show (a message, say) before it ends the show.
        if (data.key === "Escape" && dismissTopLayer(event)) return;
        // The player acted on the key itself, if it is one of its own.
        keys.current.handle({
          key: String(data.key),
          mod: Boolean(data.mod),
          shift: Boolean(data.shift),
          alt: Boolean(data.alt),
        });
      }
      if (data?.type === "slop:pointer") {
        keys.current.move(typeof data.bottom === "number" ? data.bottom : undefined);
      }
      if (data?.type === "slop:slide") {
        if (typeof data.index === "number") setIndex(data.index);
        setCurrent(data.id ? String(data.id) : null);
        if (data.id) endedOn.current = String(data.id);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
      // The show is over: the editor lands on the slide it ended on.
      const slide = endedOn.current;
      if (slide !== null && slide !== useApp.getState().selected) useApp.getState().select(slide);
    };
  }, []);

  // With the pointer at rest, the slide's page hides the cursor over it.
  const idle = controls.cursorHidden;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `post` reads the frame there is.
  useEffect(() => {
    post({ type: "slop:idle", idle });
  }, [idle]);

  // The presenter view in a window of its own (on another screen) is fed from here.
  const separate = useApp((s) => hasPresenterWindow(s.screens));
  const autoplay = useAutoplay(deck, current, () => go("ArrowRight"));
  usePresenterFeed(
    { deck: separate ? deck : null, slide: onScreen, playing: autoplay.playing },
    { key: (pressed) => keys.current.press(pressed), play: autoplay.toggle },
  );
  // While it plays, the slide's animations keep with the narration.
  useEffect(() => onSlideClock(() => postSlideClock(frameRef.current, null)), []);
  // Presented by hand, the player shows each slide as it ends up, without the animations timed
  // to the narration (see `settle` in src-tauri/assets/runtime.js): it is told when the show plays.
  const playing = autoplay.playing;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `post` reads the frame there is.
  useEffect(() => {
    post({ type: "slop:playing", playing });
  }, [playing]);

  if (!deck) return null;
  const shown = deck.slides.filter((s) => !s.hidden);
  const position =
    index ??
    Math.max(
      0,
      shown.findIndex((s) => s.id === start),
    );
  const panelShown = panelOpen && !separate;
  const hash = start ? `#${encodeURIComponent(start)}` : "";
  return (
    // Dark in either theme, and so is what opens from it.
    <DarkScope>
      <div className="fixed inset-0 z-50 flex bg-stage">
        <div className="relative min-w-0 flex-1 overflow-hidden">
          {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: The load handler focuses the presentation for keyboard navigation. */}
          <iframe
            ref={frameRef}
            title="Presentation"
            src={`${fileUrl(deck.id, `v=${deck.shellHash}&show`)}${hash}`}
            sandbox="allow-scripts"
            onLoad={(event) => {
              event.currentTarget.focus();
              post({ type: "slop:idle", idle });
              post({ type: "slop:playing", playing });
            }}
            className="size-full border-0"
          />
          <ShowZoom frame={frameRef} annotations={annotations} />
          {!panelShown && <MicrophonePill session={session} />}
          {/* Only as wide as the bar: the slide beside it still takes a press. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center p-4">
            <div
              role="toolbar"
              aria-label="Show controls"
              data-visible={controls.visible}
              // Hidden, it is out of reach of the pointer and the keyboard.
              inert={!controls.visible}
              {...controls.zoneProps}
              className={cn(
                "dark flex max-w-full items-center gap-1 rounded-xl border border-foreground/10 bg-overlay p-1.5 text-foreground shadow-lg backdrop-blur transition-opacity duration-200 motion-reduce:transition-none",
                controls.visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
              )}
            >
              <InkTools annotations={annotations} />
              <Divider />
              <ShowButton tooltip="Previous slide" shortcut="left" onClick={() => go("ArrowLeft")}>
                <ChevronLeft />
              </ShowButton>
              <span
                data-testid="show-position"
                title="The slide on screen, of the slides shown"
                className="min-w-12 text-center text-xs text-foreground/80 tabular-nums"
              >
                {position + 1} / {shown.length}
              </span>
              <ShowButton tooltip="Next slide" shortcut="right" onClick={() => go("ArrowRight")}>
                <ChevronRight />
              </ShowButton>
              <ShowButton
                aria-label={autoplay.playing ? "Pause" : "Play"}
                tooltip={autoplay.playing ? "Pause" : "Play: speak each slide's narration and move on by itself"}
                onClick={autoplay.toggle}
              >
                {autoplay.playing ? <Pause /> : <Play />}
              </ShowButton>
              <Divider />
              <ShowButton
                aria-label="Presenter view"
                tooltip={
                  separate
                    ? "The presenter view is in a window of its own"
                    : "Presenter view: notes, the next slide and the time"
                }
                shortcut={separate ? undefined : "n"}
                aria-pressed={panelShown}
                disabled={separate}
                onClick={() => setPanelOpen((open) => !open)}
              >
                <PanelRight />
              </ShowButton>
              <ShowButton
                size="default"
                tooltip="End show"
                shortcut="escape"
                onClick={() => useApp.getState().setPresenting(false)}
                className="text-xs"
              >
                <X />
                End show
              </ShowButton>
            </div>
          </div>
        </div>
        {panelShown && (
          <PresenterPanel
            deck={deck}
            slide={onScreen}
            session={session}
            onNext={() => go("ArrowRight")}
            onShowKeys={() => setKeysOpen(true)}
            onClose={() => setPanelOpen(false)}
          />
        )}
        {keysOpen && <ShowKeys onClose={() => setKeysOpen(false)} />}
      </div>
    </DarkScope>
  );
}

function Divider() {
  return (
    <Separator orientation="vertical" className="mx-1 bg-foreground/15 data-vertical:h-5 data-vertical:self-center" />
  );
}

/**
 * Over the slide while the presenter view is closed: that the microphone is on, recording the
 * narration (and for how long) or following the presenter for the teleprompter. Nothing else
 * would say so.
 */
function MicrophonePill({ session }: { session: ShowSession }) {
  const recording = session.recorder.phase === "recording";
  const following = session.teleprompter.phase === "following";
  if (!recording && !following) return null;
  return (
    <Badge
      variant="outline"
      role="status"
      data-testid="microphone-pill"
      title="Open the presenter view (N) to stop it"
      className={cn(
        "dark absolute top-4 right-4 z-10 h-auto gap-2 overflow-visible border-foreground/10 bg-overlay px-3 py-1.5 font-normal shadow-lg backdrop-blur",
        recording ? "text-destructive" : "text-primary",
      )}
    >
      {recording ? <LevelDot /> : <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-primary" />}
      {recording ? "Recording" : "Teleprompter listening"}
      <RecordingTime since={session.recorder.since} />
    </Badge>
  );
}
