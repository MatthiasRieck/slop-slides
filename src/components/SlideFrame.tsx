import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Slide } from "../lib/api";
import { slideUrl } from "../lib/utils";
import { useApp } from "../store";

const STAGE_W = 1920;
const STAGE_H = 1080;

interface SlideFrameProps {
  deckId: string;
  slideId: string;
  /** Any change reloads the preview; see {@link useSlideVersion}. */
  version: string;
  /** Thumbnails render the final animation frame and ignore pointer input. */
  thumbnail?: boolean;
  /** Loads the slide editor (final animation frame, editable); changing the key reloads it. */
  editKey?: string;
  className?: string;
  onFrameReady?: (frame: HTMLIFrameElement) => void;
}

/**
 * One slide of deck.html, rendered by the deck's own player in a 1920×1080 iframe scaled to
 * fill its (16:9) container. When the slide changes, the new version loads behind the
 * current one and swaps in once painted, so edits stream in without white flashes.
 */
export function SlideFrame({ deckId, slideId, version, thumbnail, editKey, className, onFrameReady }: SlideFrameProps) {
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

  const frames = pending ? [shown, pending] : [shown];

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: "relative", aspectRatio: "16 / 9", overflow: "hidden", background: "#000" }}
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
              left: 0,
              top: 0,
              width: STAGE_W,
              height: STAGE_H,
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
