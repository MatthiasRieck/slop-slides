/**
 * The line between the two versions in the before and after comparison. It runs through a point
 * of the slide, at any angle, with the old version on one side of it and the new one on the other.
 */
export interface Divider {
  /** The point it runs through, as fractions of the slide's width and height. */
  x: number;
  y: number;
  /** Degrees clockwise. At 0 the line stands upright, with the old version on the left. */
  angle: number;
}

export const DEFAULT_DIVIDER: Divider = { x: 0.5, y: 0.5, angle: 0 };
/** How far from the divider's point the handle that rotates it sits, in CSS pixels. */
const KNOB_DISTANCE = 72;
const KNOB_ROOM = 16;

export interface Point {
  x: number;
  y: number;
}

interface Box {
  width: number;
  height: number;
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const round = (n: number) => Math.round(n * 100) / 100;

/** `degrees` as the same direction within -180 (not included) and 180. */
export function normalAngle(degrees: number): number {
  const turned = ((degrees % 360) + 360) % 360;
  return turned > 180 ? turned - 360 : turned;
}

/** Which way the line runs, on the screen. */
const along = ({ angle }: Divider): Point => ({ x: Math.sin(radians(angle)), y: -Math.cos(radians(angle)) });
/** Across the line, from the old version towards the new one. */
const across = ({ angle }: Divider): Point => ({ x: Math.cos(radians(angle)), y: Math.sin(radians(angle)) });

/** The divider's point in a slide shown `box` big, in CSS pixels. */
export function dividerPoint(divider: Divider, box: Box): Point {
  return { x: divider.x * box.width, y: divider.y * box.height };
}

/** The divider moved to `point` (CSS pixels in `box`), staying on the slide. */
export function movedTo(divider: Divider, point: Point, box: Box): Divider {
  return { ...divider, x: clamp(point.x / box.width, 0, 1), y: clamp(point.y / box.height, 0, 1) };
}

/** The divider moved `fraction` of the slide across itself, towards the new version when positive. */
export function shifted(divider: Divider, fraction: number, box: Box): Divider {
  const reach = Math.hypot(box.width, box.height) * fraction;
  const { x, y } = dividerPoint(divider, box);
  const { x: dx, y: dy } = across(divider);
  return movedTo(divider, { x: x + dx * reach, y: y + dy * reach }, box);
}

/**
 * The mask that shows the new version only past the divider, for a slide shown `box` big. The
 * gradient's line runs through the box's center, as long as it takes to reach the corners.
 */
export function revealMask(divider: Divider, box: Box): string {
  const { x: dx, y: dy } = across(divider);
  const { x, y } = dividerPoint(divider, box);
  const length = Math.abs(box.width * dx) + Math.abs(box.height * dy);
  const at = (x - box.width / 2) * dx + (y - box.height / 2) * dy + length / 2;
  return `linear-gradient(${normalAngle(divider.angle + 90)}deg, transparent ${round(at)}px, #000 ${round(at)}px)`;
}

/** Where the divider enters and leaves `box`, to draw it. */
export function dividerEnds(divider: Divider, box: Box): [Point, Point] {
  const point = dividerPoint(divider, box);
  const { x: dx, y: dy } = along(divider);
  // How far along the line each pair of the box's sides is; the closer pair ends it.
  const reach = (from: number, step: number, size: number) => {
    if (Math.abs(step) < 1e-9) return [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY] as const;
    const [a, b] = [-from / step, (size - from) / step];
    return [Math.min(a, b), Math.max(a, b)] as const;
  };
  const [x0, x1] = reach(point.x, dx, box.width);
  const [y0, y1] = reach(point.y, dy, box.height);
  const [start, end] = [Math.max(x0, y0), Math.min(x1, y1)];
  const at = (t: number) => ({ x: point.x + dx * t, y: point.y + dy * t });
  return [at(start), at(end)];
}

/**
 * Which way along the divider (1 up it, -1 down it) its rotate handle goes: up, unless that would
 * put the handle off the slide.
 */
export function knobSide(divider: Divider, box: Box): 1 | -1 {
  const { x, y } = knobAt(divider, box, 1);
  const fits = x >= KNOB_ROOM && x <= box.width - KNOB_ROOM && y >= KNOB_ROOM && y <= box.height - KNOB_ROOM;
  return fits ? 1 : -1;
}

/** Where the rotate handle is on `side`, in CSS pixels. */
export function knobAt(divider: Divider, box: Box, side: 1 | -1): Point {
  const { x, y } = dividerPoint(divider, box);
  const { x: dx, y: dy } = along(divider);
  return { x: x + dx * KNOB_DISTANCE * side, y: y + dy * KNOB_DISTANCE * side };
}

/** Where to put a label `distance` CSS pixels to the old (-1) or new (1) side of the divider's point. */
export function sideLabelAt(divider: Divider, box: Box, side: 1 | -1, distance: number): Point {
  const { x, y } = dividerPoint(divider, box);
  const { x: dx, y: dy } = across(divider);
  return { x: x + dx * distance * side, y: y + dy * distance * side };
}

/**
 * The angle that points the rotate handle on `side` at `pointer`, in whole degrees, or in steps of
 * `snap` degrees if given.
 */
export function angleTowards(divider: Divider, pointer: Point, box: Box, side: 1 | -1, snap = 1): number {
  const { x, y } = dividerPoint(divider, box);
  const degrees = (Math.atan2((pointer.x - x) * side, (y - pointer.y) * side) * 180) / Math.PI;
  return normalAngle(Math.round(degrees / snap) * snap);
}
