import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/** A box's width and height, in CSS pixels. */
export interface BoxSize {
  width: number;
  height: number;
}

const sameSize = (a: BoxSize | null, b: BoxSize | null) =>
  a === b || (!!a && !!b && a.width === b.width && a.height === b.height);

/**
 * The size of the content box of what `ref` holds, to the whole pixel, kept up to date as it
 * resizes; null until it is measured. A report of the size it already has renders nothing again:
 * observers report more often than a box changes by a pixel (as a panel's separator is dragged,
 * say).
 */
export function useContentSize(ref: RefObject<HTMLElement | null>): BoxSize | null {
  return useContentFit(ref, keepSize, sameSize);
}

const keepSize = (size: BoxSize | null) => size;

/**
 * What `derive` makes of the size of the content box of what `ref` holds (to the whole pixel; null
 * until it is measured), kept up to date as it resizes. It renders again only when what `derive`
 * gives changes (by `same`), not with every pixel the box changes by: for what changes at a few
 * widths only, such as which labels a bar has room for, a drag of a panel's separator renders
 * nothing until it crosses one of them.
 */
export function useContentFit<T>(
  ref: RefObject<HTMLElement | null>,
  derive: (size: BoxSize | null) => T,
  same: (a: T, b: T) => boolean = Object.is,
): T {
  const [value, setValue] = useState(() => derive(null));
  const latest = useRef({ derive, same, value });
  latest.current = { derive, same, value };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { derive, same, value } = latest.current;
      const next = derive({ width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) });
      if (same(value, next)) return;
      // Known at once, so a second report before the render compares with this one.
      latest.current = { ...latest.current, value: next };
      setValue(() => next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return value;
}
