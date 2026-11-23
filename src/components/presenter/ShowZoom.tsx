import { Maximize } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";

import { zoomBox } from "../../lib/ink";
import { AnnotationLayer, type Annotations } from "../PresenterTools";
import { ShowButton } from "./ShowButton";

/** Asks the show's pasteboard to fit the slide to the screen again. */
export function fitSlide(frame: HTMLIFrameElement | null) {
  frame?.contentWindow?.postMessage({ type: "slop:camera", home: true }, "*");
}

/**
 * What follows the slide as it is zoomed and panned in the show: the ink, which goes along with
 * the slide, and, once the slide is anywhere but fit to the screen, a button that fits it again
 * and says how far it is zoomed.
 *
 * The slide's page (`frame`) tells how it is zoomed with a `slop:zoom` message for every move of
 * the wheel or the fingers. That is kept here and not in the show: only this is rendered again
 * for it, not the show's bar and tools.
 */
export function ShowZoom({
  frame,
  annotations,
}: {
  frame: RefObject<HTMLIFrameElement | null>;
  annotations: Annotations;
}) {
  const [zoom, setZoom] = useState({ x: 0, y: 0, k: 1 });
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== "slop:zoom") return;
      const { x, y, k } = event.data;
      if ([x, y, k].every(Number.isFinite)) setZoom({ x, y, k });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame]);
  const moved = !(zoom.x === 0 && zoom.y === 0 && zoom.k === 1);
  return (
    <>
      <div
        data-testid="annotation-zoom"
        className="pointer-events-none absolute"
        style={zoomBox(zoom.x, zoom.y, zoom.k)}
      >
        <AnnotationLayer annotations={annotations} zoom={zoom.k} />
      </div>
      {moved && (
        // Outside the show's bar, so dark by itself. Pressing it leaves the focus where it was.
        <ShowButton
          size="sm"
          tooltip="Back to the slide, fit to the screen"
          shortcut="0"
          tooltipSide="left"
          onClick={() => fitSlide(frame.current)}
          className="dark absolute right-4 bottom-20 z-10 rounded-xl border-foreground/10 bg-overlay text-xs tabular-nums shadow-lg backdrop-blur hover:bg-overlay"
        >
          <Maximize />
          {Math.round(zoom.k * 100)}%
        </ShowButton>
      )}
    </>
  );
}
