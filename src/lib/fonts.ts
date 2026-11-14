// Whether a font is on this computer, for the PowerPoint import report: a deck set in a font the
// computer does not have shows another one, and the user should know which slides to check.

/** How wide `text` is set in the CSS `font`, in pixels; null when nothing can measure. */
export type Measure = (font: string, text: string) => number | null;

/** Wide and narrow letters both, so that nearly any two fonts set it at different widths. */
const SAMPLE = "mmmmmmmmmmlli WQ@#0123456789";
/** Generic families a font falls back to: a font that is there differs from at least one of them. */
const FALLBACKS = ["monospace", "serif", "sans-serif"];

/** Measures with a canvas of this window. */
function canvasMeasure(): Measure {
  let context: CanvasRenderingContext2D | null | undefined;
  return (font, text) => {
    if (context === undefined) {
      try {
        context = document.createElement("canvas").getContext("2d");
      } catch {
        context = null;
      }
    }
    if (!context) return null;
    context.font = font;
    return context.measureText(text).width;
  };
}

/** `name` quoted for a CSS font list. */
const quoted = (name: string) => `"${name.replace(/["\\]/g, "")}"`;

/**
 * Whether the font `name` is installed: text set in it, falling back to a generic family, comes
 * out wider or narrower than the generic family alone for one of them. Unknown (null) when
 * nothing can measure.
 */
export function hasFont(name: string, measure: Measure = canvasMeasure()): boolean | null {
  for (const fallback of FALLBACKS) {
    const alone = measure(`72px ${fallback}`, SAMPLE);
    const withFont = measure(`72px ${quoted(name)}, ${fallback}`, SAMPLE);
    if (alone === null || withFont === null) return null;
    if (alone !== withFont) return true;
  }
  return false;
}

/** The fonts of `names` this computer does not have; none when that cannot be told. */
export function missingFonts(names: string[], measure: Measure = canvasMeasure()): string[] {
  return names.filter((name) => hasFont(name, measure) === false);
}
