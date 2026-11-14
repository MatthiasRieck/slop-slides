// The app's appearance: light, dark, or whatever the system shows, and how large its text is.
// The choices are remembered in storage, which every window of the app shares; the appearance
// shows as the `dark` class on the document, the text size as the document's font size, which
// everything sized in rem follows. index.html applies both before the app's code loads.
import { loadText, saveText } from "./storage";

/** The appearances to choose from, in the order the settings offer them. */
export const APPEARANCES = ["system", "light", "dark"] as const;
export type Appearance = (typeof APPEARANCES)[number];

export const APPEARANCE_KEY = "slopslide.appearance";

const isAppearance = (value: unknown): value is Appearance => APPEARANCES.includes(value as Appearance);

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)");

/** The appearance the user chose; `system` until they choose one. */
export function loadAppearance(): Appearance {
  const saved = loadText(APPEARANCE_KEY);
  return isAppearance(saved) ? saved : "system";
}

/** The sizes of the interface's text to choose from, in the order the settings offer them. */
export const TEXT_SIZES = ["small", "default", "large"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

export const TEXT_SIZE_KEY = "slopslide.textSize";

/**
 * The document's font size for each choice, of the browser's own (16px unless the user changed
 * it): the interface's 12px text reads as 11, 12 or 13.5px. Empty for the default, which sets none.
 */
export const TEXT_SIZE_SCALE: Record<TextSize, string> = { small: "93.75%", default: "", large: "112.5%" };

const isTextSize = (value: unknown): value is TextSize => TEXT_SIZES.includes(value as TextSize);

/** The text size the user chose; `default` until they choose one. */
export function loadTextSize(): TextSize {
  const saved = loadText(TEXT_SIZE_KEY);
  return isTextSize(saved) ? saved : "default";
}

/** Shows the interface's text in `size`. */
export function applyTextSize(size: TextSize = loadTextSize()): void {
  document.documentElement.style.fontSize = TEXT_SIZE_SCALE[size];
}

/** Remembers `size` and shows the app's text in it right away; throws when storage is full or unavailable. */
export function setTextSize(size: TextSize): void {
  applyTextSize(size);
  saveText(TEXT_SIZE_KEY, size === "default" ? null : size);
}

/** Whether `appearance` shows dark, the system showing dark or not. */
export function showsDark(appearance: Appearance, systemIsDark: boolean): boolean {
  return appearance === "system" ? systemIsDark : appearance === "dark";
}

/** Shows the app in `appearance`. */
export function applyAppearance(appearance: Appearance = loadAppearance()): void {
  document.documentElement.classList.toggle("dark", showsDark(appearance, systemDark().matches));
}

/** Remembers `appearance` and shows the app in it right away; throws when storage is full or unavailable. */
export function setAppearance(appearance: Appearance): void {
  applyAppearance(appearance);
  saveText(APPEARANCE_KEY, appearance === "system" ? null : appearance);
}

/**
 * Shows the app in the chosen appearance and text size and keeps it so: when the system's
 * appearance changes (which `system` follows) and when another window of the app changes a
 * choice. Returns what stops it.
 */
export function followAppearance(): () => void {
  const media = systemDark();
  const apply = () => applyAppearance();
  const onStorage = (event: StorageEvent) => {
    if (event.key === APPEARANCE_KEY || event.key === null) apply();
    if (event.key === TEXT_SIZE_KEY || event.key === null) applyTextSize();
  };
  apply();
  applyTextSize();
  media.addEventListener("change", apply);
  window.addEventListener("storage", onStorage);
  return () => {
    media.removeEventListener("change", apply);
    window.removeEventListener("storage", onStorage);
  };
}
