import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** How close to its end, in pixels, a conversation still counts as scrolled to its end. */
const PINNED_WITHIN = 48;

/**
 * Keeps what scrolls (`scroller`, around `content`) at its end while the reader is there, and
 * says when they are not (`away`), which is when to offer `toEnd`. A new `sent` (the id of the
 * reader's own newest message) takes them to the end wherever they had scrolled to: it is what
 * they want to see next.
 *
 * The end is followed as the content or the room for it changes size, which is told by the
 * browser once per frame, after its layout: a reply growing, a picture that loads late, the
 * composer getting taller, the chat coming back into view. Nothing is measured when the
 * conversation renders for another reason.
 */
export function usePinnedScroll(sent: string | undefined) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const seenSent = useRef(sent);
  const [away, setAway] = useState(false);

  const toEnd = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setAway(false);
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !content.current) return;
    const follow = () => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(content.current);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (sent === seenSent.current) return;
    seenSent.current = sent;
    toEnd();
  }, [sent, toEnd]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    // Out of view it has no size, and where it is scrolled to says nothing.
    if (!el || el.clientHeight === 0) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_WITHIN;
    setAway(!pinned.current);
  }, []);

  return { scroller, content, away, toEnd, onScroll };
}
