import { useEffect, useRef, useState } from "react";

/**
 * `value` once it has stayed the same for `delay` ms, and the one before it until then; with no
 * delay, `value` as it is. For following something that changes in quick bursts (a slide saved
 * again and again while it is edited) with work that is only worth doing for where it ends up.
 * A value that is followed at once costs no rendering of its own.
 */
export function useSettled<T>(value: T, delay: number): T {
  /** The value handed out last, which stays while a newer one waits. */
  const settled = useRef(value);
  const [, wake] = useState(0);
  const waits = delay > 0 && settled.current !== value;
  useEffect(() => {
    if (!waits) {
      settled.current = value;
      return;
    }
    const timer = setTimeout(() => {
      settled.current = value;
      wake((n) => n + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [value, delay, waits]);
  return waits ? settled.current : value;
}
