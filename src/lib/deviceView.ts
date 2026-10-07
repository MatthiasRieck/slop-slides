/**
 * Zoom and pan of the slide in the device view (components/DeviceDeck.tsx): the pure parts,
 * shared by the view and its tests.
 *
 * The view is a pan `x, y` (CSS px, of the slide's center from the screen's center) and a zoom
 * `k` (1 = the slide fit to the screen).
 */

export interface DeviceView {
  x: number;
  y: number;
  k: number;
}

export interface Size {
  width: number;
  height: number;
}

export const HOME: DeviceView = { x: 0, y: 0, k: 1 };
export const MAX_ZOOM = 5;
/** Zoom a double tap goes to. */
export const TAP_ZOOM = 2.5;
/**
 * Widest a slide's page gets (CSS px). iOS draws the page at its own size times the screen's
 * pixel density; a 1920 px page is known to fit in its memory, a few times that is not. Zooming
 * further scales the page up instead of drawing it larger.
 */
export const MAX_PAGE_WIDTH = 1920;
/** Horizontal drag (CSS px) that moves to the next or previous slide. */
export const SWIPE_DISTANCE = 50;

/** The largest 16:9 slide that fits `area`. */
export function fitSlide(area: Size): Size {
  const width = Math.max(0, Math.min(area.width, (area.height * 16) / 9));
  return { width, height: (width * 9) / 16 };
}

/** `view` with its zoom in range, and panned no further than the slide's edges reach the screen's. */
export function clampView(view: DeviceView, slide: Size, area: Size): DeviceView {
  const k = Math.min(MAX_ZOOM, Math.max(1, view.k));
  const maxX = Math.max(0, (slide.width * k - area.width) / 2);
  const maxY = Math.max(0, (slide.height * k - area.height) / 2);
  const clamp = (n: number, max: number) => Math.min(max, Math.max(-max, n)) || 0;
  return { x: clamp(view.x, maxX), y: clamp(view.y, maxY), k };
}

/**
 * The view while pinching: the slide scales with the fingers' spread and the point that was
 * under their midpoint stays under it. Points are relative to the screen's center.
 */
export function pinchView(start: DeviceView, from: [Point, Point], to: [Point, Point]): DeviceView {
  const spread = (pair: [Point, Point]) => Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
  const mid = (pair: [Point, Point]) => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });
  const k = Math.min(MAX_ZOOM, Math.max(1, (start.k * spread(to)) / (spread(from) || 1)));
  const [m0, m1] = [mid(from), mid(to)];
  const ratio = k / start.k;
  return { x: m1.x - ratio * (m0.x - start.x), y: m1.y - ratio * (m0.y - start.y), k };
}

/** Double tap: back to the fit slide when zoomed, else zoomed in on the tapped point (relative to the screen's center). */
export function doubleTapView(view: DeviceView, at: Point): DeviceView {
  if (view.k > 1) return HOME;
  return { x: -at.x * (TAP_ZOOM - 1), y: -at.y * (TAP_ZOOM - 1), k: TAP_ZOOM };
}

/**
 * How many times larger than the fit slide to draw its page at zoom `k`: as large as it is
 * shown, so it stays sharp, up to {@link MAX_PAGE_WIDTH}.
 */
export function pageScale(k: number, slideWidth: number): number {
  if (slideWidth <= 0) return 1;
  return Math.max(1, Math.min(k, MAX_PAGE_WIDTH / slideWidth));
}

/** -1 / 1 for a drag far and flat enough to change slides, else 0. */
export function swipeDirection(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < 2 * Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

export interface Point {
  x: number;
  y: number;
}
