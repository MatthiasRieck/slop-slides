// Keyboard focus, and what leaves it where it is.

/**
 * An `onMouseDown` that keeps the keyboard focus (and the text selection) where it is when a
 * button is pressed: in the slide, for the toolbars that work on what is selected there.
 */
export function keepFocus(event: { preventDefault: () => void }) {
  event.preventDefault();
}

/**
 * An `onFocus` that keeps a field's focus from the tooltip around it: a field shows its hint
 * under the pointer only, not for as long as it is typed in.
 */
export function quietFocus(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}
