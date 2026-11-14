import { useCallback, useEffect, useRef, useState } from "react";

/** How long the show's controls and the cursor stay after the pointer last moved, in ms. */
export const IDLE_MS = 2500;

/**
 * Whether the show's controls (and the cursor) are in sight: at the start of the show, while the
 * pointer moves and for `IDLE_MS` after, and for as long as they are `held` (a drawing tool is
 * picked, say) or the pointer is on them. A move over the slide happens in its own page, which
 * tells the show (`slop:pointer`, see src-tauri/assets/runtime.js); the show calls `wake` then,
 * as it does when a key changes something the controls show.
 */
export function useShowControls(held: boolean) {
  const [idle, setIdle] = useState(false);
  const [over, setOver] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setIdle(true), IDLE_MS);
  }, []);

  useEffect(() => {
    wake();
    window.addEventListener("mousemove", wake);
    return () => {
      window.removeEventListener("mousemove", wake);
      clearTimeout(timer.current);
    };
  }, [wake]);

  return {
    visible: !idle || held || over,
    wake,
    /** For the controls themselves: the pointer on them keeps them in sight. */
    zoneProps: { onMouseEnter: () => setOver(true), onMouseLeave: () => setOver(false) },
  };
}
