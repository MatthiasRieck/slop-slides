// @vitest-environment node
// The app's colors come from one palette (src/index.css). These checks read the source, so a color
// picked by hand fails here instead of drifting in unnoticed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import PASTEBOARD from "../../src-tauri/assets/pasteboard.js?raw";
import { EDITOR } from "./editorSource";

const SCALES =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";
const TAILWIND_COLOR = new RegExp(
  `(?<![\\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|ring-offset|fill|stroke|from|via|to|shadow|outline|divide|accent|decoration|caret)-(?:(?:${SCALES})-\\d+|white|black)(?![\\w-])`,
  "g",
);
/** A class that sets a color from a name: the kind of utility, then what Tailwind is asked for. */
const NAMED_COLOR =
  /(?<![\w-])(?:[a-z-]+:|\[[^\]]*\]:)*(bg|text|border|ring-offset|ring|fill|stroke|from|via|to|outline|divide|accent|decoration|caret|placeholder|shadow)-([a-z]+(?:-[a-z]+)*)(?:\/\d+)?(?![\w-])/g;
/** What those utilities take that is no color of the palette: Tailwind's own keywords, sizes and sides. */
const NOT_A_TOKEN = new Set([
  ...["transparent", "current", "inherit", "none", "inset", "solid", "dashed", "dotted"],
  ...["xs", "sm", "base", "md", "lg", "xl", "left", "center", "right"],
  ...["t", "r", "b", "l", "x", "y"],
  // SVG attributes, which read the same.
  ...["dasharray", "linecap", "linejoin", "width"],
]);
const RAW_COLOR = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|\b(?:rgba?|hsla?|oklch)\(/gi;

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((f) => f.isFile() && /\.tsx?$/.test(f.name) && !/\.test\.tsx?$/.test(f.name))
    .map((f) => join(f.parentPath, f.name).replaceAll("\\", "/"))
    .filter((path) => !path.startsWith("src/test") && !path.endsWith("src/lib/palette.ts"));

const tokensIn = (css: string) => [...css.matchAll(/^\s*(--[a-z-]+):/gm)].map((m) => m[1]!);
const blockOf = (css: string, selector: string) => {
  const start = css.indexOf(`\n${selector} {`);
  return css.slice(start, css.indexOf("\n}", start));
};

describe("palette", () => {
  const css = readFileSync("src/index.css", "utf8");

  it("keeps Tailwind's color scales out of the components", () => {
    const found = sources("src").flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(TAILWIND_COLOR)].map((m) => `${path}: ${m[0]}`),
    );
    expect(found).toEqual([]);
  });

  it("uses no color the palette does not define", () => {
    const theme = css.match(/@theme inline \{[\s\S]*?\n\}/)?.[0] ?? "";
    const defined = new Set([...theme.matchAll(/--(?:color|shadow)-([a-z-]+):/g)].map((m) => m[1]!));
    expect(defined.has("ring")).toBe(true);
    const unknown = (source: string) =>
      [...source.matchAll(NAMED_COLOR)].filter(([, , name]) => !defined.has(name!) && !NOT_A_TOKEN.has(name!));
    // The check sees a made-up token, with variants and an opacity, and passes the real ones.
    expect(
      unknown("hover:bg-popover/50 focus:ring-ringg border-b text-xs bg-card ring-offset-background"),
    ).toHaveLength(2);
    const found = sources("src").flatMap((path) => unknown(readFileSync(path, "utf8")).map((m) => `${path}: ${m[0]}`));
    expect(found).toEqual([]);
  });

  it("gives what has the keyboard's focus one outline, in the palette's ring color, in both themes", () => {
    for (const block of [":root", ".dark"]) expect(tokensIn(blockOf(css, block))).toContain("--ring");
    expect(css).toMatch(/:focus-visible \{\s*outline: 2px solid var\(--ring\);/);
  });

  it("follows the theme with the native controls, and tones motion down for those who ask", () => {
    expect(blockOf(css, ":root")).toMatch(/color-scheme: light;/);
    expect(blockOf(css, ".dark")).toMatch(/color-scheme: dark;/);
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(reduced).toMatch(/animation-duration: 0\.01ms !important;/);
    expect(reduced).toMatch(/transition-duration: 0\.01ms !important;/);
    expect(reduced).toMatch(/\.shimmer-text \{\s*animation: none !important;/);
  });

  it("keeps raw colors out of the components", () => {
    const found = sources("src").flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        // The laser's color is built from the swatches, with an alpha.
        .filter((line) => !line.includes("LASER_RGB"))
        // Not the app's to choose: Claude's brand color, and a mask, where only the alpha counts.
        .filter((line) => !line.includes("fill-[#d97757]") && !line.includes("#000 ${round(at + half)}px"))
        .flatMap((line) => line.match(RAW_COLOR)?.map((color) => `${path}: ${color}`) ?? []),
    );
    expect(found).toEqual([]);
  });

  it("gives the slide's frame only palette colors", () => {
    // Styles for what the editor adds to a deck, and transparent, which the pasteboard compares with.
    const content = /var (?:BORDER_COLOR|FALLBACK_STYLE|SHADOW_COLOR) = .*|"#000"|rgba\(0, 0, 0, 0\)/g;
    const defaults = /":root \{ --slop-[\s\S]*?\}" \+/;
    const own = `${EDITOR}\n${PASTEBOARD}`.replace(defaults, "").replace(content, "");
    expect(own.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b(?!-)|\brgba?\(/gi) ?? []).toEqual([]);
  });

  it("uses only variables the frame has a default for", () => {
    const defaults = PASTEBOARD.match(/":root \{ --slop-[\s\S]*?\}" \+/)?.[0] ?? "";
    const used = new Set(`${EDITOR}\n${PASTEBOARD}`.match(/var\(--slop-(?!w\b|h\b|pptx)[a-z-]+/g));
    expect(used.size).toBeGreaterThan(0);
    for (const use of used) expect(defaults).toContain(`${use.slice(4)}: `);
  });

  it("starts the frame on the app's accent", () => {
    const primary = blockOf(css, ":root").match(/--primary: (.*);/)?.[1];
    expect(PASTEBOARD).toContain(`--slop-accent: ${primary};`);
  });

  it("names every token the theme overrides", () => {
    const light = tokensIn(blockOf(css, ":root"));
    for (const token of tokensIn(blockOf(css, ".dark"))) expect(light).toContain(token);
  });

  it("pairs every fill with its foreground, in both themes", () => {
    const light = tokensIn(blockOf(css, ":root"));
    const dark = tokensIn(blockOf(css, ".dark"));
    for (const name of ["success", "warning", "destructive", "info"]) {
      for (const tokens of [light, dark]) {
        expect(tokens).toContain(`--${name}`);
        expect(tokens).toContain(`--${name}-foreground`);
      }
    }
  });

  it("shades a thumbnail in both themes, with an edge that shows on a dark surface", () => {
    const theme = css.match(/@theme inline \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(theme).toMatch(/--shadow-thumbnail:[^;]*var\(--thumbnail-edge\)[^;]*var\(--thumbnail-shade\)/);
    expect(blockOf(css, ":root")).toMatch(/--thumbnail-edge: --alpha\(var\(--color-black\)/);
    expect(blockOf(css, ".dark")).toMatch(/--thumbnail-edge: --alpha\(var\(--color-white\)/);
    for (const block of [":root", ".dark"]) expect(tokensIn(blockOf(css, block))).toContain("--thumbnail-shade");
  });

  it("offers every class the components use", () => {
    const theme = css.match(/@theme inline \{[\s\S]*?\n\}/)?.[0] ?? "";
    for (const name of ["success", "warning", "info", "stage", "paper", "scrim", "overlay", "handle"]) {
      expect(theme).toContain(`--color-${name}: var(--${name});`);
    }
  });
});
