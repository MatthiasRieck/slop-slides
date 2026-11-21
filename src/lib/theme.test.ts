import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listen } from "../test/tauri";
import { type Appearance, defaultSettings, SETTINGS_CHANGED } from "./settings";
import { showsDark } from "./theme";

/** The system's appearance, as `matchMedia` reports it, and what listens for it changing. */
let systemIsDark = false;
const listeners = new Set<() => void>();
const dark = () => document.documentElement.classList.contains("dark");
/** Changes what the system shows, telling whoever listens. */
function setSystem(isDark: boolean) {
  systemIsDark = isDark;
  for (const listener of [...listeners]) listener();
}

beforeEach(() => {
  systemIsDark = false;
  listeners.clear();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        get matches() {
          return systemIsDark;
        },
        media: query,
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      }) as never,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  listen.mockReset().mockImplementation(async () => () => {});
});

/** The module as a window loads it, the backend having handed it `appearance` (or, without one, nothing). */
async function theme(appearance?: Appearance) {
  if (appearance)
    vi.stubGlobal("__SLOPSLIDE_SETTINGS__", { settings: { ...defaultSettings(), appearance }, notice: null });
  vi.resetModules();
  return import("./theme");
}

/** Lets what waits on a settled promise go on. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe("the appearance", () => {
  it("is the one the backend handed the window, and the system's without it", async () => {
    expect((await theme()).shownAppearance()).toBe("system");
    expect((await theme("dark")).shownAppearance()).toBe("dark");
    vi.stubGlobal("__SLOPSLIDE_SETTINGS__", { settings: { appearance: "sepia" }, notice: null });
    vi.resetModules();
    expect((await import("./theme")).shownAppearance()).toBe("system");
  });

  it("is not read from storage any more", async () => {
    localStorage.setItem("slopslide.appearance", "dark");
    const { applyAppearance, shownAppearance } = await theme();
    expect(shownAppearance()).toBe("system");
    applyAppearance("light");
    expect(localStorage.getItem("slopslide.appearance")).toBe("dark");
  });

  it("shows dark when chosen, or when the system does and it is followed", () => {
    expect(showsDark("dark", false)).toBe(true);
    expect(showsDark("light", true)).toBe(false);
    expect(showsDark("system", true)).toBe(true);
    expect(showsDark("system", false)).toBe(false);
  });

  it("is applied as the dark class on the document, and stays the one shown", async () => {
    const { applyAppearance, shownAppearance } = await theme();
    applyAppearance("dark");
    expect(dark()).toBe(true);
    expect(shownAppearance()).toBe("dark");
    applyAppearance("light");
    expect(dark()).toBe(false);
    systemIsDark = true;
    applyAppearance();
    expect(dark()).toBe(false);
    applyAppearance("system");
    expect(dark()).toBe(true);
  });
});

describe("followAppearance", () => {
  it("applies the choice as it starts", async () => {
    const stop = (await theme("dark")).followAppearance();
    expect(dark()).toBe(true);
    stop();
  });

  it("follows the system while that is the choice, and not while it is light or dark", async () => {
    const { applyAppearance, followAppearance } = await theme();
    const stop = followAppearance();
    expect(dark()).toBe(false);
    setSystem(true);
    expect(dark()).toBe(true);
    applyAppearance("light");
    expect(dark()).toBe(false);
    setSystem(false);
    setSystem(true);
    expect(dark()).toBe(false);
    applyAppearance("system");
    expect(dark()).toBe(true);
    stop();
  });

  it("follows a change to the settings, made in this window or another", async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    listen.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    });
    const stop = (await theme()).followAppearance();
    await settle();
    handlers.get(SETTINGS_CHANGED)!({ payload: { ...defaultSettings(), appearance: "dark" } });
    expect(dark()).toBe(true);
    // The system changing does not undo the choice.
    setSystem(false);
    expect(dark()).toBe(true);
    handlers.get(SETTINGS_CHANGED)!({ payload: defaultSettings() });
    expect(dark()).toBe(false);
    stop();
    await settle();
    expect(handlers.size).toBe(0);
  });

  it("follows the system alone where there is no backend to listen to", async () => {
    listen.mockImplementation(() => {
      throw new Error("no backend");
    });
    const stop = (await theme()).followAppearance();
    await settle();
    setSystem(true);
    expect(dark()).toBe(true);
    stop();
  });

  it("stops following when told to", async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined;
    listen.mockImplementation(async (_name: string, given: (event: { payload: unknown }) => void) => {
      handler = given;
      return () => {};
    });
    const stop = (await theme()).followAppearance();
    await settle();
    stop();
    expect(listeners.size).toBe(0);
    setSystem(true);
    handler!({ payload: { ...defaultSettings(), appearance: "dark" } });
    expect(dark()).toBe(false);
  });
});
