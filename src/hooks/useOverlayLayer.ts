import { useEffect, useLayoutEffect } from "react";

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

/** The boxes of the modal surfaces (dialog, alert dialog, sheet), which hold the app under them back. */
const MODAL = "[data-slot=dialog-content], [data-slot=alert-dialog-content], [data-slot=sheet-content]";

/** Whether a key pressed on `target` was pressed with the focus lost to the app under a modal. */
function isStray(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(MODAL)) return false;
  // What else is rendered into the body (a popover, a menu, the toasts) keeps its keys.
  if (target === document.body || target === document.documentElement) return true;
  return document.getElementById("root")?.contains(target) ?? false;
}

/**
 * Keeps the keys from the app while a modal surface is open, also when the focus is no longer in
 * it: a press on the scrim of a dialog that stays open leaves the focus on the body, and Base UI
 * does not bring it back, so the arrows, ⌘Z and Delete would go to the slides behind. Such a key
 * is the dialog's: nothing else sees it, and the focus returns to the box on top. Escape goes on,
 * to close what is on top. The modal surfaces render it inside their popup; popovers and menus
 * do not, as the app under them stays in reach.
 */
export function ModalKeys() {
  useEffect(() => {
    const onStray = (event: KeyboardEvent) => {
      if (event.key === "Escape" || !isStray(event.target)) return;
      event.stopPropagation();
      // Tab would otherwise walk on from wherever the focus was lost.
      if (event.key === "Tab") event.preventDefault();
      Array.from(document.querySelectorAll<HTMLElement>(MODAL)).at(-1)?.focus();
    };
    document.addEventListener("keydown", onStray, true);
    return () => document.removeEventListener("keydown", onStray, true);
  }, []);
  return null;
}
