/**
 * What the window shows before the app's code has loaded (index.html and the window's own
 * background), and the motion of what opens over the app (src/index.css).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPEARANCES, showsDark } from "../lib/theme";

const read = (path: string) => readFileSync(resolve(__dirname, "../..", path), "utf8");
const html = read("index.html");
const css = read("src/index.css");
const inlineStyle = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

/** The declarations of the first `selector { … }` block of `sheet`. */
const blockOf = (sheet: string, selector: string) =>
  sheet.slice(sheet.indexOf(`${selector} {`)).match(/\{([\s\S]*?)\n?\s*\}/)?.[1] ?? "";

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
  localStorage.clear();
});

describe("the window before the app's code has loaded", () => {
  it("has the app's background inline, light and dark, as the stylesheet's tokens have it", () => {
    const light = blockOf(css, ":root").match(/--background: ([^;]+);/)?.[1];
    expect(light).toBe("oklch(0.992 0 0)");
    expect(blockOf(inlineStyle, "html")).toContain(`background: ${light};`);
    // Dark, the token is Tailwind's neutral-950.
    expect(blockOf(css, ".dark")).toContain("--background: var(--color-neutral-950);");
    const neutral950 = read("node_modules/tailwindcss/theme.css").match(/--color-neutral-950: oklch\(([^)]+)\)/)?.[1];
    expect(neutral950).toBe("14.5% 0 none");
    expect(blockOf(inlineStyle, "html.dark")).toContain("background: oklch(0.145 0 0);");
    expect(blockOf(inlineStyle, "html.dark")).toContain("color-scheme: dark;");
  });

  it("applies the appearance the app handed the window before the app's module is asked for", () => {
    expect(inlineScript).toContain("__SLOPSLIDE_SETTINGS__");
    // The choice is the app's setting now, not the window's storage.
    expect(inlineScript).not.toContain("localStorage");
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf('<script type="module"'));
    expect(html.indexOf("<style>")).toBeLessThan(html.indexOf('<script type="module"'));
  });

  it.each(
    [null, ...APPEARANCES, "bogus"].flatMap((handed) => [true, false].map((systemDark) => ({ handed, systemDark }))),
  )("shows $handed handed over, the system dark $systemDark, as the app then does", ({ handed, systemDark }) => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("dark") && systemDark }));
    if (handed) vi.stubGlobal("__SLOPSLIDE_SETTINGS__", { settings: { appearance: handed }, notice: null });
    // What storage held before the settings moved to the app's file counts no more.
    localStorage.setItem("slopslide.appearance", systemDark ? "light" : "dark");
    // biome-ignore lint/security/noGlobalEval: runs index.html's own inline script, as the window does
    globalThis.eval(inlineScript);
    const appearance = APPEARANCES.find((a) => a === handed) ?? "system";
    expect(document.documentElement.classList.contains("dark")).toBe(showsDark(appearance, systemDark));
  });

  it("shows as the system does when the app handed nothing over, or nothing that holds settings", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    // biome-ignore lint/security/noGlobalEval: runs index.html's own inline script, as the window does
    globalThis.eval(inlineScript);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    document.documentElement.classList.remove("dark");
    vi.stubGlobal("__SLOPSLIDE_SETTINGS__", { notice: null });
    // biome-ignore lint/security/noGlobalEval: runs index.html's own inline script, as the window does
    globalThis.eval(inlineScript);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("gives the window itself the light background, and lets inline code run", () => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
    // One color serves both themes there; the default appearance of a first start is the light one.
    expect(conf.app.windows[0].backgroundColor).toBe("#fcfcfc");
    // No policy that would stop the inline style and script.
    expect(conf.app.security.csp).toBeNull();
  });
});

describe("the app's own motion", () => {
  it("leaves what opens over the app to the shadcn/ui components, with no animation classes of its own", () => {
    // The popups animate themselves (tw-animate-css); the old `enter-*` and `toast-*` classes are gone.
    expect(css).not.toMatch(/@keyframes/);
    expect(css).not.toMatch(/^\s*animation(-name)?:/m);
  });

  it("transitions no layout property anywhere in the stylesheet", () => {
    expect(css).not.toMatch(/transition(-property)?:[^;]*\b(all|width|height|top|left|right|bottom|margin|padding)\b/);
  });

  it("stands still for those who asked for less motion", () => {
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(reduced).toMatch(/\*,\s*::before,\s*::after \{[^}]*animation-duration: 0\.01ms !important;/);
    expect(reduced).toMatch(/animation-iteration-count: 1 !important;/);
    expect(reduced).toMatch(/transition-duration: 0\.01ms !important;/);
  });
});
