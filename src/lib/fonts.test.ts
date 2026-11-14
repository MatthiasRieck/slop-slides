import { describe, expect, it } from "vitest";

import { hasFont, type Measure, missingFonts } from "./fonts";

/** A computer with `installed` fonts: each sets text its own width, and the generic families theirs. */
function computer(installed: Record<string, number>): Measure {
  const generic: Record<string, number> = { monospace: 100, serif: 90, "sans-serif": 80 };
  return (font) => {
    const families = font
      .replace(/^72px /, "")
      .split(",")
      .map((f) => f.trim().replace(/^"|"$/g, ""));
    for (const family of families) {
      if (family in installed) return installed[family]!;
      if (family in generic) return generic[family]!;
    }
    return 0;
  };
}

describe("fonts", () => {
  const measure = computer({ Inter: 85, Helvetica: 80 });

  it("finds a font that sets text at another width than a generic family", () => {
    expect(hasFont("Inter", measure)).toBe(true);
    // As wide as sans-serif, but not as monospace: there.
    expect(hasFont("Helvetica", measure)).toBe(true);
    expect(hasFont("Brand Sans", measure)).toBe(false);
  });

  it("lists the fonts that are not there", () => {
    expect(missingFonts(["Inter", "Brand Sans", 'Fancy "Quoted"'], measure)).toEqual(["Brand Sans", 'Fancy "Quoted"']);
  });

  it("knows nothing when nothing can measure, and lists none as missing", () => {
    const blind: Measure = () => null;
    expect(hasFont("Inter", blind)).toBeNull();
    expect(missingFonts(["Inter"], blind)).toEqual([]);
  });
});
