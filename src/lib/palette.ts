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

/** The `R G B` channels of a #rrggbb color, for `rgb(... / alpha)`. */
export function rgbChannels(hex: string): string {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(" ");
}
