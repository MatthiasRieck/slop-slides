import { type RefObject, useEffect, useState } from "react";

import { scrollerOf, watchIntersection } from "../lib/viewObserver";

/** How far around the scroller's view an element counts as about to be seen. */
const AHEAD = "100%";

/**
 * Whether the element in `ref` has been in view yet, or within a screenful of it: false until the
 * browser says so, then true for good. For work that is only worth doing for what the user gets
 * to see, and need not be undone once it scrolled away again.
 */
export function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (seen || !element) return;
    return watchIntersection(element, scrollerOf(element), AHEAD, (entry) => {
      if (entry.isIntersecting) setSeen(true);
    });
  }, [ref, seen]);
  return seen;
}
