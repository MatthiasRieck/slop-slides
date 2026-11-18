import { useCallback, useEffect, useRef, useState } from "react";

/** How long the cursor, and the controls called up, stay after the pointer last moved, in ms. */
export const IDLE_MS = 2500;

/** How far above the bottom of the show the pointer calls up its controls, in CSS px. */
export const ZONE_PX = 120;

/**
 * Whether the show's controls are in sight, and whether the cursor rests. The controls sit at
 * the bottom and come up only when the pointer moves within `ZONE_PX` of it: moves elsewhere
 * over the slide leave them out of the audience's way. They stay while the pointer moves there
 * and for `IDLE_MS` after, go as soon as it moves away, and stay for as long as they are `held`
 * (a drawing tool is picked, say) or the pointer is on them. The cursor comes with any move and
 * goes once the pointer rests for `IDLE_MS`.
 *
 * A move over the slide happens in its own page, which tells the show how far above the bottom
 * it is (`slop:pointer`, see src-tauri/assets/runtime.js); the show calls `move` with that, and
 * `wake` when a key changes something the controls show.
 */
export function useShowControls(held: boolean) {
  const [cursorIdle, setCursorIdle] = useState(false);
  const [called, setCalled] = useState(false);
  const [over, setOver] = useState(false);
  const cursorTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const barTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  /** Brings the controls up for `IDLE_MS`. */
  const wake = useCallback(() => {
    setCalled(true);
    clearTimeout(barTimer.current);
    barTimer.current = setTimeout(() => setCalled(false), IDLE_MS);
  }, []);

  /** The pointer moved, `bottom` px above the bottom of the show (unknown: not near it). */
  const move = useCallback(
    (bottom?: number) => {
      setCursorIdle(false);
      clearTimeout(cursorTimer.current);
      cursorTimer.current = setTimeout(() => setCursorIdle(true), IDLE_MS);
      if (bottom !== undefined && Number.isFinite(bottom) && bottom <= ZONE_PX) wake();
      else {
        clearTimeout(barTimer.current);
        setCalled(false);
      }
    },
    [wake],
  );

  useEffect(() => {
    cursorTimer.current = setTimeout(() => setCursorIdle(true), IDLE_MS);
    const onMove = (event: MouseEvent) => move(window.innerHeight - event.clientY);
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      clearTimeout(cursorTimer.current);
      clearTimeout(barTimer.current);
    };
  }, [move]);

  return {
    visible: called || held || over,
    /** Whether the cursor over the slide is hidden: the pointer rests, and no tool needs it. */
    cursorHidden: cursorIdle && !held,
    wake,
    move,
    /** For the controls themselves: the pointer on them keeps them in sight. */
    zoneProps: { onMouseEnter: () => setOver(true), onMouseLeave: () => setOver(false) },
  };
}
