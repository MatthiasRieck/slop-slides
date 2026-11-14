import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronLeft, ChevronRight, Eraser, Highlighter, Pause, PenLine, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Deck } from "../lib/api";
import type { Tool } from "../lib/ink";
import { dismissTopLayer, hasOpenLayer } from "../lib/layers";
import { hasPresenterWindow } from "../lib/screens";
import { onSlideClock, postSlideClock } from "../lib/slideClock";
import { loadFlag, saveFlag } from "../lib/storage";
import { cn, fileUrl } from "../lib/utils";
import { deckVideoOptions, useNarration } from "../narrationStore";
import { showError, showInfo, showSuccess, useApp } from "../store";
import { ToolButton } from "./Button";
import { LevelDot, RecordingTime } from "./NarrationRecorder";
import { PresenterPanel, scrollNotes } from "./PresenterPanel";
import { InkTools, useAnnotations } from "./PresenterTools";
import { PRESENTER_VIEW, PresenterViewIcon } from "./presenter/presenterView";
import { ShowKeys } from "./presenter/ShowKeys";
import { ShowOverview } from "./presenter/ShowOverview";
import { fitSlide, ShowZoom } from "./presenter/ShowZoom";
import { slideNumber, typedGoal, webLink } from "./presenter/showSlides";
import { formatElapsed, NO_TIMINGS, rehearsedTimes, spentBy, timeSlide } from "./presenter/time";
import { useAutoplay } from "./presenter/useAutoplay";
import { type Blank, usePresenterFeed } from "./presenter/usePresenterFeed";
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
  const control = (event.target as Element | null)?.closest?.("button, a, input, select, textarea");
  return Boolean(control) && (event.key === "Enter" || event.key === " ");
}

/** The slide the show starts on: the editor's, or the first one shown when presenting from the beginning. */
function startSlide(): string | null {
  const { deck, selected, presentFrom } = useApp.getState();
  if (presentFrom !== "start") return selected;
  return deck?.slides.find((s) => !s.hidden)?.id ?? null;
}

/** What Play says it does: speak the narration, where some is ready, or else only move on by itself. */
function playTitle(narrated: boolean, seconds: number): string {
  return narrated
    ? "Play: speak each slide's narration and move on by itself"
    : `Play: move on by itself, ${seconds} s a slide unless its timeline says otherwise (no narration yet)`;
}

/** Whether any slide the show shows has its narration audio ready to speak. */
function useNarrated(deck: Deck | null): boolean {
  return useNarration(
    (s) =>
      deck !== null &&
      s.audioDeck === deck.id &&
      deck.slides.some((slide) => !slide.hidden && s.audio[slide.id]?.state === "ready"),
  );
}

/**
 * Offers to keep how long each slide was on screen in the show that ended as the slides' planned
 * times (which the presenter view counts down), when the show went through all of them: a run
 * through the talk. Stored as the slide's time field stores it (see SlideTime.tsx).
 */
function offerTimings(spent: Record<string, number>) {
  const { deck } = useApp.getState();
  const times =
    deck &&
    rehearsedTimes(
      spent,
      deck.slides.filter((s) => !s.hidden),
    );
  if (!deck || !times) return;
  const total = Object.values(spent).reduce((sum, ms) => sum + ms, 0);
  showInfo(`That run through the slides took ${formatElapsed(total)}.`, {
    label: "Use these timings as slide times",
    run: () =>
      void (async () => {
        for (const [slide, seconds] of Object.entries(times)) {
          const now = useApp.getState().deck?.slides.find((s) => s.id === slide);
          if (now && !now.locked && (now.time ?? 0) !== seconds) await useApp.getState().setSlideTime(slide, seconds);
        }
        const count = Object.keys(times).length;
        showSuccess(`Planned times set for ${count} ${count === 1 ? "slide" : "slides"}.`);
      })(),
  });
}

