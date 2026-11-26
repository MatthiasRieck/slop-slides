import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emit } from "../test/tauri";
import { installBrowserMock } from "./browserMock";
import type { ProviderInfo } from "./models";
import { defaultSettings, SETTINGS_CHANGED } from "./settings";

/** Asks the mocked backend, as `invoke` does in the browser preview. */
const ask = <T>(command: string, args?: Record<string, unknown>) =>
  (
    window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: Record<string, unknown>) => Promise<T> } }
  ).__TAURI_INTERNALS__.invoke(command, args);

beforeEach(installBrowserMock);
afterEach(() => {
  clearMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the browser preview's settings", () => {
  it("start on the defaults and keep a change while the page is open, telling the window", async () => {
    expect(await ask("get_settings")).toEqual(defaultSettings());
    const changed = await ask("update_settings", {
      patch: { appearance: "dark", providers: { codex: { enabled: false } } },
    });
    expect(changed).toEqual({
      appearance: "dark",
      rewind: "ask",
      providers: { claude: { enabled: true }, codex: { enabled: false }, copilot: { enabled: true } },
      libraryFolder: null,
    });
    expect(await ask("get_settings")).toEqual(changed);
    expect(emit).toHaveBeenCalledWith(SETTINGS_CHANGED, changed);
  });

  it("name the folder for new decks, which the library then is", async () => {
    await ask("update_settings", { patch: { libraryFolder: "/Volumes/work/decks" } });
    expect(await ask("library_folder", { create: false })).toBe("/Volumes/work/decks");
    expect(emit).toHaveBeenCalledWith(
      SETTINGS_CHANGED,
      expect.objectContaining({ libraryFolder: "/Volumes/work/decks" }),
    );
  });

  it("refuse to turn the last provider off, as the app does", async () => {
    const off = { enabled: false };
    await expect(
      ask("update_settings", { patch: { providers: { claude: off, codex: off, copilot: off } } }),
    ).rejects.toThrow("At least one provider has to stay on.");
    expect(await ask("get_settings")).toEqual(defaultSettings());
  });

  it("have no provider busy, and an environment that is fine", async () => {
    expect(await ask("busy_providers")).toEqual([]);
    expect(await ask("check_environment")).toEqual([
      { id: "git", ok: true, detail: expect.any(String) },
      { id: "mcpConfig", ok: true, detail: "No ~/.slopslides/mcp.json; nothing to load." },
    ]);
  });

  it("say each provider's version and whether it is signed in", async () => {
    const providers = await ask<ProviderInfo[]>("list_providers");
    expect(providers.map((p) => [p.id, p.version === null, p.auth])).toEqual([
      ["claude", false, "signedIn"],
      ["codex", true, "unknown"],
      ["copilot", false, "signedIn"],
    ]);
  });
});
