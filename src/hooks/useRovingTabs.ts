import { type KeyboardEvent, useCallback, useLayoutEffect, useRef } from "react";

const tabsOf = (list: Element) =>
  Array.from(list.querySelectorAll<HTMLElement>("[role=tab]")).filter((tab) => !tab.matches(":disabled"));

/**
 * The keyboard's part of a `role="tablist"`; spread what it returns on the tab list element:
 *
 *     const tabs = useRovingTabs();
 *     <div role="tablist" {...tabs}>…<button role="tab" aria-selected={…}>…</div>
 *
 * Tab stops at one tab only, the selected one (the first when none is), and the arrow keys move
 * the focus between the tabs and round again, Home and End to the ends; Enter or Space then picks
 * the focused tab, as a click does. `vertical` lists take ↑ and ↓ instead of ← and →.
 */
export function useRovingTabs<E extends HTMLElement = HTMLDivElement>(
  orientation: "horizontal" | "vertical" = "horizontal",
) {
  const ref = useRef<E>(null);

  // After every render, as the tabs and the selected one are the caller's to change.
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const tabs = tabsOf(list);
    const stop = tabs.find((tab) => tab.getAttribute("aria-selected") === "true") ?? tabs[0];
    for (const tab of tabs) tab.tabIndex = tab === stop ? 0 : -1;
  });

  const onKeyDown = useCallback(
    (event: KeyboardEvent<E>) => {
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const tabs = tabsOf(event.currentTarget);
      const at = tabs.indexOf(event.target as HTMLElement);
      if (at < 0) return;
      const [back, on] = orientation === "vertical" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
      const to =
        event.key === on
          ? (at + 1) % tabs.length
          : event.key === back
            ? (at || tabs.length) - 1
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : null;
      if (to === null) return;
      event.preventDefault();
      // The arrows are the tabs', not the slides'.
      event.stopPropagation();
      tabs[to]?.focus();
    },
    [orientation],
  );

  return { ref, onKeyDown } as const;
}
