// What the top bar shows at the width it has. The bar gives room up in a set order, so that
// nothing in it ever lies over something else: first the words that only say what an icon
// already does, last the deck's title, which shortens to "…".

/** What the top bar has room for. */
export interface TopBarRoom {
  /** The word "Export" beside its icon, and the word that the deck is saved. */
  labels: boolean;
  /** The path over the deck's title, and the settings and shortcut buttons beside the sidebar's toggle. */
  extras: boolean;
  /** The names under the mode tabs' icons. */
  tabLabels: boolean;
  /** The word "Present" on its button. */
  presentLabel: boolean;
}

/** Below these widths of the bar (in CSS pixels), what each names goes. */
export const TOP_BAR_WIDTHS = { labels: 900, extras: 760, tabLabels: 680, presentLabel: 600 };

/**
 * What a top bar `width` pixels wide has room for; everything until it is measured, as at the
 * widths the window opens at.
 */
export function topBarRoom(width: number | null): TopBarRoom {
  const fits = (least: number) => width === null || width >= least;
  return {
    labels: fits(TOP_BAR_WIDTHS.labels),
    extras: fits(TOP_BAR_WIDTHS.extras),
    tabLabels: fits(TOP_BAR_WIDTHS.tabLabels),
    presentLabel: fits(TOP_BAR_WIDTHS.presentLabel),
  };
}
