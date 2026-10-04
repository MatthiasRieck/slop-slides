import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { deckFileUrl } from "../lib/utils";
import { useApp } from "../store";

const STAGE_W = 1920;
const STAGE_H = 1080;

interface SlideFrameProps {
  deckId: string;
  slide: string;
  /** Thumbnails render the final animation frame and ignore pointer input. */
  thumbnail?: boolean;
  className?: string;
  onFrameReady?: (frame: HTMLIFrameElement) => void;
}

/**
 * A slide document in a 1920×1080 iframe, scaled to fill its (16:9) container. When the
 * file changes, the new version loads behind the current one and swaps in once painted,
 * so edits stream in without white flashes.
 */
export function SlideFrame({ deckId, slide, thumbnail, className, onFrameReady }: SlideFrameProps) {
  const rev = useApp((s) => s.slideRevs[slide] ?? 0);
  const sharedRev = useApp((s) => s.sharedRev);
  const src = deckFileUrl(deckId, slide, `v=${sharedRev}.${rev}${thumbnail ? "&static" : ""}`);

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
            title={slide}
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