/**
 * Full-screen slideshow. Plays the deck file with its own embedded player (the same thing
 * anyone you share the file with sees), starting at the selected slide, or at the first one (see
 * `setPresenting`). With `show`, the backend adds the pasteboard (src-tauri/assets/pasteboard.js),
 * so the slide can be zoomed with the mouse wheel or a pinch and panned with a swipe or the
 * middle button; 0 fits it again. The page stays the one the show opened with: a change to the
 * deck while it runs does not reload it in front of the audience.
 *
 * One bar at the bottom holds everything that operates the show: the presenter's tools (laser
 * pointer, pen, highlighter, eraser), previous and next around the slide's number (which opens
 * all the slides, as G does), Play, the presenter view and End show. It comes with any move of
 * the pointer and goes, with the cursor, once the pointer rests (see `useShowControls`), also
 * while a tool is picked: a small mark of the tool stays. Hidden, it takes neither a press nor
 * the focus. Play (K) runs the show by itself, speaking each slide's narration (see
 * `useAutoplay`); a mark says it plays. `?` lists the show's keys. The editor under the show is
 * out of reach meanwhile (inert): Tab never wanders into it.
 *
 * The player tells the show what the audience sees: a blanked screen (B, W), a slide number
 * being typed (said over the slide, or in the presenter view's window), and the dark screen
 * after the last slide, which says "End of show"; going on from there ends it. Escape steps
 * back one thing at a time: the tool, the zoom, the blank screen, then the show. A link on a
 * slide opens in the browser, the show going on.
 *
 * N opens the presenter view beside the slide (see `PresenterPanel`), in this same window: it is
 * for a screen the audience doesn't see. Presenting in windows, the show stays in this window as
 * it is, for a call to share, and the presenter view opens in a window of its own. The show's
 * clocks, the teleprompter and the narration recorder belong to the show, not to that panel (see
 * `useShowSession`): closed, they go on, and a pill over the slide says the microphone records.
 * When a show went through all the slides, the editor offers their times as planned times.
 *
 * The editor is still there under the show. The slide on screen is the show's own to know while
 * it runs: the editor is told once, when the show ends, and lands on the slide it ended on. Told
 * of every slide, it would load each one on its covered stage and scroll its rail along. How the
 * slide is zoomed is `ShowZoom`'s to know, which alone follows every move of that.
 */
