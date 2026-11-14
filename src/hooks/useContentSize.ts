import { type RefObject, useLayoutEffect, useState } from "react";

/** A box's width and height, in CSS pixels. */
export interface BoxSize {
  width: number;
  height: number;
}

/**
 * The size of the content box of what `ref` holds, to the whole pixel, kept up to date as it
 * resizes; null until it is measured. A report of the size it already has renders nothing again:
 * observers report more often than a box changes by a pixel (as a panel's separator is dragged,
 * say).
 */
export function useContentSize(ref: RefObject<HTMLElement | null>): BoxSize | null {
  const [size, setSize] = useState<BoxSize | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last: BoxSize | null = null;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const next = { width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) };
      if (last && last.width === next.width && last.height === next.height) return;
      last = next;
      setSize(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
