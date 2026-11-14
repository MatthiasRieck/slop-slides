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

/** A hex color to show as an example of what the hex field takes. */
export const HEX_EXAMPLE = "#1a2b3c";

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

/** The recent colors as they were stored: what of it is a list of #rrggbb colors, the latest first. */
export function parseRecentColors(saved: unknown): string[] {
  if (!Array.isArray(saved)) return [];
  return saved.filter((c): c is string => typeof c === "string" && /^#[0-9a-f]{6}$/.test(c)).slice(0, RECENT_COLORS);
}

/** `hex` mixed with white (`amount` above 0) or black (below), by that share: a tint or a shade of it. */
export function mixColor(hex: string, amount: number): string {
  const toward = amount > 0 ? 255 : 0;
  const share = Math.min(1, Math.abs(amount));
  return `#${[1, 3, 5]
    .map((start) => {
      const channel = Number.parseInt(hex.slice(start, start + 2), 16);
      return Math.round(channel + (toward - channel) * share)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

/** The tints and shades the color wells offer of each deck color, row by row: lighter, then darker. */
export const DECK_COLOR_MIXES = [0.6, -0.35] as const;

/** The `R G B` channels of a #rrggbb color, for `rgb(... / alpha)`. */
export function rgbChannels(hex: string): string {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(" ");
}
