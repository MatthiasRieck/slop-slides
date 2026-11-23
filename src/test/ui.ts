// How tests work the shadcn/ui components (Base UI), which take more than a click here and there.
import { act, fireEvent } from "@testing-library/react";

/**
 * What the tooltip of `element` says, shortcut included ("Group⌘G"); null when it has none. The
 * tooltip opens at once when its trigger takes the focus, so nothing waits for the pointer's delay.
 */
export function tooltipOf(element: Element): string | null {
  const shown = () => Array.from(document.querySelectorAll("[data-slot=tooltip-content]"));
  const before = shown();
  fireEvent.focus(element);
  const tooltip = shown().find((tip) => !before.includes(tip)) ?? null;
  const text = tooltip?.textContent ?? null;
  // Put away again at once, so the next thing looked for is not found in a tooltip.
  fireEvent.blur(element);
  fireEvent.mouseLeave(element);
  return text;
}

/**
 * Picks an option of an open `Select` (or a `Combobox`): a click alone is not enough, as the list
 * only takes a click that follows a press on the option.
 */
export function pickOption(option: Element): void {
  fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
  fireEvent.click(option);
}

/**
 * Lets what a popup does a moment later happen: it moves the focus in a frame or two after it
 * opens, and back after it closes. (Opening and closing themselves show at once.)
 */
export async function settle(ms = 40): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
