// @vitest-environment node
// The stylesheet the shadcn/ui components (src/components/ui) need beside the palette: their
// variants and utilities (src/shadcn.css) and tw-animate-css, neither of which the app's own
// styles may shadow.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/index.css", "utf8");
const shadcn = readFileSync("src/shadcn.css", "utf8");

describe("the stylesheet of the shadcn/ui components", () => {
  it("is loaded after Tailwind, with the animations the components use", () => {
    const imports = [...css.matchAll(/^@import "([^"]+)";/gm)].map((match) => match[1]);
    expect(imports).toEqual(["tailwindcss", "tw-animate-css", "./shadcn.css"]);
  });

  it("matches Base UI's attributes with the variants the components are written in", () => {
    for (const variant of ["open", "closed", "checked", "unchecked", "disabled", "active", "horizontal", "vertical"]) {
      expect(shadcn).toContain(`@custom-variant data-${variant} {`);
    }
    expect(shadcn).toMatch(/@custom-variant data-horizontal \{\s*&:where\(\[data-orientation="horizontal"\]\)/);
  });

  it("has the utilities the chat's components use", () => {
    for (const utility of ["scroll-fade-b", "scroll-fade-x", "scroll-fade-y", "shimmer", "shimmer-none"]) {
      expect(shadcn).toContain(`@utility ${utility} {`);
    }
  });

  it("leaves the components their keyframes: the app has none of its own to shadow them", () => {
    // tw-animate-css animates every popup with `enter` and `exit`; the later of two keyframes of one name wins.
    const own = [...css.matchAll(/@keyframes ([\w-]+)/g)].map((match) => match[1]);
    expect(own).toEqual([]);
  });

  it("keeps the dark variant on a subtree, so a popup of the presenter's can be dark by itself", () => {
    expect(css).toContain("@custom-variant dark (&:is(.dark, .dark *));");
  });

  it("stills the components' motion with everything else for those who ask", () => {
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    // The universal rule: the components animate with `animation` (tw-animate-css) and `transition` (Base UI).
    expect(reduced).toMatch(/\*,\s*::before,\s*::after \{[^}]*animation-duration: 0\.01ms !important;/);
    expect(reduced).toMatch(/transition-duration: 0\.01ms !important;/);
  });

  it("shows shimmering text plainly where the shimmer cannot be painted", () => {
    // The utility fills the text with a gradient worked out from `currentColor`, and makes the
    // text itself transparent: without relative colors of `currentColor` (WebKit before Safari 18)
    // nothing would be left to see.
    expect(shadcn).toMatch(/--shimmer-color,\s*oklch\(from currentColor/);
    expect(shadcn).toContain("-webkit-text-fill-color: var(--shimmer-text-fill, transparent);");
    expect(shadcn).toMatch(/background-image: var\(\s*--shimmer-image,/);
    const guard = css.match(/@supports not \(color: oklch\(from currentColor l c h\)\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(guard).toMatch(/\* \{\s*--shimmer-image: none;\s*--shimmer-text-fill: currentColor;/);
    // Neither switch is inherited, so setting them on everything touches only what shimmers.
    for (const name of ["--shimmer-image", "--shimmer-text-fill"]) {
      expect(shadcn).toMatch(new RegExp(`@property ${name} \\{[^}]*inherits: false;`));
    }
  });

  it("styles every scrollbar in one place, and fades no code where the fade cannot follow the scrolling", () => {
    // A `scrollbar-width` or `scrollbar-color` on an element switches it to the platform's
    // scrollbar and off the `::-webkit-scrollbar` rules every other one is drawn by.
    expect(css).toMatch(/::-webkit-scrollbar-thumb \{\s*background: var\(--input\);/);
    const ui = readdirSync("src/components", { withFileTypes: true, recursive: true })
      .filter((file) => file.isFile() && /\.tsx$/.test(file.name) && !/\.test\.tsx$/.test(file.name))
      .map((file) => join(file.parentPath, file.name));
    expect(ui.length).toBeGreaterThan(50);
    const found = ui.flatMap((path) =>
      (readFileSync(path, "utf8").match(/(?<![\w-])scrollbar-(?:thin|thumb-[\w-]+|track-[\w-]+)/g) ?? []).map(
        (name) => `${path}: ${name}`,
      ),
    );
    expect(found).toEqual([]);
    // Without scroll-driven animations (WebKit before Safari 26) the fade is static, 40px wide
    // over 12px of padding: it would dim the start of every line of code, scrolled or not.
    const block = readFileSync("src/components/ui/code-block.tsx", "utf8");
    expect(block).toMatch(/scroll-fade-x [^"]*not-supports-\[animation-timeline:scroll\(\)\]:scroll-fade-none/);
    expect(shadcn).toMatch(/@utility scroll-fade-none \{\s*--scroll-fade-mask: none;/);
  });

  it("gives a control under the pointer a fill that shows on every surface", () => {
    // shadcn/ui hovers with `muted`; it is as strong as `accent`, which the app's own hovers use.
    const token = (block: string, name: string) =>
      css.slice(css.indexOf(`\n${block} {`)).match(new RegExp(`--${name}: (.*);`))?.[1];
    for (const block of [":root", ".dark"]) expect(token(block, "muted")).toBe(token(block, "accent"));
  });
});
