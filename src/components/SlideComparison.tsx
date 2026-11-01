import { GripVertical } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef } from "react";

import { useChanges } from "../changesStore";
import {
  angleTowards,
  dividerEnds,
  dividerPoint,
  knobAt,
  knobSide,
  movedTo,
  normalAngle,
  revealMask,
  shifted,
  sideLabelAt,
} from "../lib/compare";

/** Steps of the keyboard (Shift for the larger one) and of the rotate handle with Shift held. */
const SHIFT_STEP = 0.01;
const SHIFT_STEP_LARGE = 0.1;
const ANGLE_STEP = 1;
const ANGLE_STEP_LARGE = 15;
/** How far the two versions' names sit from the divider's point, in CSS pixels. */
const LABEL_DISTANCE = 56;

type Drag = { kind: "move" } | { kind: "rotate"; side: 1 | -1 };

/**
 * Two versions of a slide on top of each other, split by a divider. Drag anywhere to move it and
 * its round handle to rotate it; `feather` fades one version into the other around it. Both
 * previews stay under the surface that takes the pointer, so a drag never ends up in an iframe.
 */
export function SlideComparison(props: {
  /** The size the slide is shown at, in CSS pixels. */
  box: { width: number; height: number };
  /** CSS pixels per slide pixel. */
  scale: number;
  before: ReactNode;
  after: ReactNode;
}) {
  const { box, scale } = props;
  const divider = useChanges((s) => s.divider);
  const setDivider = useChanges((s) => s.setDivider);
  const drag = useRef<Drag | null>(null);
  const surface = useRef<HTMLDivElement>(null);

  const at = (event: PointerEvent) => {
    const rect = surface.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const follow = (event: PointerEvent) => {
    const now = drag.current;
    if (!now) return;
    const point = at(event);
    if (now.kind === "move") {
      const { x, y } = movedTo(divider, point, box);
      setDivider({ x, y });
    } else {
      setDivider({ angle: angleTowards(divider, point, box, now.side, event.shiftKey ? ANGLE_STEP_LARGE : 1) });
    }
  };

  const start = (event: PointerEvent, next: Drag) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    surface.current?.setPointerCapture(event.pointerId);
    (event.target as HTMLElement).focus();
    drag.current = next;
    follow(event);
  };

  const onMoveKey = (event: KeyboardEvent) => {
    const step = event.shiftKey ? SHIFT_STEP_LARGE : SHIFT_STEP;
    const by = keyStep(event.key);
    if (by === 0) return;
    event.preventDefault();
    const { x, y } = shifted(divider, by * step, box);
    setDivider({ x, y });
  };

  const onRotateKey = (event: KeyboardEvent) => {
    const by = keyStep(event.key);
    if (by === 0) return;
    event.preventDefault();
    setDivider({ angle: normalAngle(divider.angle + by * (event.shiftKey ? ANGLE_STEP_LARGE : ANGLE_STEP)) });
  };

  const point = dividerPoint(divider, box);
  const [lineStart, lineEnd] = dividerEnds(divider, box);
  const side = knobSide(divider, box);
  const knob = knobAt(divider, box, side);
  const mask = revealMask(divider, box, scale);

  return (
    <div className="relative bg-black" style={box} data-testid="slide-comparison">
      <div className="absolute inset-0 flex items-center overflow-hidden">{props.before}</div>
      <div
        data-testid="comparison-after"
        data-mask={mask}
        className="absolute inset-0 flex items-center overflow-hidden bg-black"
        style={{ maskImage: mask, WebkitMaskImage: mask }}
      >
        {props.after}
      </div>
      <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
        <line
          x1={lineStart.x}
          y1={lineStart.y}
          x2={lineEnd.x}
          y2={lineEnd.y}
          stroke="rgb(0 0 0 / 0.45)"
          strokeWidth={4}
        />
        <line x1={lineStart.x} y1={lineStart.y} x2={lineEnd.x} y2={lineEnd.y} stroke="white" strokeWidth={2} />
        <line x1={point.x} y1={point.y} x2={knob.x} y2={knob.y} stroke="white" strokeWidth={2} strokeDasharray="3 3" />
      </svg>
      <div
        ref={surface}
        data-testid="comparison-surface"
        className="absolute inset-0 cursor-move touch-none select-none"
        onPointerDown={(event) => start(event, { kind: "move" })}
        onPointerMove={follow}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <Name at={sideLabelAt(divider, box, -1, LABEL_DISTANCE)}>Old</Name>
        <Name at={sideLabelAt(divider, box, 1, LABEL_DISTANCE)}>New</Name>
        <button
          type="button"
          role="slider"
          aria-label="Move the divider"
          aria-valuenow={Math.round((divider.angle % 180 === 0 ? divider.x : divider.y) * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          title="Drag to move the divider"
          onKeyDown={onMoveKey}
          style={{ left: point.x, top: point.y, rotate: `${divider.angle}deg` }}
          className="absolute flex size-8 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full bg-white text-black shadow-md ring-1 ring-black/20"
        >
          <GripVertical className="size-4" />
        </button>
        <button
          type="button"
          role="slider"
          aria-label="Rotate the divider"
          aria-valuenow={divider.angle}
          aria-valuemin={-180}
          aria-valuemax={180}
          title="Drag to rotate the divider; hold Shift for steps of 15°"
          onKeyDown={onRotateKey}
          onPointerDown={(event) => start(event, { kind: "rotate", side })}
          style={{ left: knob.x, top: knob.y }}
          className="absolute size-5 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-white bg-primary shadow-md"
        />
      </div>
    </div>
  );
}

/** Which version is on a side of the divider. */
function Name({ at, children }: { at: { x: number; y: number }; children: ReactNode }) {
  return (
    <span
      style={{ left: at.x, top: at.y }}
      className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded bg-black/70 px-1.5 py-0.5 text-2xs font-medium text-white"
    >
      {children}
    </span>
  );
}

function keyStep(key: string): number {
  if (key === "ArrowRight" || key === "ArrowDown") return 1;
  if (key === "ArrowLeft" || key === "ArrowUp") return -1;
  return 0;
}
