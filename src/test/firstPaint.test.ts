/**
 * What the window shows before the app's code has loaded (index.html and the window's own
 * background), and the motion of what opens over the app (src/index.css).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPEARANCE_KEY, APPEARANCES, showsDark } from "../lib/theme";

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

  it("applies the stored appearance before the app's module is asked for", () => {
    expect(inlineScript).toContain(`"${APPEARANCE_KEY}"`);
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf('<script type="module"'));
    expect(html.indexOf("<style>")).toBeLessThan(html.indexOf('<script type="module"'));
  });

  it.each(
    [null, ...APPEARANCES, "bogus"].flatMap((stored) => [true, false].map((systemDark) => ({ stored, systemDark }))),
  )("shows stored $stored, the system dark $systemDark, as the app then does", ({ stored, systemDark }) => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("dark") && systemDark }));
    if (stored) localStorage.setItem(APPEARANCE_KEY, stored);
    // biome-ignore lint/security/noGlobalEval: runs index.html's own inline script, as the window does
    globalThis.eval(inlineScript);
    const appearance = APPEARANCES.find((a) => a === stored) ?? "system";
    expect(document.documentElement.classList.contains("dark")).toBe(showsDark(appearance, systemDark));
  });

  it("shows as the system does when storage cannot be read", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.spyOn(Storage.prototype, "getItem").mockImplementationOnce(() => {
      throw new Error("blocked");
    });
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

describe("the motion of what opens over the app", () => {
  const ENTER = [".enter-below", ".enter-above", ".enter-pop", ".enter-fade", ".toast-enter"];

  it("animates opacity and transform only, briefly", () => {
    for (const name of ["enter", "leave", "shimmer"]) {
      const frames = css.slice(css.indexOf(`@keyframes ${name} {`)).match(/\{([\s\S]*?)\n\}/)?.[1] ?? "";
      const animated = [...frames.matchAll(/^\s+([a-z-]+):/gm)].map((match) => match[1]);
      expect(animated.length).toBeGreaterThan(0);
      expect(animated.filter((property) => property !== "opacity" && property !== "transform")).toEqual([]);
    }
    const rule = css.match(/\.enter-below,[\s\S]*?\{([\s\S]*?)\}/);
    for (const selector of ENTER) expect(rule?.[0]).toContain(selector);
    const ms = Number(rule?.[1]?.match(/animation: enter (\d+)ms/)?.[1]);
    expect(ms).toBeGreaterThanOrEqual(120);
    expect(ms).toBeLessThanOrEqual(150);
  });

  it("transitions no layout property anywhere in the stylesheet", () => {
    expect(css).not.toMatch(/transition(-property)?:[^;]*\b(all|width|height|top|left|right|bottom|margin|padding)\b/);
  });

  it("stands still for those who asked for less motion", () => {
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    for (const selector of [...ENTER, ".toast-exit"]) expect(reduced).toContain(selector);
    expect(reduced).toMatch(/\.toast-exit \{\s*animation: none !important;/);
    expect(reduced).toMatch(/\.shimmer-text::after \{\s*display: none;/);
  });

  it("moves the thinking text's shimmer with a transform, on a layer of its own", () => {
    const veil = blockOf(css, ".shimmer-text::after");
    expect(veil).toContain("will-change: transform;");
    expect(veil).toContain("animation: shimmer");
    expect(blockOf(css, ".shimmer-text")).not.toContain("animation");
  });
});
