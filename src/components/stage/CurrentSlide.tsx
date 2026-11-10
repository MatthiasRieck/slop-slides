import { type RefObject, useEffect, useRef, useSyncExternalStore } from "react";

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
  return (
    <SlideFrame
      deckId={props.deckId}
      slideId={id}
      version={useSlideVersion(props.slide)}
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
