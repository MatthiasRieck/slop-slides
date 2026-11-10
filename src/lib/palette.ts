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

/** What the editor's shadows are mixed from, until the deck's palette says otherwise. */
export const SHADOW = "#000000";

/** The `R G B` channels of a #rrggbb color, for `rgb(... / alpha)`. */
export function rgbChannels(hex: string): string {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(" ");
}

/**
 * Palettes the deck can take on all at once, by role: background, text, secondary text,
 * accent, panels, and a second accent. A deck's own color names find their role (see
 * `applyPreset`), and its other colors follow the nearest role's change.
 */
export const PALETTE_PRESETS: { id: string; label: string; colors: Record<string, string> }[] = [
  {
    id: "paper",
    label: "Paper & ink",
    colors: {
      bg: "#f4f1ea",
      ink: "#1c1b19",
      muted: "#6b675f",
      accent: "#d6461f",
      panel: "#e8e2d6",
      "accent-2": "#2f6f8f",
    },
  },
  {
    id: "swiss",
    label: "Swiss red",
    colors: {
      bg: "#f4f4f0",
      ink: "#111111",
      muted: "#3c3c3c",
      accent: "#e30613",
      panel: "#dcdcd6",
      "accent-2": "#111111",
    },
  },
  {
    id: "midnight",
    label: "Midnight",
    colors: {
      bg: "#0f1424",
      ink: "#eef1fa",
      muted: "#9aa3bd",
      accent: "#5b8cff",
      panel: "#1b2238",
      "accent-2": "#ffb547",
    },
  },
  {
    id: "forest",
    label: "Forest",
    colors: {
      bg: "#13201a",
      ink: "#ecf0e6",
      muted: "#a3b3a0",
      accent: "#d9a441",
      panel: "#1f3229",
      "accent-2": "#e8b4b8",
    },
  },
  {
    id: "ocean",
    label: "Ocean",
    colors: {
      bg: "#eef6f8",
      ink: "#0d2b36",
      muted: "#4f6d78",
      accent: "#0b8aa8",
      panel: "#d5eaef",
      "accent-2": "#f2784b",
    },
  },
  {
    id: "sunset",
    label: "Sunset",
    colors: {
      bg: "#fff4ec",
      ink: "#2b1520",
      muted: "#7a5866",
      accent: "#ff5e3a",
      panel: "#ffe1d1",
      "accent-2": "#8a3ffc",
    },
  },
  {
    id: "pastel",
    label: "Pastel",
    colors: {
      bg: "#faf9f7",
      ink: "#2e2a36",
      muted: "#6f6a7d",
      accent: "#9b8dc4",
      panel: "#f0e6f4",
      "accent-2": "#a8d4c4",
    },
  },
  {
    id: "neon",
    label: "Neon night",
    colors: {
      bg: "#0d0221",
      ink: "#fdf4ff",
      muted: "#d7b8f3",
      accent: "#ff2a6d",
      panel: "#261447",
      "accent-2": "#05d9e8",
    },
  },
  {
    id: "mono",
    label: "Monochrome",
    colors: {
      bg: "#ffffff",
      ink: "#111111",
      muted: "#666666",
      accent: "#111111",
      panel: "#eeeeee",
      "accent-2": "#888888",
    },
  },
];
