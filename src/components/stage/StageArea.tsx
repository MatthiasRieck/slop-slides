import { EyeOff, Lock } from "lucide-react";
import { type ReactNode, type RefObject, useLayoutEffect } from "react";

import { useContentSize } from "../../hooks/useContentSize";
import type { Slide } from "../../lib/api";
import type { Pixels } from "../../lib/slideSize";
import { cn } from "../../lib/utils";
import { SKETCH_TARGET_ATTR } from "../../store";
import { AnnotationLayer, type Annotations } from "../PresenterTools";
import { CurrentSlide } from "./CurrentSlide";
import { arenaAround, gridCells, gridLayout, inPreview, type Neighbor } from "./grid";
import { useShownView, useStageView } from "./stageView";
import { inkBox } from "./usePasteboard";

/** The stage area's padding (Tailwind p-8), which the pasteboard covers too. */
const AREA_PADDING = 32;

/** One of the slides the stage shows, and its number in the deck. */
export interface StageCell {
  slide: Slide;
  number: number;
}

const NO_NEIGHBORS: Neighbor[] = [];

/**
 * The area the stage shows its slide in (which `areaRef` then holds): the slide as large as fits,
 * in its own shape, with what lies on it (`ink`: the marks, the comments' pins) in a box that
 * pans and zooms with it, and over it whatever floats in the area (`children`). The slide's frame
 * (outline, shadow, the edit-mode ring) is drawn in the preview, so it pans and zooms with the
 * slide. The area clips the ink, which zooms past the slide along with the pasteboard, so it
 * stays off the bar below.
 *
 * With several slides to show (`slides`), they lie side by side, each as large as fits (see
 * ./grid.ts). The one worked on (`slide`) is as it is alone: the live preview, the ink, the box
 * screenshots are taken of. Its pasteboard still covers the whole area, so it lies over the
 * others, which are stills: what is dragged off the slide shows over them, and a press on one of
 * them is the pasteboard's to report (`onNeighbors` says where they are in it).
 *
 * Whatever depends on the size of the area is in here, and nothing else: as the area resizes
 * (a panel's separator dragged) this renders, and the stage around it, with its toolbars, does
 * not; nor does what is handed in to lie on the slide or float over it.
 */
export function StageArea(props: {
  areaRef: RefObject<HTMLDivElement | null>;
  deckId: string;
  /** The slide shown, if the deck has one; of several, the one worked on. */
  slide: Slide | undefined;
  /** Every slide shown, in the deck's order: `slide` alone, or it and the ones beside it. */
  slides: StageCell[];
  size: Pixels;
  editing: boolean;
  /** Takes the box what lies on the slide is in, to screenshot areas of it. */
  inkRef: RefObject<HTMLDivElement | null>;
  onFrameReady: (frame: HTMLIFrameElement) => void;
  /** Told where the slides beside `slide` are in its preview, whenever that changes; none when it is alone. */
  onNeighbors: (cells: Neighbor[]) => void;
  ink: ReactNode;
  children: ReactNode;
}) {
  const { areaRef, size, slide, slides, onNeighbors } = props;
  // The preview fills the whole area around the slide: an endless pasteboard to pan and zoom on.
  const inside = useContentSize(areaRef);
  const area = inside
    ? { width: inside.width + 2 * AREA_PADDING, height: inside.height + 2 * AREA_PADDING }
    : undefined;
  const alone = inside ? Math.max(0, Math.min(inside.width, (inside.height * size.width) / size.height)) : 0;
  const aspect = size.height ? size.width / size.height : 0;
  const at = slides.findIndex((cell) => cell.slide.id === slide?.id);
  // Side by side, each slide is as large as they all fit at.
  const grid =
    inside && slides.length > 1 && at >= 0
      ? gridCells(slides.length, gridLayout(slides.length, inside.width, inside.height, aspect), aspect)
      : null;
  const width = grid ? grid.cell.width : alone;
  const fitScale = size.width ? width / size.width : 0;
  // The zoom level under the slide is in the slide's own pixels, which takes the size it fits at.
  useLayoutEffect(() => {
    if (useStageView.getState().fitScale !== fitScale) useStageView.setState({ fitScale });
  }, [fitScale]);

  // The pasteboard of the slide worked on reaches over the others: the slide is in its middle,
  // so it is as much larger than the area as the slide is off the area's middle.
  const here = grid?.cells[at];
  const arena =
    area && grid && here
      ? arenaAround(
          {
            x: (area.width - grid.width) / 2 + here.x + grid.cell.width / 2,
            y: (area.height - grid.height) / 2 + here.y + grid.cell.height / 2,
          },
          area,
        )
      : area;
  const neighbors =
    grid && here && arena && fitScale > 0
      ? slides.flatMap((cell, i): Neighbor[] => {
          const there = grid.cells[i]!;
          if (i === at) return [];
          const corner = inPreview({ x: there.x - here.x, y: there.y - here.y }, arena, size, fitScale);
          return [{ slide: cell.slide.id, ...corner, locked: !!cell.slide.locked }];
        })
      : NO_NEIGHBORS;
  const told = JSON.stringify(neighbors);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `told` is what `neighbors` holds; the list itself is a new one with every render.
  useLayoutEffect(() => {
    onNeighbors(neighbors);
  }, [told, onNeighbors]);

  return (
    <div
      ref={areaRef}
      data-testid="stage-area"
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-8"
    >
      {slide && (
        // The same boxes for one slide and for several, so a slide keeps its preview as others come
        // to lie beside it or go. Alone, the outer one is no box at all. With several it is a layer
        // of its own: the slide worked on lies over the others, and what floats in the area over them all.
        <div
          data-testid={grid ? "stage-grid" : undefined}
          className={grid ? "relative isolate shrink-0" : "contents"}
          style={grid ? { width: grid.width, height: grid.height } : undefined}
        >
          {(grid ? slides : [{ slide, number: 0 }]).map((cell, i) => {
            const active = !grid || i === at;
            return (
              <div
                key={cell.slide.id}
                data-stage-cell={grid ? cell.slide.id : undefined}
                style={grid ? { left: grid.cells[i]!.x, top: grid.cells[i]!.y, width } : { width }}
                {...(active ? { [SKETCH_TARGET_ATTR]: "", "data-editing": props.editing || undefined } : {})}
                className={cn(grid ? "absolute" : "relative", grid && active && "z-10")}
              >
                {grid && <CellLabel cell={cell} active={active} />}
                <CurrentSlide
                  deckId={props.deckId}
                  slide={cell.slide}
                  size={size}
                  editing={props.editing}
                  active={active}
                  arena={arena}
                  canvas={areaRef}
                  onFrameReady={props.onFrameReady}
                />
                {active && (
                  <InkBox ref={props.inkRef} scale={fitScale}>
                    {props.ink}
                  </InkBox>
                )}
              </div>
            );
          })}
        </div>
      )}
      {props.children}
    </div>
  );
}

/** Over a slide shown beside others: its number in the deck, and whether it is locked or hidden. */
function CellLabel({ cell, active }: { cell: StageCell; active: boolean }) {
  return (
    <div
      data-testid="cell-label"
      className={cn(
        "pointer-events-none absolute bottom-full left-0 mb-1 flex items-center gap-1 text-2xs tabular-nums text-muted-foreground",
        active && "font-semibold text-foreground",
      )}
    >
      <span>{cell.number}</span>
      {cell.slide.locked && <Lock role="img" aria-label="Locked slide" className="size-3" />}
      {cell.slide.hidden && <EyeOff role="img" aria-label="Hidden slide" className="size-3" />}
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
