/** Something that happens at most once per animation frame, with the value pushed last. */
export interface PerFrame<T> {
  /** Hands on `value`: at once when the frame has had none yet, else in the next frame unless a later one replaces it. */
  push: (value: T) => void;
  /** Hands on the value still waiting for its frame, now. */
  flush: () => void;
  /** Drops the value still waiting for its frame. */
  cancel: () => void;
}

/**
 * Passes values on to `apply` at most once per animation frame: the first right away, so a single
 * one is never late, and of those that follow within the frame only the last, when the next frame
 * starts. For what arrives faster than the screen shows it (a drag's moves, a camera's changes).
 */
export function perFrame<T>(apply: (value: T) => void): PerFrame<T> {
  // A value went through and its frame is not over.
  let spent = false;
  let frame = 0;
  let held: { value: T } | null = null;
  const pass = (value: T) => {
    spent = true;
    frame = requestAnimationFrame(next);
    apply(value);
  };
  const next = () => {
    spent = false;
    if (!held) return;
    const { value } = held;
    held = null;
    pass(value);
  };
  return {
    push: (value) => {
      if (spent) held = { value };
      else pass(value);
    },
    flush: () => {
      if (!held) return;
      const { value } = held;
      held = null;
      apply(value);
    },
    cancel: () => {
      held = null;
      spent = false;
      cancelAnimationFrame(frame);
    },
  };
}