export function Presenter() {
  const deck = useApp((s) => s.deck);
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Start where asked; afterwards the player owns navigation.
  const [start] = useState(startSlide);
  // The deck's page as the show opened it: a change meanwhile reloads nothing.
  const [shell] = useState(() => deck?.shellHash ?? "");
  // The slide on screen, as the player reports it: its place among the slides shown, and its id.
  const [index, setIndex] = useState<number | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  // What the player says the audience sees besides the slide.
  const [blank, setBlank] = useState<Blank>(null);
  const [typed, setTyped] = useState("");
  const [ended, setEnded] = useState(false);
  // Ink belongs to the slide it was drawn on.
  const annotations = useAnnotations(index === null ? "" : String(index));
  const [panelOpen, setPanelOpen] = useState(() => loadFlag(PANEL_KEY, false));
  const [keysOpen, setKeysOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  useEffect(() => saveFlag(PANEL_KEY, panelOpen), [panelOpen]);
  const controls = useShowControls();
  const onScreen = current ?? start;
  const session = useShowSession(deck?.id ?? "", onScreen);
  // Whether the slide is zoomed or panned (see `ShowZoom`), for Escape to fit it first.
  const zoomed = useRef(false);
  // How long each slide was on screen, for planned times (see `offerTimings`).
  const timings = useRef(NO_TIMINGS);
  const timed = ended ? null : onScreen;
  useEffect(() => {
    timings.current = timeSlide(timings.current, timed, Date.now());
  }, [timed]);

  useShowPlacement();

  // The presenter view in a window of its own (on another screen) is fed from here.
  const separate = useApp((s) => hasPresenterWindow(s.screens));

  const post = (message: unknown) => frameRef.current?.contentWindow?.postMessage(message, "*");
  /** Hands a key on to the player: one of its own (see src-tauri/assets/runtime.js), or none. */
  const go = (key: string, shift = false) => post(shift ? { type: "slop:go", key, shift } : { type: "slop:go", key });
  /** Blanks the audience's screen to `color`, or shows the slide again. */
  const blankTo = (color: Blank) => post({ type: "slop:blank", color });
  const goto = (slide: string) => post({ type: "slop:goto", id: slide });
  const autoplay = useAutoplay(deck, current, () => go("ArrowRight"));

  /** Acts on a key of the show's own; false for one that is the player's, or nobody's. */
  const handle = ({ key, mod = false, shift = false, alt = false }: ShowKey): boolean => {
    if (alt) return false;
    // Tool shortcuts first; Escape puts a tool away before it does anything else.
    if (annotations.handleKey(key, mod, shift)) {
      controls.wake();
      return true;
    }
    if (mod) return false;
    const lower = key.toLowerCase();
    // While a number is typed, Escape gives it up and 0 is one of its digits: the player's.
    if (typed && (key === "Escape" || key === "0")) return false;
    if (key === "Escape") {
      if (zoomed.current) fitSlide(frameRef.current);
      else if (blank) blankTo(null);
      else useApp.getState().setPresenting(false);
    } else if (key === "0") fitSlide(frameRef.current);
    // The presenter view is in a window of its own: there is no panel here to open.
    else if (lower === "n" && !separate) setPanelOpen((open) => !open);
    else if ((key === "[" || key === "]") && panelOpen && !separate) scrollNotes(key === "]" ? 1 : -1);
    else if (lower === "g") setOverviewOpen(true);
    else if (lower === "k") autoplay.toggle();
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
  const keys = useRef({ handle, press, wake: controls.wake });
  keys.current = { handle, press, wake: controls.wake };
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
        // Escape closes what is open over the show (a message, say) before it does anything else.
        if (data.key === "Escape" && dismissTopLayer(event)) return;
        // The player acted on the key itself, if it is one of its own.
        keys.current.handle({
          key: String(data.key),
          mod: Boolean(data.mod),
          shift: Boolean(data.shift),
          alt: Boolean(data.alt),
        });
      }
      if (data?.type === "slop:pointer") keys.current.wake();
      if (data?.type === "slop:slide") {
        if (typeof data.index === "number") setIndex(data.index);
        setCurrent(data.id ? String(data.id) : null);
        if (data.id) endedOn.current = String(data.id);
      }
      if (data?.type === "slop:blank") setBlank(data.color === "black" || data.color === "white" ? data.color : null);
      if (data?.type === "slop:typed") setTyped(typeof data.typed === "string" ? data.typed : "");
      if (data?.type === "slop:end") setEnded(Boolean(data.ended));
      if (data?.type === "slop:exit") useApp.getState().setPresenting(false);
      if (data?.type === "slop:link") {
        // Out of the app, to the browser or the mail app; nothing but those.
        const href = webLink(data.href);
        if (href)
          void openUrl(href).catch((error) => showError(error, { doing: "Could not open the link", duringShow: true }));
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
      offerTimings(spentBy(timings.current, Date.now()));
    };
  }, []);

  // The editor under the show is out of reach: Tab, Space and Enter never press a control the
  // audience can't see. It is what comes before the show in the window.
  useEffect(() => {
    const held: Element[] = [];
    for (let el = rootRef.current?.previousElementSibling; el; el = el.previousElementSibling) {
      if (el.hasAttribute("inert")) continue;
      el.setAttribute("inert", "");
      held.push(el);
    }
    return () => {
      for (const el of held) el.removeAttribute("inert");
    };
  }, []);

  // With the controls gone, the slide's page hides the cursor over it too.
  const idle = !controls.visible;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `post` reads the frame there is.
  useEffect(() => {
    post({ type: "slop:idle", idle });
  }, [idle]);

  usePresenterFeed(
    { deck: separate ? deck : null, slide: onScreen, playing: autoplay.playing, blank, typed, ended },
    {
      key: (pressed) => keys.current.press(pressed),
      play: autoplay.toggle,
      goto: (slide) => goto(slide),
      blank: (color) => blankTo(color),
    },
  );
  // While it plays, the slide's animations keep with the narration.
  useEffect(() => onSlideClock(() => postSlideClock(frameRef.current, null)), []);
  const narrated = useNarrated(deck);

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
  const play = playTitle(narrated, deckVideoOptions(deck.id).secondsPerSlide);
  return (
    <div ref={rootRef} className="fixed inset-0 z-overlay flex bg-stage">
      <div className="relative min-w-0 flex-1 overflow-hidden">
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: The load handler focuses the presentation for keyboard navigation. */}
        <iframe
          ref={frameRef}
          title="Presentation"
          src={`${fileUrl(deck.id, `v=${shell}&show`)}${hash}`}
          sandbox="allow-scripts"
          onLoad={(event) => {
            event.currentTarget.focus();
            post({ type: "slop:idle", idle });
          }}
          className="size-full border-0"
        />
        <ShowZoom
          frame={frameRef}
          annotations={annotations}
          onMoved={(moved) => {
            zoomed.current = moved;
          }}
        />
        {ended && <EndOfShow />}
        <div className="pointer-events-none absolute top-4 right-4 z-10 flex flex-col items-end gap-2">
          {!panelShown && <MicrophonePill session={session} />}
          {autoplay.playing && !controls.visible && !separate && (
            <Pill testId="playing-pill" title="Playing by itself; K pauses">
              <Play className="size-3 fill-current" />
              Playing
            </Pill>
          )}
        </div>
        {!separate && (
          <div className="pointer-events-none absolute bottom-4 left-4 z-10 flex flex-col items-start gap-2">
            {blank && (
              <Pill testId="blank-pill" title="The audience sees a blank screen">
                Screen {blank} · B brings the slide back
              </Pill>
            )}
            {!controls.visible && <ToolMark tool={annotations.tool} />}
          </div>
        )}
        {/* Only as wide as the bar: the slide beside it still takes a press. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-2 p-4">
          {typed && !separate && (
            <Pill testId="typed-slide" title="Enter goes there; Escape gives it up">
              {typedGoal(deck, typed)} ↵
            </Pill>
          )}
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
            <ToolButton
              variant="presenter"
              keepFocus
              label="Previous slide"
              shortcut="left"
              onClick={() => go("ArrowLeft")}
            >
              <ChevronLeft />
            </ToolButton>
            <button
              type="button"
              data-testid="show-position"
              aria-label={`Slide ${slideNumber(deck, position)} of ${deck.slides.length}: all slides`}
              title="All slides (G)"
              // Keep keyboard focus where it was, so Space still advances the slide.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setOverviewOpen(true)}
              className="h-8 min-w-12 rounded-lg px-1.5 text-center text-xs text-foreground/80 tabular-nums hover:bg-foreground/10 hover:text-foreground"
            >
              {slideNumber(deck, position)} / {deck.slides.length}
            </button>
            <ToolButton
              variant="presenter"
              keepFocus
              label="Next slide"
              shortcut="right"
              onClick={() => go("ArrowRight")}
            >
              <ChevronRight />
            </ToolButton>
            <ToolButton
              variant="presenter"
              keepFocus
              label={autoplay.playing ? "Pause" : "Play"}
              title={autoplay.playing ? "Pause" : play}
              shortcut="k"
              active={autoplay.playing}
              onClick={autoplay.toggle}
            >
              {autoplay.playing ? <Pause /> : <Play />}
            </ToolButton>
            <Divider />
            <ToolButton
              variant="presenter"
              keepFocus
              label={PRESENTER_VIEW}
              title={
                separate
                  ? "The presenter view is in a window of its own"
                  : "Presenter view: notes, the next slide and the time"
              }
              shortcut={separate ? undefined : "n"}
              active={panelShown}
              disabled={separate}
              onClick={() => setPanelOpen((open) => !open)}
            >
              <PresenterViewIcon />
            </ToolButton>
            <button
              type="button"
              title="End show (Esc)"
              // Keep keyboard focus where it was, so Space still advances the slide.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => useApp.getState().setPresenting(false)}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs text-foreground/80 hover:bg-foreground/10 hover:text-foreground [&_svg]:size-4"
            >
              <X />
              End show
            </button>
          </div>
        </div>
      </div>
      {panelShown && (
        <PresenterPanel
          deck={deck}
          slide={onScreen}
          session={session}
          ended={ended}
          onNext={() => go("ArrowRight")}
          onOverview={() => setOverviewOpen(true)}
          onShowKeys={() => setKeysOpen(true)}
          onClose={() => setPanelOpen(false)}
        />
      )}
      {keysOpen && <ShowKeys onClose={() => setKeysOpen(false)} />}
      {overviewOpen && (
        <ShowOverview deck={deck} current={onScreen} onPick={goto} onClose={() => setOverviewOpen(false)} />
      )}
    </div>
  );
}

function Divider() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-foreground/15" />;
}

/** A small label over the slide, saying what the bar would show while it is gone. */
function Pill(props: { testId: string; title: string; className?: string; children: React.ReactNode }) {
  return (
    <div
      role="status"
      data-testid={props.testId}
      title={props.title}
      className={cn(
        "dark flex items-center gap-2 rounded-full border border-foreground/10 bg-overlay px-3 py-1.5 text-xs text-foreground/80 shadow-lg backdrop-blur",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

const TOOL_MARKS: Partial<Record<Tool, { icon: typeof PenLine; name: string }>> = {
  pen: { icon: PenLine, name: "Pen" },
  highlighter: { icon: Highlighter, name: "Highlighter" },
  eraser: { icon: Eraser, name: "Eraser" },
};

/**
 * The tool picked, while the bar is gone: a pen, a highlighter or an eraser draws or takes away
 * with a press that would otherwise go on to the next slide. The laser needs no mark: its dot is.
 */
function ToolMark({ tool }: { tool: Tool }) {
  const mark = TOOL_MARKS[tool];
  if (!mark) return null;
  const Icon = mark.icon;
  return (
    <div
      role="status"
      data-testid="tool-mark"
      aria-label={`${mark.name} picked`}
      title={`${mark.name} picked; Escape puts it away`}
      className="dark flex size-8 items-center justify-center rounded-full border border-foreground/10 bg-overlay text-foreground/80 shadow-lg backdrop-blur [&_svg]:size-4"
    >
      <Icon />
    </div>
  );
}

/** Over the dark screen after the last slide: the show is over, and how to leave it. */
function EndOfShow() {
  return (
    <div
      role="status"
      data-testid="end-of-show"
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center"
    >
      <p className="text-2xl font-medium text-paper/80">End of show</p>
      <p className="text-sm text-paper/50">Click or press → to leave, ← to go back</p>
    </div>
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
    <div
      role="status"
      data-testid="microphone-pill"
      title="Open the presenter view (N) to stop it"
      className={cn(
        "dark flex items-center gap-2 rounded-full border border-foreground/10 bg-overlay px-3 py-1.5 text-xs shadow-lg backdrop-blur",
        recording ? "text-destructive" : "text-primary",
      )}
    >
      {recording ? <LevelDot /> : <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-primary" />}
      {recording ? "Recording" : "Teleprompter listening"}
      <RecordingTime since={session.recorder.since} />
    </div>
  );
}
