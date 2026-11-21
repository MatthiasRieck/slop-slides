import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AppSettings, defaultSettings, SETTINGS_CHANGED } from "../lib/settings";
import { lastError } from "./errors";
import { backend, calls, freshModule, freshStore, listeners, resetBackend, settingsBackend } from "./testing";

beforeEach(() => {
  resetBackend();
  document.documentElement.classList.remove("dark");
});
afterEach(() => vi.unstubAllGlobals());

const dark = () => document.documentElement.classList.contains("dark");
/** What the backend hands a window before its page loads. */
const hand = (settings: unknown, notice: string | null = null) =>
  vi.stubGlobal("__SLOPSLIDE_SETTINGS__", { settings, notice });

describe("the app's settings", () => {
  it("start as the backend handed them to the window", async () => {
    const handed: AppSettings = {
      appearance: "dark",
      rewind: "deck",
      providers: { claude: { enabled: true }, codex: { enabled: false }, copilot: { enabled: true } },
    };
    hand(handed);
    expect((await freshStore()).getState().settings).toEqual(handed);
  });

  it("are the defaults where nothing was handed over, as in the browser preview", async () => {
    expect((await freshStore()).getState().settings).toEqual(defaultSettings());
    expect(defaultSettings()).toEqual({
      appearance: "system",
      rewind: "ask",
      providers: { claude: { enabled: true }, codex: { enabled: true }, copilot: { enabled: true } },
    });
  });

  it("take the default for what the handed settings lack or get wrong", async () => {
    hand({ appearance: "sepia", rewind: "deck", providers: { codex: { enabled: false }, claude: { enabled: "no" } } });
    expect((await freshStore()).getState().settings).toEqual({
      ...defaultSettings(),
      rewind: "deck",
      providers: { claude: { enabled: true }, codex: { enabled: false }, copilot: { enabled: true } },
    });
  });

  it("are not read from the storage that held the appearance and the rewind answer before", async () => {
    localStorage.setItem("slopslide.appearance", "dark");
    localStorage.setItem("slopslide.rewindChoice", "deck");
    expect((await freshStore()).getState().settings).toEqual(defaultSettings());
  });
});

describe("updateSettings", () => {
  it("has the backend keep the change, takes what it answers, and shows the app in the new appearance", async () => {
    const useApp = await freshStore();
    backend(settingsBackend());
    await useApp.getState().updateSettings({ appearance: "dark" });
    expect(calls("update_settings")).toEqual([{ patch: { appearance: "dark" } }]);
    expect(useApp.getState().settings).toEqual({ ...defaultSettings(), appearance: "dark" });
    expect(dark()).toBe(true);
    await useApp.getState().updateSettings({ providers: { codex: { enabled: false } } });
    expect(useApp.getState().settings).toMatchObject({
      appearance: "dark",
      providers: { claude: { enabled: true }, codex: { enabled: false }, copilot: { enabled: true } },
    });
    // Nothing of it is kept in the window's storage.
    expect(localStorage.getItem("slopslide.appearance")).toBeNull();
  });

  it("shows what the backend refuses, as it says it, and leaves the settings as they were", async () => {
    const useApp = await freshStore();
    backend({
      update_settings: () => {
        throw "At least one provider has to stay on.";
      },
    });
    const before = useApp.getState().settings;
    await useApp.getState().updateSettings({ appearance: "dark", providers: { claude: { enabled: false } } });
    expect(useApp.getState().settings).toBe(before);
    expect(lastError(useApp.getState())).toBe("At least one provider has to stay on.");
    expect(dark()).toBe(false);
  });
});

describe("a change to the settings made in any window", () => {
  it("replaces the settings and shows the app in their appearance", async () => {
    const module = await freshModule();
    backend({ list_providers: () => [] });
    await module.initEventBridge();
    const changed: AppSettings = { ...defaultSettings(), appearance: "dark", rewind: "rewind" };
    listeners.get(SETTINGS_CHANGED)!({ payload: changed });
    expect(module.useApp.getState().settings).toEqual(changed);
    expect(dark()).toBe(true);
    listeners.get(SETTINGS_CHANGED)!({ payload: defaultSettings() });
    expect(module.useApp.getState().settings).toEqual(defaultSettings());
    expect(dark()).toBe(false);
  });
});

describe("a settings file that could not be read", () => {
  const NOTICE = "settings.json could not be read; it was moved to settings.broken.json and defaults are used";

  it("is said once as the window starts, in a message that stays", async () => {
    hand(defaultSettings(), NOTICE);
    const module = await freshModule();
    backend({ list_providers: () => [] });
    await module.initEventBridge();
    expect(module.useApp.getState().toasts).toMatchObject([{ kind: "error", text: NOTICE }]);
    // Taken: nothing that starts later in the window says it again.
    const again = await freshModule();
    await again.initEventBridge();
    expect(again.useApp.getState().toasts).toEqual([]);
  });

  it("says nothing when the file was fine", async () => {
    hand(defaultSettings());
    const module = await freshModule();
    backend({ list_providers: () => [] });
    await module.initEventBridge();
    expect(module.useApp.getState().toasts).toEqual([]);
  });
});
