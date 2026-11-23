// The parts of the app that are dark in either theme, and what opens from them.
import { createContext, type ReactNode, useContext } from "react";

const Dark = createContext(false);

/**
 * Marks what it holds as part of a subtree that is dark in either theme (the show, the presenter
 * view, the slide image export), whose root carries the `dark` class. What opens from in there
 * (a tooltip, a popover, a menu, a dialog) is put in the page's body, outside that subtree, and
 * so would follow the app's theme: the shadcn/ui popups ask `useScopeClass` and take the class
 * themselves. It renders no element of its own.
 */
export function DarkScope({ children }: { children: ReactNode }) {
  return <Dark value={true}>{children}</Dark>;
}

/** The class a popup takes to look like where it was opened from: `dark` inside a `DarkScope`. */
export function useScopeClass(): "dark" | undefined {
  return useContext(Dark) ? "dark" : undefined;
}
