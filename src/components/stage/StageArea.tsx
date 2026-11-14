import { type ReactNode, type RefObject, useLayoutEffect } from "react";

import type { Slide } from "../../lib/api";
import { zoomBox } from "../../lib/ink";
import type { Pixels } from "../../lib/slideSize";
import { SKETCH_TARGET_ATTR, useApp } from "../../store";
import { AnnotationLayer, type Annotations } from "../PresenterTools";
import { CurrentSlide } from "./CurrentSlide";
import { isMoved, useShownView, useStageView } from "./stageView";

/** The stage area's padding (Tailwind p-8), which the pasteboard covers too. */
const AREA_PADDING = 32;

/**
 * The room the preview fills around the slide, as CSS lengths: the whole area, its padding too.
 * The area is a size container, so these follow it as it resizes, with nothing rendering.
 */
const ARENA = {
  width: `calc(100cqw + ${2 * AREA_PADDING}px)`,
  height: `calc(100cqh + ${2 * AREA_PADDING}px)`,
};

/**
 * The area the stage shows its slide in (which `areaRef` then holds): the slide as large as fits,
 * in its own shape, with what lies on it (`ink`: the marks, the comments' pins) in a box that
 * pans and zooms with it, and over it whatever floats in the area (`children`). The slide's frame
 * (outline, shadow, the edit-mode ring) is drawn in the preview, so it pans and zooms with the
 * slide. The area clips the ink, which zooms past the slide along with the pasteboard, so it
 * stays off the bar below.
 *
 * The size of the area is the browser's to follow, in CSS (the area is a size container): as it
 * resizes (a panel's separator dragged), nothing here renders, nor does the preview, nor what is
 * handed in to lie on the slide or float over it. Only the size the slide fits at (`fitScale`)
 * is worked out, into its own store, for what reads it.
 */
export function StageArea(props: {
  areaRef: RefObject<HTMLDivElement | null>;
  deckId: string;
  /** The slide shown, if the deck has one. */
  slide: Slide | undefined;
  size: Pixels;
  editing: boolean;
  /** Takes the box what lies on the slide is in, to screenshot areas of it. */
  inkRef: RefObject<HTMLDivElement | null>;
  /** The preview has loaded; `warmed` when it had loaded ahead and was just shown. */
  onFrameReady: (frame: HTMLIFrameElement, warmed: boolean) => void;
  ink: ReactNode;
  children: ReactNode;
}) {
  const { areaRef, size, slide } = props;
  const ratio = size.height ? size.width / size.height : 1;
  // The zoom level under the slide is in the slide's own pixels, which takes the size it fits at.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const fitScale = size.width ? Math.max(0, Math.min(width, height * ratio)) / size.width : 0;
      if (useStageView.getState().fitScale !== fitScale) useStageView.setState({ fitScale });
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, [areaRef, size.width, ratio]);

  return (
    <div
      ref={areaRef}
      data-testid="stage-area"
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-8"
      style={{ containerType: "size" }}
    >
      {slide && (
        <div
          // As large as fits the area, in the slide's shape (see SlideFrame).
          style={{ width: `min(100cqw, ${ratio} * 100cqh)` }}
          {...{ [SKETCH_TARGET_ATTR]: "" }}
          data-editing={props.editing || undefined}
          className="relative"
        >
          <CurrentSlide
            deckId={props.deckId}
            slide={slide}
            size={size}
            editing={props.editing}
            arena={ARENA}
            canvas={areaRef}
            onFrameReady={props.onFrameReady}
          />
          <InkBox ref={props.inkRef}>{props.ink}</InkBox>
        </div>
      )}
      {props.children}
    </div>
  );
}

/**
 * Keeps what lies on the slide on it, wherever the pasteboard has moved it: it follows the view by
 * itself. Resized with the slide, it renders only while the view is moved: the pan is in screen
 * pixels, which the size the slide fits at turns slide pixels into.
 */
function InkBox(props: { ref: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const selected = useApp((s) => s.selected);
  const place = useStageView((s) => {
    const view = s.view?.slide === selected ? s.view : null;
    return view && isMoved(view) ? `${view.x * s.fitScale} ${view.y * s.fitScale} ${view.k}` : "";
  });
  const [x = 0, y = 0, k = 1] = place ? place.split(" ").map(Number) : [];
  return (
    <div
      ref={props.ref}
      data-testid="annotation-view"
      className="pointer-events-none absolute"
      style={zoomBox(x, y, k)}
    >
      {props.children}
    </div>
  );
}

/** The ink on the stage's slide, drawn at the size the view has zoomed it to; a pan does not render it. */
export function StageInk({ annotations }: { annotations: Annotations }) {
  const zoom = useShownView((shown) => shown?.k);
  return <AnnotationLayer annotations={annotations} zoom={zoom} />;
}
