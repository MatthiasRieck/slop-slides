import { useLayoutEffect } from "react";

import { openLayer } from "@/lib/layers";

/** Presses Escape where the focus is, for what closes on the key itself (a Base UI popup). */
function pressEscape() {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

/**
 * Counts what renders it as open over the app (see ../lib/layers.ts) for as long as it is
 * mounted: the app's shortcuts hold back, and a slide preview hands its Escape over, which closes
 * the popup as the key does. The shadcn/ui popups render it inside their popup (dialog, sheet,
 * popover, menus, select, combobox), which mounts only while open; a popup that is `keepMounted`
 * would count as open all along, so none is.
 */
export function OverlayLayer() {
  useLayoutEffect(() => openLayer(pressEscape, { own: true }), []);
  return null;
}

/**
 * The `onKeyDown` of a modal dialog's box: every key pressed in it is the dialog's, and none
 * reaches the app's shortcuts (⌘Z, the arrows…). Escape goes on, to close what is on top.
 */
export function keepKeys<T extends { key: string; stopPropagation: () => void }>(onKeyDown?: (event: T) => void) {
  return (event: T) => {
    onKeyDown?.(event);
    if (event.key !== "Escape") event.stopPropagation();
  };
}
