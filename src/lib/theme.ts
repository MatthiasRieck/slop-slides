// The app's appearance: light, dark, or whatever the system shows. The choice is one of the app's
// settings (see ./settings.ts), which every window of the app shares, and shows as the `dark`
// class on the document.
import { listen } from "@tauri-apps/api/event";

import { type Appearance, injectedSettings, readSettings, SETTINGS_CHANGED } from "./settings";

export { APPEARANCES, type Appearance } from "./settings";

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)");

/** The appearance shown since this window loaded; until one is, the one the window started with. */
let chosen: Appearance | null = null;

/** The appearance the window shows: the one the settings had as it loaded, or the one shown since. */
export function shownAppearance(): Appearance {
  return chosen ?? injectedSettings().appearance;
}

/** Whether `appearance` shows dark, the system showing dark or not. */
export function showsDark(appearance: Appearance, systemIsDark: boolean): boolean {
  return appearance === "system" ? systemIsDark : appearance === "dark";
}

/** Shows the app in `appearance`, from now on (see `followAppearance`). */
export function applyAppearance(appearance: Appearance = shownAppearance()): void {
  chosen = appearance;
  document.documentElement.classList.toggle("dark", showsDark(appearance, systemDark().matches));
}

/**
 * Shows the app in the chosen appearance and keeps it so: when the system's changes (which
 * `system` follows) and when the settings change, in this window or another. Returns what stops it.
 */
export function followAppearance(): () => void {
  const media = systemDark();
  const apply = () => applyAppearance();
  let stopped = false;
  apply();
  media.addEventListener("change", apply);
  // Without a backend to listen to (the browser preview), only the system is followed.
  const unlisten = Promise.resolve()
    .then(() =>
      listen<unknown>(SETTINGS_CHANGED, ({ payload }) => {
        if (!stopped) applyAppearance(readSettings(payload).appearance);
      }),
    )
    .catch(() => undefined);
  return () => {
    stopped = true;
    media.removeEventListener("change", apply);
    void unlisten.then((off) => off?.());
  };
}
