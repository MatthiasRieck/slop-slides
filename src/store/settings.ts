import { api } from "../lib/api";
import { type AppSettings, injectedSettings, type SettingsPatch } from "../lib/settings";
import { applyAppearance } from "../lib/theme";
import { showErrorIn } from "./errors";
import { reconcileModels } from "./models";
import type { AppStore, Slice } from "./types";

/** The app's settings, for every deck and window: what ~/.slopslides/settings.json holds (see ../lib/settings.ts). */
export interface SettingsSlice {
  /** The settings as the backend has them: those it handed the window as it loaded, then each change. */
  settings: AppSettings;

  /**
   * Changes what `patch` names. The backend keeps the change and tells every window; what it
   * refuses (the last provider turned off, say) is shown as an error, the settings staying as
   * they were.
   */
  updateSettings: (patch: SettingsPatch) => Promise<void>;
}

export const createSettingsSlice: Slice<SettingsSlice> = (_set, _get, app) => ({
  settings: injectedSettings(),

  updateSettings: async (patch) => {
    try {
      adoptSettings(app, await api.updateSettings(patch));
    } catch (error) {
      showErrorIn(app, error);
    }
  },
});

/**
 * Takes `settings` as the app's, from the backend (after a change here or in another window):
 * shows the app in their appearance, and moves the model selection off a provider they turn off.
 */
export function adoptSettings(app: AppStore, settings: AppSettings) {
  app.setState({ settings });
  applyAppearance(settings.appearance);
  reconcileModels(app);
}
