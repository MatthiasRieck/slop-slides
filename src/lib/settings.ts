// The app's settings, for every deck and every window: what ~/.slopslides/settings.json holds. The
// backend owns the file; it hands each window the settings before the page loads (see
// `INJECTED`), takes changes through `api.updateSettings`, and tells every window of each one.
import { PROVIDER_IDS, type Provider } from "./models";

/** The appearances to choose from, in the order the settings offer them. */
export const APPEARANCES = ["system", "light", "dark"] as const;
export type Appearance = (typeof APPEARANCES)[number];

/** What undoing an agent turn's deck changes does to the chat, in the order the settings offer it. */
export const REWIND_SETTINGS = ["ask", "rewind", "deck"] as const;
/** Ask each time, also rewind the chat, or only undo the deck changes. */
export type RewindSetting = (typeof REWIND_SETTINGS)[number];

export interface AppSettings {
  appearance: Appearance;
  rewind: RewindSetting;
  /** Which agents the app offers; at least one is on. */
  providers: Record<Provider, { enabled: boolean }>;
}

/** A change to the settings: only what it names changes. */
export interface SettingsPatch {
  appearance?: Appearance;
  rewind?: RewindSetting;
  providers?: Partial<Record<Provider, { enabled: boolean }>>;
}

/** One thing the agents need from the computer, and whether it is there (see `api.checkEnvironment`). */
export interface EnvironmentCheck {
  id: "git" | "mcpConfig";
  ok: boolean;
  /** Where it was found, or what is wrong with it. */
  detail: string;
}

/** The event the backend sends every window after a change to the settings; its payload is the new `AppSettings`. */
export const SETTINGS_CHANGED = "settings-changed";

/** The global the backend sets before the page loads: `{ settings, notice }`. */
const INJECTED = "__SLOPSLIDE_SETTINGS__";

/** The settings of a first start. */
export function defaultSettings(): AppSettings {
  return {
    appearance: "system",
    rewind: "ask",
    providers: { claude: { enabled: true }, codex: { enabled: true }, copilot: { enabled: true } },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * `value` as settings: what is missing or not known takes its default, and with no provider on,
 * all of them are.
 */
export function readSettings(value: unknown): AppSettings {
  const settings = defaultSettings();
  if (!isRecord(value)) return settings;
  if (APPEARANCES.includes(value.appearance as Appearance)) settings.appearance = value.appearance as Appearance;
  if (REWIND_SETTINGS.includes(value.rewind as RewindSetting)) settings.rewind = value.rewind as RewindSetting;
  const providers = isRecord(value.providers) ? value.providers : {};
  for (const id of PROVIDER_IDS) {
    const saved = providers[id];
    if (isRecord(saved) && typeof saved.enabled === "boolean") settings.providers[id] = { enabled: saved.enabled };
  }
  if (!PROVIDER_IDS.some((id) => settings.providers[id].enabled)) settings.providers = defaultSettings().providers;
  return settings;
}

/** `settings` with what `patch` names changed. */
export function patchSettings(settings: AppSettings, patch: SettingsPatch): AppSettings {
  return {
    appearance: patch.appearance ?? settings.appearance,
    rewind: patch.rewind ?? settings.rewind,
    providers: { ...settings.providers, ...patch.providers },
  };
}

/** What the backend handed this window before the page loaded; undefined without it (the browser preview, tests). */
function injected(): Record<string, unknown> | undefined {
  const value = (globalThis as Record<string, unknown>)[INJECTED];
  return isRecord(value) ? value : undefined;
}

/** The settings this window starts with: the backend's, or the defaults where it handed none over. */
export function injectedSettings(): AppSettings {
  return readSettings(injected()?.settings);
}

/**
 * What the backend has to say about the settings file (it could not be read and was moved aside),
 * taken so that it is said once; null when there is nothing to say.
 */
export function takeInjectedNotice(): string | null {
  const handed = injected();
  const notice = handed?.notice;
  if (typeof notice !== "string" || !notice) return null;
  handed.notice = null;
  return notice;
}
