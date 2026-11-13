import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { Slide } from "../../lib/api";
import { getSlideClock, onSlideClock, postSlideClock } from "../../lib/slideClock";
import type { Pixels } from "../../lib/slideSize";
import { useApp } from "../../store";
import { SlideFrame, useSlideVersion } from "../SlideFrame";

/** The stage's preview of the current slide: the editor in edit mode, else the slide as it plays or a still. */
export function CurrentSlide(props: {
  deckId: string;
  slide: Slide;
  size: Pixels;
  editing: boolean;
  /** The panel around the slide; its colors frame the slide and dim what lies outside it in the editor. */
  canvas: RefObject<HTMLElement | null>;
  arena?: { width: number; height: number };
  onFrameReady: (frame: HTMLIFrameElement) => void;
}) {
  const editReload = useApp((s) => s.editReload);
  const finalState = useApp((s) => s.finalState);
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
  const version = useEditorVersion(props.slide, props.editing && !played, editReload);
  return (
    <SlideFrame
      deckId={props.deckId}
      slideId={id}
      version={version}
      editKey={props.editing && !played ? String(editReload) : undefined}
      still={finalState && !played}
      arena={props.arena}
      size={props.size}
      onFrameReady={(loaded) => {
        frame.current = loaded;
        postSlideClock(loaded, id);
        const canvas = props.canvas.current;
        if (canvas) loaded.contentWindow?.postMessage({ type: "slop:canvas", ...canvasColors(canvas) }, "*");
        props.onFrameReady(loaded);
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
