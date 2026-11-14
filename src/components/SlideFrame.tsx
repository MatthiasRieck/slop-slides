import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useInView } from "../hooks/useInView";
import type { Slide } from "../lib/api";
import { holdFrameLoads, queueFrameLoad } from "../lib/frameLoads";
import { type Pixels, pixelsOf } from "../lib/slideSize";
import { isPasteboardUrl, slideUrl } from "../lib/utils";
import { useApp } from "../store";

/** The container's custom property a thumbnail's scale is kept in (see `SlideFrame`). */
export const SLIDE_SCALE = "--slide-scale";

interface SlideFrameProps {
  deckId: string;
  slideId: string;
  /** Any change reloads the preview; see {@link useSlideVersion}. */
  version: string;
  /** Thumbnails render the final animation frame and ignore pointer input. */
  thumbnail?: boolean;
  /**
   * One of many in a list that scrolls: its document is made only when the list shows it or is
   * about to, in its turn among the others (see ../lib/frameLoads.ts), follows new versions only
   * while it is there, and is let go once it is far away. Its box keeps its shape throughout.
   */
  lazy?: boolean;
  /** Renders the final animation frame, as thumbnails do, with the slide still taking pointer input. */
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
  /** Loads this URL instead of the deck's slide (e.g. a template's, see `templateSlideUrl`). */
  url?: string;
  /** The slide's canvas in CSS pixels (see `pixelsOf`); 1920×1080 when not given. */
  size?: Pixels;
}

/**
 * One slide of the deck file, rendered by the deck's own player in an iframe the size of the
 * slide's canvas, scaled to fill its container (which takes the slide's shape). When the slide changes, the new version loads behind the
 * current one and swaps in once painted, so edits stream in without white flashes.
 *
 * A thumbnail's scale is a custom property on its container ({@link SLIDE_SCALE}), set as the
 * container is measured: resizing a list of them is the browser's work alone, with no rendering here.
 */
export function SlideFrame({
  deckId,
  slideId,
  version,
  thumbnail,
  lazy,
  still,
  editKey,
  arena,
  className,
  onFrameReady,
  url,
  size: canvas = pixelsOf(null),
}: SlideFrameProps) {
  const { width: stageW, height: stageH } = canvas;
  const src =
    url ??
    slideUrl(
      deckId,
      slideId,
      version,
      thumbnail || still || editKey !== undefined,
      editKey,
      arena !== undefined && !thumbnail,
    );

  const containerRef = useRef<HTMLDivElement>(null);
  // Whether the container has been measured: until then there is no scale to show anything at.
  const [measured, setMeasured] = useState(false);
  // What a preview that takes the pointer is scaled by; its size on the pasteboard follows from it.
  const [scale, setScale] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      // A collapsed panel measures 0 wide: keep the frames (and their loaded slides) as they are.
      if (!entry || entry.contentRect.width <= 0) return;
      const next = entry.contentRect.width / stageW;
      if (thumbnail) el.style.setProperty(SLIDE_SCALE, String(next));
      else setScale(next);
      setMeasured(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [stageW, thumbnail]);

  const place = useInView(containerRef, !!lazy);
  // The version a lazy preview got its turn to load; none before that, and once it is let go.
  const [admitted, setAdmitted] = useState<string | null>(null);
  if (lazy && place === "away" && admitted !== null) setAdmitted(null);
  /** What the preview is to show: for a lazy one, nothing until it has been near the view. */
  const target = lazy ? admitted : src;

  const [shown, setShown] = useState(target);
  const [pending, setPending] = useState<string | null>(null);
  // With something on show, a new version loads behind it. With nothing (until the first layout,
  // a lazy preview that has no document), there is nothing to keep: it starts with what is current
  // then (e.g. once the stage's arena is known, which is in the render the layout is).
  const [laidOut, setLaidOut] = useState(false);
  const keeps = laidOut && shown !== null && target !== null;
  if (!keeps && shown !== target) setShown(target);
  if (!keeps && pending !== null) setPending(null);
  if (!laidOut && measured) setLaidOut(true);
  useEffect(() => {
    if (keeps) setPending(target === shown ? null : target);
  }, [keeps, target, shown]);

  /** The document loading now, if one is. */
  const newest = pending ?? shown;
  /** Says that the document loading has loaded, or is given up: the next preview's turn (see ../lib/frameLoads.ts). */
  const loadDone = useRef<(() => void) | null>(null);
  const endLoad = useCallback(() => {
    loadDone.current?.();
    loadDone.current = null;
  }, []);
  useEffect(() => endLoad, [endLoad]);

  // A lazy preview waits its turn to load the version it should show, while it is near the view.
  const near = place === "visible" || place === "near";
  const wanted = lazy && measured && near && src !== admitted ? src : null;
  const inView = place === "visible";
  useEffect(() => {
    if (wanted === null) return;
    return queueFrameLoad((done) => {
      // An older version still loading gives its place up.
      endLoad();
      loadDone.current = done;
      setAdmitted(wanted);
    }, inView);
  }, [wanted, inView, endLoad]);
  useEffect(() => {
    if (admitted === null) endLoad();
  }, [admitted, endLoad]);

  // The slide the user works on comes first: thumbnails wait while it loads.
  useEffect(() => {
    if (thumbnail || !measured || newest === null) return;
    const loaded = holdFrameLoads();
    loadDone.current = loaded;
    return loaded;
  }, [thumbnail, measured, newest]);

  const frames = [shown, pending].filter((frame) => frame !== null);
  // Only a pasteboard preview fills the arena, with the slide in its middle. A plain preview given
  // the same room would scale the slide up to fill it.
  const slideW = stageW * scale;
  const slideH = stageH * scale;
  const sizeFor = (url: string) =>
    isPasteboardUrl(url) && arena
      ? { w: Math.max(arena.width, slideW), h: Math.max(arena.height, slideH) }
      : { w: slideW, h: slideH };
  const bleeds = frames.some(isPasteboardUrl);
  /** Where a frame sits in the container and how it is scaled into it. */
  const boxFor = (url: string) => {
    if (thumbnail) return { left: 0, top: 0, width: stageW, height: stageH, transform: `scale(var(${SLIDE_SCALE}))` };
    const size = sizeFor(url);
    return {
      left: (slideW - size.w) / 2,
      top: (slideH - size.h) / 2,
      width: size.w / scale,
      height: size.h / scale,
      transform: `scale(${scale})`,
    };
  };

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: "relative",
        aspectRatio: `${stageW} / ${stageH}`,
        overflow: bleeds ? "visible" : "hidden",
        // The pasteboard paints the slide wherever it is panned to, and nothing around it.
        background: bleeds || thumbnail ? "transparent" : "var(--stage)",
      }}
    >
      {measured &&
        frames.map((url) => (
          /* biome-ignore lint/a11y/noNoninteractiveElementInteractions: The load handler swaps loaded frames and reports readiness; it is not user interaction. */
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
              if (url === newest) endLoad();
              onFrameReady?.(event.currentTarget);
            }}
            style={{
              position: "absolute",
              ...boxFor(url),
              border: 0,
              transformOrigin: "0 0",
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
