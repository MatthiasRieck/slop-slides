// @vitest-environment node
// The stylesheet the shadcn/ui components (src/components/ui) need beside the palette: their
// variants and utilities (src/shadcn.css) and tw-animate-css, neither of which the app's own
// styles may shadow.
import { readFileSync } from "node:fs";
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

  it("gives a control under the pointer a fill that shows on every surface", () => {
    // shadcn/ui hovers with `muted`; it is as strong as `accent`, which the app's own hovers use.
    const token = (block: string, name: string) =>
      css.slice(css.indexOf(`\n${block} {`)).match(new RegExp(`--${name}: (.*);`))?.[1];
    for (const block of [":root", ".dark"]) expect(token(block, "muted")).toBe(token(block, "accent"));
  });
});
