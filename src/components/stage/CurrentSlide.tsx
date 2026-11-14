import { type RefObject, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { Slide } from "../../lib/api";
import { getSlideClock, onSlideClock, postSlideClock } from "../../lib/slideClock";
import type { Pixels } from "../../lib/slideSize";
import { slideUrl } from "../../lib/utils";
import { useApp } from "../../store";
import type { AppState } from "../../store/types";
import { SlideFrame, useSlideVersion } from "../SlideFrame";
import { useStageDocument } from "./stageDocument";

/**
 * The stage's preview of the current slide: the editor in edit mode, else the slide as it plays or a still.
 *
 * A slide plays its animations when the user comes to it or asks for them again. The versions the
 * agent writes of it while it works load as stills (see `useAgentStill`). Its page stays as long
 * as it can show what is wanted (see ./stageDocument.ts): Edit mode comes and goes on it, and
 * while the editor is on it a new version of the slide (an undo, the agent's) is patched in.
 */
export function CurrentSlide(props: {
  deckId: string;
  slide: Slide;
  size: Pixels;
  editing: boolean;
  /** The panel around the slide; its colors frame the slide and dim what lies outside it in the editor. */
  canvas: RefObject<HTMLElement | null>;
  arena?: { width: string; height: string };
  /** The preview has loaded; `warmed` when it had loaded ahead, out of sight (see `useEditorNeighbours`). */
  onFrameReady: (frame: HTMLIFrameElement, warmed: boolean) => void;
}) {
  const editReload = useApp((s) => s.editReload);
  const finalState = useApp((s) => s.finalState);
  // Loading the slide again is what plays its animations again; the editor shows none to replay.
  const replay = useApp((s) => s.replayRev);
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
  const version = useSlideVersion(props.slide);
  const editor = props.editing && !played;
  const agentStill = useAgentStill(`${id}.${replay}`, version);
  const own = useApp((s) => editor && s.editSaved[id] === props.slide.hash);
  const shellHash = useApp((s) => s.deck?.shellHash ?? "");
  const assetsRev = useApp((s) => s.assetsRev);
  const pan = props.arena !== undefined;
  const page = useStageDocument(
    { deckId: props.deckId, slideHash: props.slide.hash, editReload, pan },
    {
      slide: id,
      // Narration playing over the slide shows it as it plays, in a page of its own.
      around: `${shellHash}.${assetsRev}.${editReload}.${played}`,
      replay,
      version,
      edit: editor,
      still: editor || ((finalState || agentStill) && !played),
      own,
    },
    frame,
  );
  const warm = useEditorNeighbours(props.deckId, id, editor, editReload, pan);
  return (
    <SlideFrame
      deckId={props.deckId}
      slideId={id}
      version={page.version}
      editKey={page.editKey}
      still={page.still}
      arena={props.arena}
      size={props.size}
      warm={warm}
      onWarmLoad={(loaded) => postCanvas(loaded, props.canvas.current)}
      onFrameReady={(loaded, warmed) => {
        frame.current = loaded;
        page.onReady(loaded);
        postSlideClock(loaded, id);
        postCanvas(loaded, props.canvas.current);
        props.onFrameReady(loaded, warmed);
      }}
    />
  );
}

/**
 * While `editing`, the editor's previews of the slides before and after `slide` in the deck, to
 * load ahead out of sight: going to the next slide or back then shows its editor at once instead
 * of loading it (see `warm` on SlideFrame). Each address is the one this preview would load for
 * that slide, so it is the same document. A locked slide is shown without the editor: none of it.
 * They wait while the agent is at work.
 */
function useEditorNeighbours(deckId: string, slide: string, editing: boolean, editReload: number, pan: boolean) {
  // While the agent works, the slides change one after the other: none load ahead to be dropped.
  const around = useApp((s) => (editing && !s.running ? neighboursKey(s, slide) : ""));
  return useMemo(
    () =>
      around
        ? around.split("\n").map((version) => {
            const [id, at] = version.split("\t");
            return slideUrl(deckId, id!, at!, true, String(editReload), pan);
          })
        : NO_NEIGHBOURS,
    [around, deckId, editReload, pan],
  );
}

/** The slides next to `slide` that the editor can open, each with its version, as one string that changes when they do. */
function neighboursKey(app: AppState, slide: string): string {
  const slides = app.deck?.slides ?? [];
  const at = slides.findIndex((s) => s.id === slide);
  if (at < 0) return "";
  const versionOf = (s: (typeof slides)[number]) => `${app.deck?.shellHash ?? ""}.${s.hash}.${app.assetsRev}`;
  return [slides[at - 1], slides[at + 1]]
    .filter((s) => s !== undefined && !s.locked)
    .map((s) => `${s!.id}\t${versionOf(s!)}`)
    .join("\n");
}

const NO_NEIGHBOURS: readonly string[] = [];

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

/** Tells a preview the colors around it (see `canvasColors`). */
function postCanvas(frame: HTMLIFrameElement, canvas: HTMLElement | null) {
  if (canvas) frame.contentWindow?.postMessage({ type: "slop:canvas", ...canvasColors(canvas) }, "*");
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
