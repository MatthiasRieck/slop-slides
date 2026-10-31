/** The width of a section shown as just its icon. */
export const COLLAPSED_SECTION_WIDTH = 40;

/** How far popups stay from the edge of the bar they open from. */
const POPUP_MARGIN = 4;

/**
 * How many sections collapse to fit `available` pixels, given each section's full width. They
 * collapse from the right, so the tools used most stay open longest. With no width to go by
 * (nothing is laid out), none do.
 */
export function sectionsToCollapse(widths: number[], available: number): number {
  if (available <= 0) return 0;
  let total = widths.reduce((sum, width) => sum + width, 0);
  let count = 0;
  while (total > available && count < widths.length) {
    count += 1;
    total += COLLAPSED_SECTION_WIDTH - (widths[widths.length - count] ?? 0);
  }
  return count;
}

/** How far to move a popup sideways so it stays within the bounds; a popup too wide for them keeps its left edge in. */
export function popupShift(left: number, right: number, boundsLeft: number, boundsRight: number): number {
  const shift = Math.min(0, boundsRight - POPUP_MARGIN - right);
  return Math.max(shift, boundsLeft + POPUP_MARGIN - left);
}
