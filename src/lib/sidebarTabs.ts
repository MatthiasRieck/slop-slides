/** How the sidebar's tabs fit the room they have (components/Sidebar.tsx). */

/** Which tabs show their name beside their icon: all of them, the one showing, or none. */
export type TabLabels = "all" | "active" | "none";

/**
 * Which tabs can show their name in `available` pixels, so that the row never overflows: all of
 * them when they fit, else only the one showing (the others keep their icon, and say their name
 * in a tooltip), else none. `full` is each tab's width with its name, `icon` a tab's width
 * without, `gap` the room between two tabs and `active` the index of the tab showing. Before the
 * row is laid out (no room measured yet) every name shows.
 */
export function tabLabels(
  full: readonly number[],
  icon: number,
  gap: number,
  active: number,
  available: number,
): TabLabels {
  if (available <= 0 || full.length === 0) return "all";
  const gaps = gap * (full.length - 1);
  const sum = (widths: readonly number[]) => widths.reduce((total, width) => total + width, 0) + gaps;
  if (sum(full) <= available) return "all";
  // A tab that is no wider with its name (it has none to hide) stays as it is.
  const narrow = full.map((width) => Math.min(width, icon));
  const withActive = narrow.map((width, index) => (index === active ? (full[index] ?? width) : width));
  return sum(withActive) <= available ? "active" : "none";
}
