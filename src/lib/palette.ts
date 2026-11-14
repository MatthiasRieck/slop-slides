/**
 * The colors that land in a deck: the swatches of the edit and sketch tools, and what they start
 * with. A deck has to look the same outside the app, so these are plain values and not the app's
 * own tokens (src/index.css).
 */
export const SWATCHES = {
  ink: "#111111",
  gray: "#6b7280",
  white: "#ffffff",
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#facc15",
  green: "#22c55e",
  teal: "#14b8a6",
  blue: "#3b82f6",
  violet: "#8b5cf6",
  pink: "#ec4899",
} as const;

/** What a color the user picked is called, for those of the swatches: "Blue". Null for any other color. */
export function swatchName(hex: string | null): string | null {
  const name = Object.entries(SWATCHES).find(([, value]) => value === hex?.toLowerCase())?.[0];
  return name ? name[0]!.toUpperCase() + name.slice(1) : null;
}

/** A color as a tooltip names it: "Blue (#3b82f6)" for a swatch, just the hex value otherwise. */
export function colorLabel(hex: string): string {
  const name = swatchName(hex);
  return name ? `${name} (${hex})` : hex;
}

/**
 * The #rrggbb color a typed hex value means: with or without the `#`, three digits or six, in
 * any case. Null when it is not one.
 */
export function parseHexInput(text: string): string | null {
  const digits = text.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(digits)) return `#${digits}`;
  if (/^[0-9a-f]{3}$/.test(digits)) return `#${[...digits].map((d) => d + d).join("")}`;
  return null;
}

/** How many colors the color wells remember as picked last. */
export const RECENT_COLORS = 6;

/** `recent` with `color` picked last: it goes first, once, and the oldest drop off the end. */
export function withRecentColor(recent: string[], color: string): string[] {
  return [color, ...recent.filter((c) => c !== color)].slice(0, RECENT_COLORS);
}

/** The `R G B` channels of a #rrggbb color, for `rgb(... / alpha)`. */
export function rgbChannels(hex: string): string {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(" ");
}
