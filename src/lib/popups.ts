// What the app's popups (the shadcn/ui ones) need beside the components themselves.
import type { RefObject } from "react";

/**
 * What a panel anchored to a button that is not its trigger does when it is asked to close. A
 * press on that button is left to the button, which closes the panel itself (or keeps it): taken
 * as a press outside as well, it would close the panel and the button open it again.
 */
export function closeBesideAnchor(anchor: RefObject<HTMLElement | null>, close: () => void) {
  return (open: boolean, details: { reason: string; event: Event }) => {
    if (open) return;
    const target = details.event?.target;
    if (details.reason === "outside-press" && target instanceof Node && anchor.current?.contains(target)) return;
    close();
  };
}
