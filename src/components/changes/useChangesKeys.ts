import { useEffect } from "react";

import { useChanges } from "../../changesStore";
import { keepsKey } from "../../lib/keys";
import { lintKey, useApp } from "../../store";

/** Reads the changes when the deck does, and on coming back to the window after a version saved elsewhere. */
export function useRefreshChanges(deck: string) {
  // The deck's key is worked out once per deck object, not on every update of the store.
  const content = useApp((s) => `${s.assetsRev}|${lintKey(s.deck)}`);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the deck's content changes
  useEffect(() => {
    void useChanges.getState().refresh(deck);
  }, [deck, content]);
  useEffect(() => {
    const onFocus = () => void useChanges.getState().refresh(deck);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [deck]);
}

/** Whether a key pressed on `target` is that control's own: Space presses a button, ticks a checkbox. */
function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, a, input, select, textarea, [role=slider]") !== null;
}

/**
 * The keys of Changes mode. Arrow keys go through the list, as they go through the slides on the
 * stage; ⌘Z takes a discard back like any change to the deck; and Space, held, shows the other
 * version of the slide in place, for as long as it is held.
 */
export function useChangesKeyboard() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (useApp.getState().presenting || event.altKey) return;
      if (keepsKey(event)) return;
      // A discard is a change to the deck: the same keys take it back as anywhere else.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void (event.shiftKey ? useApp.getState().redo() : useApp.getState().undo());
        return;
      }
      if (event.metaKey || event.ctrlKey) return;
      if (event.key === " ") {
        if (isControl(event.target)) return;
        // Held, the key repeats; the page must not scroll under it either way.
        event.preventDefault();
        if (!event.repeat) useChanges.getState().setFlipped(true);
        return;
      }
      const forward = ["ArrowDown", "ArrowRight", "PageDown"].includes(event.key);
      if (!forward && !["ArrowUp", "ArrowLeft", "PageUp"].includes(event.key)) return;
      event.preventDefault();
      useChanges.getState().step(forward ? 1 : -1);
    };
    const release = (event: KeyboardEvent) => {
      if (event.key === " ") useChanges.getState().setFlipped(false);
    };
    // A key let go in another window is never heard of: leaving the window lets go of it.
    const letGo = () => useChanges.getState().setFlipped(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", letGo);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", letGo);
      letGo();
    };
  }, []);
}

/**
 * The handlers of something that flips to the other version for as long as it is pressed, with
 * the pointer or, focused, with Space or Enter.
 */
export function holdToFlip() {
  const { setFlipped } = useChanges.getState();
  const isHoldKey = (key: string) => key === " " || key === "Enter";
  return {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // The pointer may leave while held; the release still comes here.
      event.currentTarget.setPointerCapture(event.pointerId);
      setFlipped(true);
    },
    onPointerUp: () => setFlipped(false),
    onPointerCancel: () => setFlipped(false),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (isHoldKey(event.key) && !event.repeat) setFlipped(true);
    },
    onKeyUp: (event: React.KeyboardEvent) => {
      if (isHoldKey(event.key)) setFlipped(false);
    },
    onBlur: () => setFlipped(false),
  };
}
