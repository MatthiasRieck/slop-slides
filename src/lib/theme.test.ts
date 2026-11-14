import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPEARANCE_KEY,
  applyAppearance,
  followAppearance,
  loadAppearance,
  loadTextSize,
  setAppearance,
  setTextSize,
  showsDark,
  TEXT_SIZE_KEY,
} from "./theme";

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

afterEach(() => vi.restoreAllMocks());

describe("the appearance", () => {
  it("is the system's until one is chosen, and whatever is stored that is not one", () => {
    expect(loadAppearance()).toBe("system");
    localStorage.setItem(APPEARANCE_KEY, "dark");
    expect(loadAppearance()).toBe("dark");
    localStorage.setItem(APPEARANCE_KEY, "sepia");
    expect(loadAppearance()).toBe("system");
  });

  it("shows dark when chosen, or when the system does and it is followed", () => {
    expect(showsDark("dark", false)).toBe(true);
    expect(showsDark("light", true)).toBe(false);
    expect(showsDark("system", true)).toBe(true);
    expect(showsDark("system", false)).toBe(false);
  });

  it("is applied as the dark class on the document", () => {
    applyAppearance("dark");
    expect(dark()).toBe(true);
    applyAppearance("light");
    expect(dark()).toBe(false);
    localStorage.setItem(APPEARANCE_KEY, "dark");
    applyAppearance();
    expect(dark()).toBe(true);
  });

  it("is remembered when set, and forgotten when it is the system's again", () => {
    setAppearance("dark");
    expect(dark()).toBe(true);
    expect(localStorage.getItem(APPEARANCE_KEY)).toBe("dark");
    setAppearance("system");
    expect(dark()).toBe(false);
    expect(localStorage.getItem(APPEARANCE_KEY)).toBeNull();
  });

  it("shows right away even when it cannot be remembered", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage is full");
    });
    expect(() => setAppearance("dark")).toThrow("storage is full");
    expect(dark()).toBe(true);
  });
});

describe("followAppearance", () => {
  it("applies the choice as it starts", () => {
    localStorage.setItem(APPEARANCE_KEY, "dark");
    const stop = followAppearance();
    expect(dark()).toBe(true);
    stop();
  });

  it("follows the system while that is the choice, and not while it is light or dark", () => {
    const stop = followAppearance();
    expect(dark()).toBe(false);
    setSystem(true);
    expect(dark()).toBe(true);
    setAppearance("light");
    expect(dark()).toBe(false);
    setSystem(false);
    setSystem(true);
    expect(dark()).toBe(false);
    setAppearance("system");
    expect(dark()).toBe(true);
    stop();
  });

  it("follows a choice made in another window", () => {
    const stop = followAppearance();
    localStorage.setItem(APPEARANCE_KEY, "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: APPEARANCE_KEY, newValue: "dark" }));
    expect(dark()).toBe(true);
    // Something else stored changes nothing.
    localStorage.setItem(APPEARANCE_KEY, "light");
    window.dispatchEvent(new StorageEvent("storage", { key: "slopslide.sidebarOpen" }));
    expect(dark()).toBe(true);
    stop();
  });

  it("stops following when told to", () => {
    const stop = followAppearance();
    stop();
    expect(listeners.size).toBe(0);
    setSystem(true);
    localStorage.setItem(APPEARANCE_KEY, "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: APPEARANCE_KEY }));
    expect(dark()).toBe(false);
  });
});

describe("the interface's text size", () => {
  const fontSize = () => document.documentElement.style.fontSize;
  afterEach(() => {
    document.documentElement.style.fontSize = "";
  });

  it("is the default until chosen, and scales the document's font size when chosen", () => {
    expect(loadTextSize()).toBe("default");
    setTextSize("large");
    expect(fontSize()).toBe("112.5%");
    expect(localStorage.getItem(TEXT_SIZE_KEY)).toBe("large");
    expect(loadTextSize()).toBe("large");
    setTextSize("small");
    expect(fontSize()).toBe("93.75%");
    setTextSize("default");
    expect(fontSize()).toBe("");
    expect(localStorage.getItem(TEXT_SIZE_KEY)).toBeNull();
    localStorage.setItem(TEXT_SIZE_KEY, "huge");
    expect(loadTextSize()).toBe("default");
  });

  it("follows a change made in another window", () => {
    const stop = followAppearance();
    localStorage.setItem(TEXT_SIZE_KEY, "large");
    window.dispatchEvent(new StorageEvent("storage", { key: TEXT_SIZE_KEY }));
    expect(fontSize()).toBe("112.5%");
    stop();
  });
});
