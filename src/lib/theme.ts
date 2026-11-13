// The app's appearance: light, dark, or whatever the system shows. The choice is remembered in
// storage, which every window of the app shares, and shows as the `dark` class on the document.
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
 * Shows the app in the chosen appearance and keeps it so: when the system's changes (which
 * `system` follows) and when another window of the app changes the choice. Returns what stops it.
 */
export function followAppearance(): () => void {
  const media = systemDark();
  const apply = () => applyAppearance();
  const onStorage = (event: StorageEvent) => {
    if (event.key === APPEARANCE_KEY || event.key === null) apply();
  };
  apply();
  media.addEventListener("change", apply);
  window.addEventListener("storage", onStorage);
  return () => {
    media.removeEventListener("change", apply);
    window.removeEventListener("storage", onStorage);
  };
}
