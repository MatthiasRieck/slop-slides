import { type KeyboardEvent, type RefCallback, useCallback } from "react";

import { restoreFocus, usingKeyboard } from "../lib/focus";

/** The choices of a menu that can be picked just now, in order. */
export function menuItems(menu: Element): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>("[role^=menuitem]")).filter(
    (item) => !item.matches(":disabled, [aria-disabled=true]"),
  );
}

/**
 * Moves the focus into a menu that just opened: to its first choice when it was opened with the
 * keyboard, else to the menu itself, so the arrow keys work in it without a choice looking picked.
 */
export function enterMenu(menu: HTMLElement): void {
  (usingKeyboard() ? (menuItems(menu)[0] ?? menu) : menu).focus();
}

/** ↓ and ↑ go through the menu's choices and round again, Home and End to its ends. True when the key was one of them. */
export function moveInMenu(menu: HTMLElement, key: string): boolean {
  const items = menuItems(menu);
  const at = items.indexOf(document.activeElement as HTMLElement);
  const to =
    key === "ArrowDown"
      ? (at + 1) % items.length
      : key === "ArrowUp"
        ? (at <= 0 ? items.length : at) - 1
        : key === "Home"
          ? 0
          : key === "End"
            ? items.length - 1
            : null;
  if (to === null) return false;
  items[to]?.focus();
  return true;
}

/**
 * The keyboard's part of a `role="menu"` panel; spread what it returns on the menu element:
 *
 *     const menu = useMenuKeys();
 *     {open && <div role="menu" {...menu}>…<button role="menuitem">…</div>}
 *
 * As the menu shows, the focus moves into it (see {@link enterMenu}); ↓ ↑ Home and End move
 * between its `role="menuitem…"` choices; and when it goes away with the focus still in it, the
 * focus returns to what had it before, the button that opened it. Closing it, on Escape or a
 * press outside, is `useDropdown`'s or `Popover`'s part. Inside a `Popover` the focus moves in
 * once the popover is placed, which the popover sees to.
 */
export function useMenuKeys<E extends HTMLElement = HTMLDivElement>() {
  const ref: RefCallback<E> = useCallback((menu) => {
    if (!menu) return;
    const before = document.activeElement;
    // A popover is hidden until it is placed, and focuses its menu then.
    if (!menu.closest("[data-popover]")) enterMenu(menu);
    return () => restoreFocus(menu, before);
  }, []);
  const onKeyDown = useCallback((event: KeyboardEvent<E>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (moveInMenu(event.currentTarget, event.key)) {
      event.preventDefault();
      // The arrows are the menu's, not the slides'.
      event.stopPropagation();
    }
  }, []);
  return { ref, tabIndex: -1, onKeyDown } as const;
}
