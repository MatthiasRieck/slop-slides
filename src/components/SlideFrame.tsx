import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Slide } from "../lib/api";
import { slideUrl } from "../lib/utils";
import { useApp } from "../store";

const STAGE_W = 1920;
const STAGE_H = 1080;
/** Slide pixels of room the edit-mode preview gets around the slide, to show what runs past its edge. */
export const EDIT_BLEED = { x: 320, y: 180 };
/** How much of the space the edit-mode preview needs is the slide itself. */
export const EDIT_FIT = STAGE_W / (STAGE_W + 2 * EDIT_BLEED.x);

interface SlideFrameProps {
  deckId: string;
  slideId: string;
  /** Any change reloads the preview; see {@link useSlideVersion}. */
  version: string;
  /** Thumbnails render the final animation frame and ignore pointer input. */
  thumbnail?: boolean;
  /** Loads the slide editor (final animation frame, editable); changing the key reloads it. */
  editKey?: string;
  /** Lets the preview extend beyond the slide by EDIT_BLEED on every side (edit mode only). */
  bleed?: boolean;
  className?: string;
  onFrameReady?: (frame: HTMLIFrameElement) => void;
}

/**
 * One slide of deck.html, rendered by the deck's own player in a 1920×1080 iframe scaled to
 * fill its (16:9) container. When the slide changes, the new version loads behind the
 * current one and swaps in once painted, so edits stream in without white flashes.
 */
export function SlideFrame({ deckId, slideId, version, thumbnail, editKey, bleed, className, onFrameReady }: SlideFrameProps) {
  const src = slideUrl(deckId, slideId, version, thumbnail || editKey !== undefined, editKey);

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

  useEffect(() => {
    if (src !== shown) setPending(src);
  }, [src, shown]);

  const room = bleed ? EDIT_BLEED : { x: 0, y: 0 };
  const frames = pending ? [shown, pending] : [shown];

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: "relative", aspectRatio: "16 / 9", overflow: bleed ? "visible" : "hidden", background: "#000" }}
    >
      {scale > 0 &&
        frames.map((url) => (
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
              left: -room.x * scale,
              top: -room.y * scale,
              width: STAGE_W + 2 * room.x,
              height: STAGE_H + 2 * room.y,
              border: 0,
              transformOrigin: "0 0",
              transform: `scale(${scale})`,
              pointerEvents: thumbnail ? "none" : "auto",
              visibility: url === shown ? "visible" : "hidden",
            }}
          />
        ))}
    </div>
  );
}

/** Version key for a slide of the open deck: its markup, the deck's shared styles, assets. */
export function useSlideVersion(slide: Slide): string {
  const shellHash = useApp((s) => s.deck?.shellHash ?? "");
  const assetsRev = useApp((s) => s.assetsRev);
  return `${shellHash}.${slide.hash}.${assetsRev}`;
}
