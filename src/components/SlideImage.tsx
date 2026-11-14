import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { useInView } from "../hooks/useInView";
import { queuePictureLoad } from "../lib/frameLoads";
import { type Pixels, pixelsOf } from "../lib/slideSize";
import { forgetPicture, pictureUrl } from "../lib/thumbnails";
import { slideUrl } from "../lib/utils";
import { SlideFrame } from "./SlideFrame";

/**
 * How long a slide in view waits for its picture before the live preview stands in for it, in
 * ms. A picture the backend keeps is in at once; one it has to make first, the first time a deck
 * is opened, takes a moment, in which the slide still shows.
 */
export const LIVE_AFTER = 400;

interface SlideImageProps {
  deckId: string;
  slideId: string;
  /** Any change shows the slide anew; see `useSlideVersion`. */
  version: string;
  /** The preview to show a picture of instead of the deck's slide (a template's, a committed one). */
  url?: string;
  /** The slide's canvas in CSS pixels (see `pixelsOf`); 1920×1080 when not given. */
  size?: Pixels;
  /**
   * One of many in a list that scrolls: its picture is asked for only when the list shows it or
   * is about to, the ones in view first, and let go once it is far away (see `SlideFrame`'s).
   */
  lazy?: boolean;
  className?: string;
}

/**
 * A still thumbnail of a slide (its last animation frame), as a picture the backend makes and
 * keeps (see src-tauri/src/thumbnails.rs) rather than a document of its own: lists of slides show
 * dozens of them, and a picture costs the window next to nothing to show. A new version loads
 * behind the one on show and takes its place once it is in, so a slide being edited never blinks.
 *
 * While a slide in view has no picture yet for longer than {@link LIVE_AFTER}, the live thumbnail
 * (`SlideFrame`) stands in, and goes once the picture is in. Where there are no pictures (the
 * browser preview) or one could not be made, it is the live thumbnail from then on.
 */
export function SlideImage(props: SlideImageProps) {
  const preview = props.url ?? slideUrl(props.deckId, props.slideId, props.version, true);
  const picture = pictureUrl(preview);
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  const live = (className?: string) => (
    <SlideFrame
      deckId={props.deckId}
      slideId={props.slideId}
      version={props.version}
      url={props.url}
      size={props.size}
      thumbnail
      lazy={props.lazy}
      className={className}
    />
  );
  if (picture === null || failed) return live(props.className);
  return (
    <Picture
      src={picture}
      size={props.size ?? pixelsOf(null)}
      lazy={!!props.lazy}
      className={props.className}
      onFailed={fail}
      live={live}
    />
  );
}

function Picture(props: {
  src: string;
  size: Pixels;
  lazy: boolean;
  className?: string;
  onFailed: () => void;
  /** The live thumbnail, to stand in while the picture is late. */
  live: (className?: string) => ReactNode;
}) {
  const { src, lazy, onFailed } = props;
  const box = useRef<HTMLDivElement>(null);
  const place = useInView(box, lazy);
  // The picture whose turn to load has come; none before that, and once it is let go.
  const [admitted, setAdmitted] = useState<string | null>(null);
  if (lazy && place === "away" && admitted !== null) setAdmitted(null);
  // The picture on show; a newer one admitted loads behind it.
  const [shown, setShown] = useState<string | null>(null);
  if (admitted === null && shown !== null) setShown(null);
  const pending = admitted !== null && admitted !== shown ? admitted : null;

  // In view with nothing on show for a while: the live thumbnail stands in until the picture is in.
  const waiting = shown === null && place === "visible";
  const [late, setLate] = useState(false);
  if (late && !waiting) setLate(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setLate(true), LIVE_AFTER);
    return () => clearTimeout(timer);
  }, [waiting]);

  /** Says that the picture loading has loaded or failed: the next one's turn (see ../lib/frameLoads.ts). */
  const loadDone = useRef<(() => void) | null>(null);
  const endLoad = useCallback(() => {
    loadDone.current?.();
    loadDone.current = null;
  }, []);
  useEffect(() => endLoad, [endLoad]);

  const near = place === "visible" || place === "near";
  const wanted = near && src !== admitted ? src : null;
  const inView = place === "visible";
  useEffect(() => {
    if (wanted === null) return;
    return queuePictureLoad((done) => {
      endLoad();
      loadDone.current = done;
      setAdmitted(wanted);
    }, inView);
  }, [wanted, inView, endLoad]);
  useEffect(() => {
    if (admitted === null) endLoad();
  }, [admitted, endLoad]);

  // The picture pending last, once it has loaded or failed. One let go before that (scrolled far
  // away, or a newer version asked for) is no longer wanted: the backend need not make it.
  const settled = useRef<string | null>(null);
  const pendingNow = useRef(pending);
  pendingNow.current = pending;
  useEffect(() => {
    if (pending === null) return;
    return () => {
      if (settled.current !== pending) forgetPicture(pending);
    };
  }, [pending]);

  /** Shows the picture `url` that has loaded, once it is decoded, so that it never shows half drawn. */
  const swap = (img: HTMLImageElement, url: string) => {
    settled.current = url;
    const show = () => {
      if (url !== pendingNow.current) return;
      setShown(url);
      endLoad();
    };
    if (typeof img.decode === "function") img.decode().then(show, show);
    else show();
  };

  const pictures = [shown, pending].filter((picture) => picture !== null);
  return (
    <div
      ref={box}
      className={props.className}
      style={{ position: "relative", aspectRatio: `${props.size.width} / ${props.size.height}`, overflow: "hidden" }}
    >
      {late && waiting && (
        <div data-stand-in="" style={{ position: "absolute", inset: 0 }}>
          {props.live("w-full")}
        </div>
      )}
      {pictures.map((url) => (
        /* biome-ignore lint/a11y/noNoninteractiveElementInteractions: The load handlers swap loaded pictures; they are not user interaction. */
        <img
          key={url}
          src={url}
          alt=""
          draggable={false}
          decoding="async"
          onLoad={(event) => {
            if (url === pending) swap(event.currentTarget, url);
          }}
          onError={() => {
            if (url !== pending) return;
            settled.current = url;
            endLoad();
            onFailed();
          }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            visibility: url === shown ? "visible" : "hidden",
          }}
        />
      ))}
    </div>
  );
}
