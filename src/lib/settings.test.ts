import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultSettings, injectedSettings, patchSettings, readSettings, takeInjectedNotice } from "./settings";

afterEach(() => vi.unstubAllGlobals());

describe("readSettings", () => {
  it("keeps what is known and takes the default for the rest", () => {
    expect(readSettings(undefined)).toEqual(defaultSettings());
    expect(readSettings("dark")).toEqual(defaultSettings());
    expect(readSettings({ appearance: "light", more: 1 })).toEqual({ ...defaultSettings(), appearance: "light" });
    expect(
      readSettings({ rewind: "always", providers: { copilot: { enabled: false }, other: { enabled: false } } }),
    ).toEqual({
      ...defaultSettings(),
      providers: { claude: { enabled: true }, codex: { enabled: true }, copilot: { enabled: false } },
    });
  });

  it("turns every provider on when none is", () => {
    const off = { enabled: false };
    expect(readSettings({ providers: { claude: off, codex: off, copilot: off } }).providers).toEqual(
      defaultSettings().providers,
    );
  });
});

describe("patchSettings", () => {
  it("changes only what the patch names", () => {
    const settings = defaultSettings();
    expect(patchSettings(settings, {})).toEqual(settings);
    expect(patchSettings(settings, { rewind: "deck", providers: { codex: { enabled: false } } })).toEqual({
      appearance: "system",
      rewind: "deck",
      providers: { claude: { enabled: true }, codex: { enabled: false }, copilot: { enabled: true } },
    });
    // The settings patched are left as they were.
    expect(settings).toEqual(defaultSettings());
  });
});

describe("what the backend hands the window", () => {
  it("is read as it stands, each time", () => {
    expect(injectedSettings()).toEqual(defaultSettings());
    vi.stubGlobal("__SLOPSLIDE_SETTINGS__", { settings: { appearance: "dark" }, notice: null });
    expect(injectedSettings().appearance).toBe("dark");
    vi.stubGlobal("__SLOPSLIDE_SETTINGS__", "nonsense");
    expect(injectedSettings()).toEqual(defaultSettings());
  });

  it("has its notice taken once", () => {
    expect(takeInjectedNotice()).toBeNull();
    vi.stubGlobal("__SLOPSLIDE_SETTINGS__", { settings: defaultSettings(), notice: "The settings were reset." });
    expect(takeInjectedNotice()).toBe("The settings were reset.");
    expect(takeInjectedNotice()).toBeNull();
    vi.stubGlobal("__SLOPSLIDE_SETTINGS__", { settings: defaultSettings(), notice: null });
    expect(takeInjectedNotice()).toBeNull();
  });
});
