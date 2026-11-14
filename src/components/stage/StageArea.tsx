import { type ReactNode, type RefObject, useLayoutEffect } from "react";

import { useContentSize } from "../../hooks/useContentSize";
import type { Slide } from "../../lib/api";
import type { Pixels } from "../../lib/slideSize";
import { SKETCH_TARGET_ATTR } from "../../store";
import { AnnotationLayer, type Annotations } from "../PresenterTools";
import { CurrentSlide } from "./CurrentSlide";
import { useShownView, useStageView } from "./stageView";
import { inkBox } from "./usePasteboard";

/** The stage area's padding (Tailwind p-8), which the pasteboard covers too. */
const AREA_PADDING = 32;

/**
 * The area the stage shows its slide in (which `areaRef` then holds): the slide as large as fits,
 * in its own shape, with what lies on it (`ink`: the marks, the comments' pins) in a box that
 * pans and zooms with it, and over it whatever floats in the area (`children`). The slide's frame
 * (outline, shadow, the edit-mode ring) is drawn in the preview, so it pans and zooms with the
 * slide. The area clips the ink, which zooms past the slide along with the pasteboard, so it
 * stays off the bar below.
 *
 * Whatever depends on the size of the area is in here, and nothing else: as the area resizes
 * (a panel's separator dragged) this renders, and the stage around it, with its toolbars, does
 * not; nor does what is handed in to lie on the slide or float over it.
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
  onFrameReady: (frame: HTMLIFrameElement) => void;
  ink: ReactNode;
  children: ReactNode;
}) {
  const { areaRef, size, slide } = props;
  // The preview fills the whole area around the slide: an endless pasteboard to pan and zoom on.
  const inside = useContentSize(areaRef);
  const arena = inside
    ? { width: inside.width + 2 * AREA_PADDING, height: inside.height + 2 * AREA_PADDING }
    : undefined;
  const width = inside ? Math.max(0, Math.min(inside.width, (inside.height * size.width) / size.height)) : 0;
  const fitScale = size.width ? width / size.width : 0;
  // The zoom level under the slide is in the slide's own pixels, which takes the size it fits at.
  useLayoutEffect(() => {
    if (useStageView.getState().fitScale !== fitScale) useStageView.setState({ fitScale });
  }, [fitScale]);

  return (
    <div
      ref={areaRef}
      data-testid="stage-area"
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-8"
    >
      {slide && (
        <div
          style={{ width }}
          {...{ [SKETCH_TARGET_ATTR]: "" }}
          data-editing={props.editing || undefined}
          className="relative"
        >
          <CurrentSlide
            deckId={props.deckId}
            slide={slide}
            size={size}
            editing={props.editing}
            arena={arena}
            canvas={areaRef}
            onFrameReady={props.onFrameReady}
          />
          <InkBox ref={props.inkRef} scale={fitScale}>
            {props.ink}
          </InkBox>
        </div>
      )}
      {props.children}
    </div>
  );
}

/** Keeps what lies on the slide on it, wherever the pasteboard has moved it: it follows the view by itself. */
function InkBox(props: { ref: RefObject<HTMLDivElement | null>; scale: number; children: ReactNode }) {
  const view = useShownView((shown) => shown);
  return (
    <div
      ref={props.ref}
      data-testid="annotation-view"
      className="pointer-events-none absolute"
      style={inkBox(view, props.scale)}
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
