import { createElement, type ReactElement, type RefObject, useLayoutEffect, useRef, useState } from "react";

type Held = RefObject<HTMLElement | null>;

/**
 * Notes what has the focus as a popup opens. A popup's contents mount as it opens, and Base UI
 * moves the focus in only after that, so what is focused at the first render is what was focused
 * before. (A popup opened again while it still fades out does not mount anew, and keeps what it
 * noted: the focus was given back there a moment ago.)
 */
function FocusBefore({ held }: { held: Held }) {
  const [before] = useState(() => document.activeElement);
  useLayoutEffect(() => {
    held.current = before instanceof HTMLElement && before !== document.body ? before : null;
  }, [held, before]);
  return null;
}

/**
 * Where the focus goes as a popover, menu or select closes: back to where it was as it opened.
 * Base UI gives it to the trigger instead, which is the same thing when the trigger was opened
 * with the keys, or with a press that focuses it. WebKit leaves the focus where it was when a
 * button is pressed, though: in the message being typed, or on the slide, and that is where the
 * keys must go on to. Returns the popup's `finalFocus` (the caller's own wins) and `mark`, to
 * render inside the popup.
 */
export function useReturnFocus<T>(finalFocus: T | undefined): {
  finalFocus: T | (() => HTMLElement | true);
  mark: ReactElement;
} {
  const held = useRef<HTMLElement | null>(null);
  const [toBefore] = useState(() => () => {
    const before = held.current;
    // Gone meanwhile, or nothing to go back to: Base UI's own choice, the trigger.
    return before?.isConnected ? before : true;
  });
  return { finalFocus: finalFocus ?? toBefore, mark: createElement(FocusBefore, { held }) };
}
