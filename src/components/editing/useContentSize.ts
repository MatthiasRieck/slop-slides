import { type RefObject, useLayoutEffect, useState } from "react";

/** A box's width and height, in CSS pixels. */
export interface BoxSize {
  width: number;
  height: number;
}

/** The size of the content box of what `ref` holds, kept up to date as it resizes; null until it is measured. */
export function useContentSize(ref: RefObject<HTMLElement | null>): BoxSize | null {
  const [size, setSize] = useState<BoxSize | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
