// Keyboard focus within a part of the page: what can take it there, and where it starts.
import type { RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled):not([type=hidden])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "iframe",
  "[contenteditable]:not([contenteditable=false])",
  "[tabindex]",
].join(", ");

/** What Tab stops at inside `root`, in the order of the page. */
export function focusableIn(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.tabIndex >= 0 && !element.closest("[hidden], [inert]"),
  );
}

/**
 * Where the focus starts in a dialog or popover that just opened: `initialFocus`, else what the
 * markup marks with `autofocus` (or `data-autofocus`, as React keeps `autoFocus` to itself);
 * undefined when it names no place.
 */
export function focusTarget(root: Element, initialFocus?: RefObject<HTMLElement | null>): HTMLElement | undefined {
  return initialFocus?.current ?? root.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? undefined;
}

/**
 * Keeps Tab inside `root`: from its last stop it goes to the first, and with Shift from the
 * first to the last. True when it moved the focus itself, and the key is done with.
 */
export function wrapTab(root: HTMLElement, event: Pick<KeyboardEvent, "key" | "shiftKey">): boolean {
  if (event.key !== "Tab") return false;
  const stops = focusableIn(root);
  const active = document.activeElement;
  const first = stops[0];
  const last = stops.at(-1);
  if (!first || !last) {
    // Nothing to stop at: the focus stays on the box itself.
    root.focus();
    return true;
  }
  const outside = !root.contains(active) || active === root;
  if (event.shiftKey && (outside || active === first)) last.focus();
  else if (!event.shiftKey && (outside || active === last)) first.focus();
  else return false;
  return true;
}

/** Whether a key was pressed last, rather than the pointer. */
let keyboard = false;

if (typeof document !== "undefined") {
  const HELD = ["Shift", "Control", "Alt", "Meta"];
  document.addEventListener(
    "keydown",
    (event) => {
      if (!HELD.includes(event.key)) keyboard = true;
    },
    true,
  );
  const pressed = () => {
    keyboard = false;
  };
  for (const press of ["pointerdown", "mousedown"]) document.addEventListener(press, pressed, true);
  // A press in a slide preview never reaches this window; the preview reports it (pasteboard.js).
  window.addEventListener("message", (event) => {
    if (event.data?.type === "slop:press") pressed();
  });
}

/**
 * Whether the keyboard is what the user works with just now: a key was pressed since the last
 * press of the pointer. What opens on a key then puts the focus on its first control.
 */
export function usingKeyboard(): boolean {
  return keyboard;
}

/**
 * What gives the focus back when something that took it goes away. `before` is what had the
 * focus as it opened; the focus goes back there if it is now inside `root` (or nowhere, `root`
 * being gone) and `before` is still in the page. Focus that has moved elsewhere stays there.
 */
export function restoreFocus(root: Element | null, before: Element | null): void {
  const active = document.activeElement;
  const held = !active || active === document.body || (root?.contains(active) ?? false);
  if (held && before instanceof HTMLElement && before.isConnected && before !== document.body) before.focus();
}
