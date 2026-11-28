import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { Slide } from "../../lib/api";
import { getSlideClock, onSlideClock, postSlideClock } from "../../lib/slideClock";
import type { Pixels } from "../../lib/slideSize";
import { isPasteboardUrl } from "../../lib/utils";
import { useApp } from "../../store";
import { SlideFrame, useSlideVersion } from "../SlideFrame";

/**
 * The stage's preview of the current slide: the editor in edit mode, else the slide as it plays or a still.
 *
 * A slide plays its animations when the user comes to it or asks for them again. The versions the
 * agent writes of it while it works load as stills (see `useAgentStill`).
 *
 * Of several slides shown side by side, one is the `active` one, which is all of the above. The
 * others are stills with no pasteboard, which lie under the active one's: they take no input and
 * report nothing. A slide stays the same preview as it becomes the active one or stops being it,
 * so what it shows next loads behind what it shows now.
 */
export function CurrentSlide(props: {
  deckId: string;
  slide: Slide;
  size: Pixels;
  editing: boolean;
  /** Whether this is the slide worked on, not one of those shown beside it; true unless given. */
  active?: boolean;
  /** The panel around the slide; its colors frame the slide and dim what lies outside it in the editor. */
  canvas: RefObject<HTMLElement | null>;
  arena?: { width: number; height: number };
  onFrameReady: (frame: HTMLIFrameElement) => void;
}) {
  const active = props.active ?? true;
  const editing = props.editing && active;
  const editReload = useApp((s) => s.editReload);
  const finalState = useApp((s) => s.finalState);
  // Loading the slide again is what plays its animations again; the editor shows none to replay,
  // and neither does a still beside the slide worked on.
  const replay = useApp((s) => (editing || !active ? 0 : s.replayRev));
  const id = props.slide.id;
  // While the timeline plays over the slide, or holds it at a moment, it shows as it is then, its
  // animations kept with the narration, rather than as the editor's still of their last frame, or
  // the one View's tools ask for.
  const played = useSyncExternalStore(onSlideClock, () => {
    const clock = getSlideClock();
    return clock?.slide === id;
  });
  const frame = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => onSlideClock(() => postSlideClock(frame.current, id, true)), [id]);
  /** Hands the stage `loaded` as its preview. */
  const announce = (loaded: HTMLIFrameElement) => {
    frame.current = loaded;
    postSlideClock(loaded, id);
    const canvas = props.canvas.current;
    if (canvas) loaded.contentWindow?.postMessage({ type: "slop:canvas", ...canvasColors(canvas) }, "*");
    props.onFrameReady(loaded);
  };
  // The pasteboard this slide loaded last. A slide that is the active one again before the still it
  // was to show has loaded keeps that pasteboard, and loads nothing: the stage, which has
  // another slide's preview by then, is handed it again.
  const board = useRef<HTMLIFrameElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only becoming the active one hands the preview over; what it is handed with is as of then.
  useEffect(() => {
    if (active && board.current?.isConnected) announce(board.current);
  }, [active]);
  const loaded = useEditorVersion(props.slide, editing && !played, editReload);
  const version = replay > 0 ? `${loaded}.r${replay}` : loaded;
  const agentStill = useAgentStill(`${id}.${replay}`, loaded);
  return (
    <SlideFrame
      deckId={props.deckId}
      slideId={id}
      version={version}
      editKey={editing && !played ? String(editReload) : undefined}
      still={!active || ((finalState || agentStill) && !played)}
      arena={active ? props.arena : undefined}
      size={props.size}
      onFrameReady={(loaded) => {
        const pasteboard = isPasteboardUrl(loaded.getAttribute("src") ?? "");
        if (pasteboard) board.current = loaded;
        // A still beside the active slide is not the stage's preview, and neither is the still a
        // slide showed before it became the active one, should that load only now.
        if (!active || (props.arena && !pasteboard)) return;
        announce(loaded);
      }}
    />
  );
}

/**
 * The version of `slide` the preview loads (see `useSlideVersion`). A version the slide editor
 * saved itself is the one it already shows, so while `editing` the preview stays on the version
 * it has: loading the slide again would take the editor away for a moment, and with it whatever
 * the user did since (the next drag, the next clicks on a toolbar button). Any other change (the
 * agent's, an undo, the deck's styles, an asset) loads the slide as before.
 */
function useEditorVersion(slide: Slide, editing: boolean, editReload: number): string {
  const version = useSlideVersion(slide);
  const own = useApp((s) => editing && s.editSaved[slide.id] === slide.hash);
  const shellHash = useApp((s) => s.deck?.shellHash ?? "");
  const assetsRev = useApp((s) => s.assetsRev);
  // Everything else the preview shows, and what reloads it.
  const around = `${slide.id}.${shellHash}.${assetsRev}.${editReload}`;
  const [loaded, setLoaded] = useState({ version, around });
  const keep = own && loaded.around === around;
  if (!keep && (loaded.version !== version || loaded.around !== around)) setLoaded({ version, around });
  return keep ? loaded.version : version;
}

/**
 * Whether the slide shows as a still because the agent is rewriting it. `arrival` names the
 * user's coming to the slide (the slide, and each ask to replay it), `version` what the slide
 * holds. A slide the user comes to plays; a version that follows while the agent is at work
 * loads as a still, and so do those after it, until the user comes again. The agent writes a
 * slide in many steps, and each would otherwise play the slide's entrance from its start.
 */
function useAgentStill(arrival: string, version: string): boolean {
  const running = useApp((s) => s.running);
  const [seen, setSeen] = useState({ arrival, version, still: false });
  if (seen.arrival !== arrival) {
    setSeen({ arrival, version, still: false });
    return false;
  }
  if (seen.version !== version) {
    const still = seen.still || running;
    setSeen({ arrival, version, still });
    return still;
  }
  return seen.still;
}

/** The panel's color, and the palette's colors for the preview's own marks, resolved for its frame. */
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
    danger: resolve("--destructive"),
    guide: resolve("--guide"),
    handle: resolve("--handle"),
    handleForeground: resolve("--handle-foreground"),
    overlay: resolve("--overlay"),
    overlayForeground: resolve("--overlay-foreground"),
    scrim: resolve("--scrim"),
    search: resolve("--search"),
    searchActive: resolve("--search-active"),
  };
  probe.remove();
  return colors;
}
