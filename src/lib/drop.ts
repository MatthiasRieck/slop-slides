import { isWindows } from "./utils";

/**
 * Files dropped on the window. Parts of the window claim the files that land on them (the chat
 * attaches them, the slide being edited places images); decks dropped anywhere else open.
 */

/** A point in the window, in CSS pixels. */
export interface DropPoint {
  x: number;
  y: number;
}

/** Takes the files it wants from a drop at `point`; returns the ones it leaves. */
export type DropCatcher = (paths: string[], point: DropPoint) => string[];

const catchers = new Map<DropCatcher, (point: DropPoint) => boolean>();

/**
 * Lets `catcher` claim dropped files; returns a function that stops it. `covers` tells whether
 * it would take a drop at a point, so the chat does not invite drops it would not get.
 */
export function catchDrops(catcher: DropCatcher, covers: (point: DropPoint) => boolean = () => false): () => void {
  catchers.set(catcher, covers);
  return () => {
    catchers.delete(catcher);
  };
}

/** Whether a catcher would take files dropped at `point`. */
export function dropCovered(point: DropPoint | null): boolean {
  return !!point && [...catchers.values()].some((covers) => covers(point));
}

/** Hears where files being dragged over the window are, or null once they leave or drop. */
export type DragWatcher = (point: DropPoint | null) => void;

const watchers = new Set<DragWatcher>();

/** Tells `watcher` where files being dragged are; returns a function that stops it. */
export function watchDrag(watcher: DragWatcher): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

/** A drag and drop event of the window, as Tauri reports it. */
export type DragDropPayload =
  | { type: "enter"; paths: string[]; position?: { x: number; y: number } }
  | { type: "over"; position?: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position?: { x: number; y: number } }
  | { type: "leave" };

/**
 * Handles a drag and drop event of the window: tells the watchers where the files are, and
 * hands dropped ones to the catchers, then the ones none of them took to `rest`.
 */
export function handleDragDrop(payload: DragDropPayload, rest: (paths: string[]) => void) {
  const point = payload.type === "leave" || payload.type === "drop" ? null : dropPoint(payload.position);
  for (const watcher of watchers) watcher(point);
  if (payload.type !== "drop") return;
  const left = claimDrop(payload.paths, dropPoint(payload.position));
  if (left.length > 0) rest(left);
}

/** Whether `point` lies within `element`'s box on screen. */
export function within(element: Element | null, point: DropPoint): boolean {
  if (!element) return false;
  const box = element.getBoundingClientRect();
  return (
    box.width > 0 &&
    box.height > 0 &&
    point.x >= box.left &&
    point.x <= box.right &&
    point.y >= box.top &&
    point.y <= box.bottom
  );
}

/** Hands dropped files to the catchers in turn; returns the ones none of them took. */
export function claimDrop(paths: string[], point: DropPoint | null): string[] {
  if (!point) return paths;
  let rest = paths;
  for (const catcher of catchers.keys()) {
    if (rest.length === 0) break;
    rest = catcher(rest, point);
  }
  return rest;
}

/**
 * The drop position Tauri reports, in CSS pixels. Tauri calls it physical, but only on Windows
 * is it: macOS and Linux report it in points, which are CSS pixels already.
 */
export function dropPoint(position: { x: number; y: number } | undefined, physical = isWindows): DropPoint | null {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  const ratio = physical ? window.devicePixelRatio || 1 : 1;
  return { x: position.x / ratio, y: position.y / ratio };
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
export const isImage = (path: string) => IMAGE_EXTENSIONS.test(path);

/** The natural size of the image at `url`, or null if it does not load (in time) or has none. */
export function imageSize(url: string, timeout = 3000): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const done = (size: { w: number; h: number } | null) => {
      clearTimeout(timer);
      img.onload = img.onerror = null;
      resolve(size);
    };
    const timer = setTimeout(() => done(null), timeout);
    img.onload = () =>
      done(img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null);
    img.onerror = () => done(null);
    img.src = url;
  });
}
