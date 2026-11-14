import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useInView } from "../hooks/useInView";
import type { Slide } from "../lib/api";
import { holdFrameLoads, queueFrameLoad } from "../lib/frameLoads";
import { type Pixels, pixelsOf } from "../lib/slideSize";
import { isPasteboardUrl, slideUrl } from "../lib/utils";
import { useApp } from "../store";

/** The container's custom property a preview's scale is kept in (see `SlideFrame`). */
export const SLIDE_SCALE = "--slide-scale";

/**
 * The attribute of a preview loaded ahead, out of sight (see `warm` on `SlideFrame`): what it
 * posts is not the shown slide's, and the stage does not listen to it (see stage/messages.ts).
 */
export const WARM_ATTR = "data-warm";

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
   * The space the preview fills around the centered slide, as a pasteboard to pan and zoom on,
   * in CSS lengths (which may follow a container, see `StageArea`). The pasteboard draws the
   * slide's frame, which moves with it.
   */
  arena?: { width: string; height: string };
  /**
   * Addresses to load ahead, out of sight, so that showing one of them later is instant: the
   * slides next to the one shown, say. Each loads in its turn among the thumbnails (see
   * ../lib/frameLoads.ts) once the shown one has; one of them shown takes its loaded document
   * along, and the one it replaces stays loaded while it is still one of them. A preview that
   * takes the pointer only.
   */
  warm?: readonly string[];
  className?: string;
  /**
   * The preview shown has loaded: on its `load`, or as soon as it is shown when it had loaded
   * ahead (`warmed`, see `warm`), whatever it did since it loaded then.
   */
  onFrameReady?: (frame: HTMLIFrameElement, warmed: boolean) => void;
  /** One of `warm` has loaded, out of sight: for setting up how it looks before it is shown. */
  onWarmLoad?: (frame: HTMLIFrameElement) => void;
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
 * Its scale is a custom property on its container ({@link SLIDE_SCALE}), set as the container is
 * measured, and the room it fills around the slide (`arena`) is CSS too: resizing a list of
 * thumbnails, or the stage, is the browser's work alone, with no rendering here.
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
  warm = NONE,
  className,
  onFrameReady,
  onWarmLoad,
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

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      // A collapsed panel measures 0 wide: keep the frames (and their loaded slides) as they are.
      if (!entry || entry.contentRect.width <= 0) return;
      el.style.setProperty(SLIDE_SCALE, String(entry.contentRect.width / stageW));
      setMeasured(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [stageW]);

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
  // What loads ahead (see `warm`), and of it what had its turn among the loads.
  const ahead = thumbnail || lazy ? NONE : warm;
  const [admittedWarm, setAdmittedWarm] = useState<readonly string[]>(NONE);
  const aheadNow = useRef(ahead);
  aheadNow.current = ahead;
  /** Keeps the document that was shown loaded, when it is one to have ahead. */
  const keepAhead = useCallback((was: string | null) => {
    if (was !== null && aheadNow.current.includes(was))
      setAdmittedWarm((now) => (now.includes(was) ? now : [...now, was]));
  }, []);
  /** The documents that have loaded, by address, and the frames they are in. */
  const loadedUrls = useRef(new Set<string>());
  const elements = useRef(new Map<string, HTMLIFrameElement>());
  /** A document loaded ahead that has just been shown, for `onFrameReady` once it is. */
  const promoted = useRef<string | null>(null);
  useEffect(() => {
    if (!keeps) return;
    if (target === shown) setPending(null);
    else if (target !== null && loadedUrls.current.has(target) && elements.current.has(target)) {
      // Loaded ahead: shown at once, nothing to wait for.
      promoted.current = target;
      keepAhead(shown);
      setShown(target);
      setPending(null);
    } else setPending(target);
  }, [keeps, target, shown, keepAhead]);
  const frameReady = useRef(onFrameReady);
  frameReady.current = onFrameReady;
  useEffect(() => {
    if (shown === null || promoted.current !== shown) return;
    promoted.current = null;
    const frame = elements.current.get(shown);
    if (frame) frameReady.current?.(frame, true);
  }, [shown]);

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
    if (thumbnail || !measured || newest === null || loadedUrls.current.has(newest)) return;
    const loaded = holdFrameLoads();
    loadDone.current = loaded;
    return loaded;
  }, [thumbnail, measured, newest]);

  const warmDone = useRef(new Map<string, () => void>());
  const settled = laidOut && pending === null && shown !== null && shown === target;
  const waitingWarm = settled ? ahead.filter((url) => url !== shown && !admittedWarm.includes(url)).join("\n") : "";
  useEffect(() => {
    if (!waitingWarm) return;
    const cancels = waitingWarm.split("\n").map((url) =>
      queueFrameLoad((done) => {
        warmDone.current.set(url, done);
        setAdmittedWarm((now) => (now.includes(url) ? now : [...now, url]));
      }, false),
    );
    return () => {
      for (const cancel of cancels) cancel();
    };
  }, [waitingWarm]);
  // Those no longer wanted go, unless shown or about to be.
  const keptWarm = admittedWarm.filter(
    (url) => ahead.includes(url) || url === shown || url === pending || url === target,
  );
  if (keptWarm.length !== admittedWarm.length) setAdmittedWarm(keptWarm);

  // The frames in a stable order: a frame moved in the page would load its document again.
  const order = useRef<string[]>([]);
  const onShow = [shown, pending, ...keptWarm].filter((frame): frame is string => frame !== null);
  const frames = [
    ...order.current.filter((url) => onShow.includes(url)),
    ...onShow.filter((url, i) => !order.current.includes(url) && onShow.indexOf(url) === i),
  ];
  order.current = frames;
  // What went is no longer loaded, nor taking a turn among the loads.
  const framesKey = frames.join("\n");
  useEffect(() => {
    const present = framesKey.split("\n");
    for (const url of [...loadedUrls.current]) if (!present.includes(url)) loadedUrls.current.delete(url);
    for (const url of [...elements.current.keys()]) if (!present.includes(url)) elements.current.delete(url);
    for (const [url, done] of [...warmDone.current]) {
      if (present.includes(url)) continue;
      warmDone.current.delete(url);
      done();
    }
  }, [framesKey]);
  useEffect(
    () => () => {
      for (const done of warmDone.current.values()) done();
      warmDone.current.clear();
    },
    [],
  );
  const bleeds = frames.some(isPasteboardUrl);
  /**
   * Where a frame sits in the container (the slide's box) and how it is scaled into it. Only a
   * pasteboard preview fills the arena, with the slide in its middle; a plain preview given the
   * same room would scale the slide up to fill it.
   */
  const boxFor = (url: string) => {
    const transform = `scale(var(${SLIDE_SCALE}))`;
    if (thumbnail || !arena || !isPasteboardUrl(url))
      return { left: 0, top: 0, width: stageW, height: stageH, transform };
    // Never smaller than the slide; percentages are of the slide's box.
    const w = `max(${arena.width}, 100%)`;
    const h = `max(${arena.height}, 100%)`;
    return {
      left: `calc((100% - ${w}) / 2)`,
      top: `calc((100% - ${h}) / 2)`,
      width: `calc(${w} / var(${SLIDE_SCALE}))`,
      height: `calc(${h} / var(${SLIDE_SCALE}))`,
      transform,
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
            ref={(frame) => {
              if (frame) elements.current.set(url, frame);
            }}
            src={url}
            title={slideId}
            tabIndex={thumbnail ? -1 : undefined}
            sandbox="allow-scripts"
            {...{ [WARM_ATTR]: url !== shown && url !== pending ? "" : undefined }}
            onLoad={(event) => {
              loadedUrls.current.add(url);
              const ahead = warmDone.current.get(url);
              warmDone.current.delete(url);
              ahead?.();
              if (url === pending) {
                keepAhead(shown);
                setShown(url);
                setPending(null);
              }
              if (url === newest) endLoad();
              // One loaded ahead is ready when it is shown.
              if (url === shown || url === pending) onFrameReady?.(event.currentTarget, false);
              else onWarmLoad?.(event.currentTarget);
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

const NONE: readonly string[] = [];

/** Version key for a slide of the open deck: its markup, the deck's shared styles, assets. */
export function useSlideVersion(slide: Slide): string {
  const shellHash = useApp((s) => s.deck?.shellHash ?? "");
  const assetsRev = useApp((s) => s.assetsRev);
  return `${shellHash}.${slide.hash}.${assetsRev}`;
}
