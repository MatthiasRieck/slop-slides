/**
 * The deck's slide size (see src-tauri/src/size.rs): every slide is a fixed canvas, 1920×1080 px
 * unless deck.html names another size in its `slopslide-size` meta. Inches and centimetres are
 * CSS units, 96 px per inch.
 */

export type SizeUnit = "px" | "in" | "cm";

/** A slide size as the user gave it. */
export interface SlideSize {
  width: number;
  height: number;
  unit: SizeUnit;
}

/** A slide size as the backend reports it, with the canvas in whole CSS pixels. */
export interface SizeInfo extends SlideSize {
  pixelWidth: number;
  pixelHeight: number;
}

/** A canvas in CSS pixels. */
export interface Pixels {
  width: number;
  height: number;
}

export type Orientation = "landscape" | "portrait" | "square";

export const DEFAULT_SIZE: SizeInfo = { width: 1920, height: 1080, unit: "px", pixelWidth: 1920, pixelHeight: 1080 };

/** The smallest and largest canvas side, in CSS pixels (as the backend allows). */
export const MIN_PX = 100;
export const MAX_PX = 10_000;

/** CSS pixels per unit. */
export const PX_PER: Record<SizeUnit, number> = { px: 1, in: 96, cm: 96 / 2.54 };

/** The canvas of `size` in whole CSS pixels, as the backend rounds it. */
export function toPixels(size: SlideSize): Pixels {
  return { width: Math.round(size.width * PX_PER[size.unit]), height: Math.round(size.height * PX_PER[size.unit]) };
}

/** The canvas of a deck, template or deck summary; the default size when it names none. */
export function pixelsOf(owner: { size?: SizeInfo | null } | null | undefined): Pixels {
  const size = owner?.size;
  return size ? { width: size.pixelWidth, height: size.pixelHeight } : { width: DEFAULT_SIZE.pixelWidth, height: DEFAULT_SIZE.pixelHeight };
}

/** `n` in `unit`, rounded to what the field shows: whole pixels, or hundredths of in / cm. */
export function roundIn(n: number, unit: SizeUnit): number {
  return unit === "px" ? Math.round(n) : Math.round(n * 100) / 100;
}

/** `size` expressed in `unit` instead. */
export function convert(size: SlideSize, unit: SizeUnit): SlideSize {
  if (size.unit === unit) return size;
  const factor = PX_PER[size.unit] / PX_PER[unit];
  return { width: roundIn(size.width * factor, unit), height: roundIn(size.height * factor, unit), unit };
}

export function orientationOf(size: { width: number; height: number }): Orientation {
  if (Math.abs(size.width - size.height) < 1e-9) return "square";
  return size.width > size.height ? "landscape" : "portrait";
}

/** `size` turned to `orientation`: the sides swapped, or the shorter side for both of a square. */
export function withOrientation(size: SlideSize, orientation: Orientation): SlideSize {
  const long = Math.max(size.width, size.height);
  const short = Math.min(size.width, size.height);
  if (orientation === "square") return { ...size, width: short, height: short };
  if (orientationOf(size) === "square") {
    // A square has no long side; give it the 16:9 shape of the default slide.
    const other = roundIn((short * 16) / 9, size.unit);
    return orientation === "landscape" ? { ...size, width: other, height: short } : { ...size, width: short, height: other };
  }
  return orientation === "landscape" ? { ...size, width: long, height: short } : { ...size, width: short, height: long };
}

/** Why the backend would refuse `size`, or null when it is fine. */
export function sizeProblem(size: SlideSize): string | null {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
    return "Enter a width and a height.";
  }
  const px = toPixels(size);
  if ([px.width, px.height].some((n) => n < MIN_PX || n > MAX_PX)) {
    return `Each side must be ${MIN_PX}–${MAX_PX.toLocaleString("en-US")} px (now ${px.width}×${px.height} px).`;
  }
  return null;
}

/** Same size as given (both sides and the unit). */
export function sameSize(a: SlideSize, b: SlideSize): boolean {
  return a.unit === b.unit && a.width === b.width && a.height === b.height;
}

/** "1920 × 1080 px", "8.5 × 11 in", "21 × 29.7 cm". */
export function formatSize(size: SlideSize): string {
  return `${size.width} × ${size.height} ${size.unit}`;
}

/** The size, plus its canvas in pixels when it is in inches or centimetres. */
export function describeSize(size: SlideSize): string {
  if (size.unit === "px") return formatSize(size);
  const px = toPixels(size);
  return `${formatSize(size)} (${px.width} × ${px.height} px)`;
}

/** Common slide sizes to pick from. */
export const SIZE_PRESETS: { label: string; size: SlideSize }[] = [
  { label: "Widescreen 16:9", size: { width: 1920, height: 1080, unit: "px" } },
  { label: "Standard 4:3", size: { width: 1440, height: 1080, unit: "px" } },
  { label: "Square 1:1", size: { width: 1080, height: 1080, unit: "px" } },
  { label: "Social portrait 4:5", size: { width: 1080, height: 1350, unit: "px" } },
  { label: "Story 9:16", size: { width: 1080, height: 1920, unit: "px" } },
  { label: "A4", size: { width: 21, height: 29.7, unit: "cm" } },
  { label: "US Letter", size: { width: 8.5, height: 11, unit: "in" } },
];

/** The prompt asking the agent to adapt the deck after the slide size changed. */
export function resizePrompt(from: SlideSize, to: SlideSize): string {
  const shape = (s: SlideSize) => `${orientationOf(s)}, ${describeSize(s)}`;
  return (
    `I changed the slide size from ${shape(from)} to ${shape(to)}. ` +
    "Re-lay out every slide for the new canvas: rework each layout for its shape and rescale type, spacing and any fixed sizes or positions so nothing is clipped, overflows or leaves awkward empty space. " +
    "Keep all content, slide ids, sections, hidden slides and speaker notes, and keep the design system."
  );
}
