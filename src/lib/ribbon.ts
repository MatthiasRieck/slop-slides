/** The least width of a section shown as just its icon and caption. */
export const COLLAPSED_SECTION_WIDTH = 40;

/** How much narrower than its open self a collapsed section has to be for collapsing it to be worth it. */
const WORTH_COLLAPSING = 8;

/** How far popups stay from the edge of the bar they open from. */
const POPUP_MARGIN = 4;

/**
 * The width of a collapsed section captioned `title`: room for its icon, and for the caption in
 * the ribbon's 10px type. The section is given exactly this width, so what is fit and what
 * shows agree without measuring anything that is not laid out yet.
 */
export function collapsedWidth(title: string): number {
  return Math.max(COLLAPSED_SECTION_WIDTH, Math.ceil(title.length * 4.8) + 12);
}

/**
 * Which sections collapse to fit `available` pixels, as one flag per section. `widths` are the
 * sections' full widths and `collapsed` what each takes once collapsed (`COLLAPSED_SECTION_WIDTH`
 * without it). They collapse in the order of `order` (indexes into `widths`, the first to go
 * first; without it from the right, so the tools used most stay open longest), and a section
 * that would not get narrower by collapsing never does: its tools would only be a click further
 * away. With no width to go by (nothing is laid out), none do.
 */
export function collapsedSections(
  widths: readonly number[],
  available: number,
  options: { order?: readonly number[]; collapsed?: readonly number[] } = {},
): boolean[] {
  const flags = widths.map(() => false);
  if (available <= 0) return flags;
  const order = options.order ?? widths.map((_, i) => widths.length - 1 - i);
  let total = widths.reduce((sum, width) => sum + width, 0);
  for (const index of order) {
    if (total <= available) break;
    const open = widths[index];
    const shut = options.collapsed?.[index] ?? COLLAPSED_SECTION_WIDTH;
    if (open === undefined || open <= shut + WORTH_COLLAPSING) continue;
    flags[index] = true;
    total += shut - open;
  }
  return flags;
}

/**
 * The order the edit ribbon's sections collapse in, as indexes into `sections` (their names, in
 * the ribbon's order). The timeline's toggle goes first either way. With something selected the
 * tools that add to the slide go next and what formats the selection stays open longest, the
 * arrange tools last; with nothing selected the formatting goes and the insert tools stay. So
 * the ribbon changes its layout when a selection comes or goes, never between selections.
 */
export function editRibbonOrder(sections: readonly string[], hasSelection: boolean): number[] {
  const first = hasSelection
    ? ["Timeline", "Insert", "Paragraph", "Style", "Text", "Arrange"]
    : ["Timeline", "Paragraph", "Arrange", "Style", "Text", "Insert"];
  const named = first.map((name) => sections.indexOf(name)).filter((index) => index >= 0);
  // Any other section (the slide's, the canvas's: narrow ones) goes last, from the right.
  const rest = sections.map((_, i) => sections.length - 1 - i).filter((index) => !named.includes(index));
  return [...named, ...rest];
}

/** How far to move a popup sideways so it stays within the bounds; a popup too wide for them keeps its left edge in. */
export function popupShift(left: number, right: number, boundsLeft: number, boundsRight: number): number {
  const shift = Math.min(0, boundsRight - POPUP_MARGIN - right);
  return Math.max(shift, boundsLeft + POPUP_MARGIN - left);
}
