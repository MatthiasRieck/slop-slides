import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Slide } from "../lib/api";
import { isRemote } from "../lib/platform";
import { cn, isPasteboardUrl, slideUrl } from "../lib/utils";
import { useApp } from "../store";

const STAGE_W = 1920;
const STAGE_H = 1080;
/**
 * The pasteboard's largest size, in slides: a slide squeezed small (e.g. on a phone) would
 * otherwise get a preview page tens of thousands of px across, which iOS kills the page over.
 */
export const MAX_ARENA_SLIDES = 3;

interface SlideFrameProps {
  deckId: string;
  slideId: string;
  /** Any change reloads the preview; see {@link useSlideVersion}. */
  version: string;
  /** Thumbnails render the final animation frame and ignore pointer input. */
  thumbnail?: boolean;
  /** Renders the final frame of every animation and transition, so slides show up at once. */
  still?: boolean;
  /** Loads the slide editor (final animation frame, editable); changing the key reloads it. */
  editKey?: string;
  /**
   * The space (CSS px) the preview fills around the centered slide, as a pasteboard to pan and
   * zoom on. The pasteboard draws the slide's frame, which moves with it.
   */
  arena?: { width: number; height: number };
  className?: string;
  onFrameReady?: (frame: HTMLIFrameElement) => void;
}

/**
 * One slide of deck.html, rendered by the deck's own player in a 1920×1080 iframe scaled to
 * fill its (16:9) container. When the slide changes, the new version loads behind the
 * current one and swaps in once painted, so edits stream in without white flashes.
 */
export function SlideFrame(props: SlideFrameProps) {
  // Every preview is a whole page of its own; phones and tablets kill the app's page when it
  // holds a dozen of them (one per thumbnail), so there thumbnails are plain placeholders.
  if (isRemote && props.thumbnail) return <ThumbnailPlaceholder className={props.className} />;
  return <LiveSlideFrame {...props} />;
}

function ThumbnailPlaceholder({ className }: { className?: string }) {
  return <div data-testid="thumbnail-placeholder" className={cn("aspect-video bg-muted", className)} />;
}

function LiveSlideFrame({ deckId, slideId, version, thumbnail, still, editKey, arena, className, onFrameReady }: SlideFrameProps) {
  const src = slideUrl(deckId, slideId, version, thumbnail || still || editKey !== undefined, editKey, arena !== undefined && !thumbnail);

  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [shown, setShown] = useState(src);
  const [pending, setPending] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setScale(entry.contentRect.width / STAGE_W);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Until the first layout nothing is shown, so there is nothing to keep while a new version
  // loads: the preview starts with whatever is current then (e.g. once the stage's arena is known).
  const [laidOut, setLaidOut] = useState(false);
  if (!laidOut && src !== shown) setShown(src);
  if (!laidOut && scale > 0) setLaidOut(true);

  useEffect(() => {
    if (laidOut && src !== shown) setPending(src);
  }, [src, shown, laidOut]);

  const frames = pending ? [shown, pending] : [shown];
  // Only a pasteboard preview fills the arena, with the slide in its middle. A plain preview given
  // the same room would scale the slide up to fill it.
  const slideW = STAGE_W * scale;
  const slideH = STAGE_H * scale;
  const sizeFor = (url: string) =>
    isPasteboardUrl(url) && arena
      ? {
          w: Math.min(Math.max(arena.width, slideW), MAX_ARENA_SLIDES * slideW),
          h: Math.min(Math.max(arena.height, slideH), MAX_ARENA_SLIDES * slideH),
        }
      : { w: slideW, h: slideH };
  const bleeds = frames.some(isPasteboardUrl);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: "relative",
        aspectRatio: "16 / 9",
        overflow: bleeds ? "visible" : "hidden",
        // The pasteboard paints the slide wherever it is panned to, and nothing around it.
        background: bleeds ? "transparent" : "#000",
      }}
    >
      {scale > 0 &&
        frames.map((url) => {
          const size = sizeFor(url);
          // iOS draws a slide's page at its own size, however small it is shown: a 1920×1080 page
          // scaled down costs a phone ~75 MB, and many times that once zoomed in, so the page is
          // killed. On a device the page is the size it is shown and the deck's player fits the
          // slide into it. The pasteboard (and the editor on it) needs the slide at full size.
          const fitted = isRemote && !isPasteboardUrl(url);
          return (
            <iframe
              key={url}
              src={url}
              title={slideId}
              tabIndex={thumbnail ? -1 : undefined}
              sandbox="allow-scripts"
              onLoad={(event) => {
                if (url === pending) {
                  setShown(url);
                  setPending(null);
                }
                onFrameReady?.(event.currentTarget);
              }}
              style={{
                position: "absolute",
                left: (slideW - size.w) / 2,
                top: (slideH - size.h) / 2,
                width: fitted ? size.w : size.w / scale,
                height: fitted ? size.h : size.h / scale,
                border: 0,
                transformOrigin: "0 0",
                transform: fitted ? undefined : `scale(${scale})`,
                pointerEvents: thumbnail ? "none" : "auto",
                visibility: url === shown ? "visible" : "hidden",
              }}
            />
          );
        })}
    </div>
  );
}

/** Version key for a slide of the open deck: its markup, the deck's shared styles, assets. */
export function useSlideVersion(slide: Slide): string {
  const shellHash = useApp((s) => s.deck?.shellHash ?? "");
  const assetsRev = useApp((s) => s.assetsRev);
  return `${shellHash}.${slide.hash}.${assetsRev}`;
}
