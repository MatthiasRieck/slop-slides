/**
 * Color math for the deck's palette: reading CSS colors, OKLCH (lightness, chroma, hue, the
 * space where turning the hue keeps how light and how vivid a color looks), turning a whole
 * palette around the color wheel, and carrying a preset palette over to a deck's colors.
 */
import type { PaletteEntry } from "./api";

export interface Rgba {
  /** 0 to 1, sRGB. */
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Oklch {
  /** 0 to 1. */
  l: number;
  /** 0 to about 0.37 for sRGB. */
  c: number;
  /** Degrees, 0 to 360. */
  h: number;
  a: number;
}

/** Named colors the palette is likely to use; others are read by the browser where it can. */
const NAMED: Record<string, string> = {
  white: "fff",
  black: "000",
  red: "f00",
  green: "008000",
  blue: "00f",
  yellow: "ff0",
  orange: "ffa500",
  purple: "800080",
  gray: "808080",
  grey: "808080",
  silver: "c0c0c0",
  navy: "000080",
  teal: "008080",
  maroon: "800000",
  olive: "808000",
  lime: "0f0",
  aqua: "0ff",
  cyan: "0ff",
  fuchsia: "f0f",
  magenta: "f0f",
  pink: "ffc0cb",
  tomato: "ff6347",
  gold: "ffd700",
  coral: "ff7f50",
  ivory: "fffff0",
  beige: "f5f5dc",
  crimson: "dc143c",
  indigo: "4b0082",
  salmon: "fa8072",
  tan: "d2b48c",
  khaki: "f0e68c",
  plum: "dda0dd",
  orchid: "da70d6",
  wheat: "f5deb3",
  linen: "faf0e6",
};

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

function fromHex(hex: string): Rgba | null {
  const h = hex.length <= 4 ? [...hex].map((d) => d + d).join("") : hex;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return null;
  const byte = (i: number) => Number.parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: byte(0), g: byte(2), b: byte(4), a: h.length === 8 ? byte(6) : 1 };
}

/** A number, or a percentage of `full`. */
function amount(text: string | undefined, full: number): number | null {
  if (text === undefined) return null;
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n)) return null;
  return text.trim().endsWith("%") ? (n / 100) * full : n;
}

function hueOf(text: string | undefined): number | null {
  if (text === undefined) return null;
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n)) return null;
  if (text.endsWith("turn")) return n * 360;
  if (text.endsWith("rad")) return (n * 180) / Math.PI;
  return n;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

/** Reads a CSS color: hex, named, and the rgb, hsl and oklch functions. Null for anything else. */
export function parseColor(text: string): Rgba | null {
  const t = text.trim().toLowerCase();
  if (t.startsWith("#")) return fromHex(t.slice(1));
  if (NAMED[t]) return fromHex(NAMED[t]);
  const fn = t.match(/^([a-z]+)\((.*)\)$/);
  if (!fn) return null;
  const [name, body] = [fn[1]!, fn[2]!];
  const [main, slash] = body.split("/");
  const parts = main!.split(/[\s,]+/).filter(Boolean);
  const alphaText = slash?.trim() ?? (parts.length === 4 ? parts[3] : undefined);
  const alpha = alphaText === undefined ? 1 : clamp(amount(alphaText, 1) ?? 1);
  if (name === "rgb" || name === "rgba") {
    const [r, g, b] = parts.slice(0, 3).map((p) => amount(p, 255));
    if (r == null || g == null || b == null) return null;
    return { r: clamp(r / 255), g: clamp(g / 255), b: clamp(b / 255), a: alpha };
  }
  if (name === "hsl" || name === "hsla") {
    const h = hueOf(parts[0]);
    const s = amount(parts[1], 1);
    const l = amount(parts[2], 1);
    if (h == null || s == null || l == null) return null;
    const [r, g, b] = hslToRgb(((h % 360) + 360) % 360, clamp(s), clamp(l));
    return { r, g, b, a: alpha };
  }
  if (name === "oklch") {
    const l = amount(parts[0], 1);
    const c = amount(parts[1], 0.4);
    const h = hueOf(parts[2]);
    if (l == null || c == null || h == null) return null;
    return fromOklch({ l, c, h, a: alpha });
  }
  return null;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function toOklch(color: Rgba): Oklch {
  const [r, g, b] = [toLinear(color.r), toLinear(color.g), toLinear(color.b)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  const h = c < 1e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h, a: color.a };
}

/** The color, unclipped: channels may fall outside 0 to 1 when it is out of sRGB's gamut. */
function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const A = c * Math.cos((h * Math.PI) / 180);
  const B = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** The sRGB color; one outside sRGB keeps its lightness and hue and loses chroma until it fits. */
export function fromOklch(color: Oklch): Rgba {
  let fit = { ...color, l: clamp(color.l), c: Math.max(0, color.c) };
  if (!inGamut(oklchToLinear(fit))) {
    let [lo, hi] = [0, fit.c];
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ ...fit, c: mid }))) lo = mid;
      else hi = mid;
    }
    fit = { ...fit, c: lo };
  }
  const [r, g, b] = oklchToLinear(fit).map((v) => clamp(fromLinear(clamp(v))));
  return { r: r!, g: g!, b: b!, a: color.a };
}

/** `#rrggbb`, or `#rrggbbaa` when see-through. */
export function toHex(color: Rgba): string {
  const byte = (v: number) =>
    Math.round(clamp(v) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}${color.a < 0.999 ? byte(color.a) : ""}`;
}

/** Below this chroma a color counts as gray: turning the wheel leaves it be. */
export const NEUTRAL_CHROMA = 0.02;

/** The palette with every color's hue turned by `degrees`, each as light and as vivid as before. */
export function rotatePalette(palette: PaletteEntry[], degrees: number): PaletteEntry[] {
  return palette.map((entry) => {
    const rgba = parseColor(entry.value);
    if (!rgba) return entry;
    const c = toOklch(rgba);
    if (c.c < NEUTRAL_CHROMA) return entry;
    return { name: entry.name, value: toHex(fromOklch({ ...c, h: (((c.h + degrees) % 360) + 360) % 360 })) };
  });
}

/** A palette color placed on the wheel: its hue as the angle, its chroma as the distance out. */
export interface WheelPoint {
  name: string;
  value: string;
  hex: string;
  /** Degrees, clockwise from the top. */
  angle: number;
  /** 0 at the center to 1 at the rim. */
  radius: number;
}

/** How much chroma reaches the rim. */
export const RIM_CHROMA = 0.32;

/** The palette's colors on the wheel, those the wheel cannot read left out. */
export function wheelPoints(palette: PaletteEntry[]): WheelPoint[] {
  return palette.flatMap((entry) => {
    const rgba = parseColor(entry.value);
    if (!rgba) return [];
    const c = toOklch(rgba);
    return [
      {
        name: entry.name,
        value: entry.value,
        hex: toHex({ ...rgba, a: 1 }),
        angle: c.h,
        radius: clamp(c.c / RIM_CHROMA),
      },
    ];
  });
}

/** A color at a spot on the wheel, as light as `like`: the hue from the angle, chroma from the distance. */
export function colorAt(like: string, angle: number, radius: number): string | null {
  const rgba = parseColor(like);
  if (!rgba) return null;
  const c = toOklch(rgba);
  return toHex(fromOklch({ ...c, h: ((angle % 360) + 360) % 360, c: clamp(radius) * RIM_CHROMA }));
}

/** The colors around the rim, for the wheel's conic gradient (`steps` stops, the first repeated at the end). */
export function rimColors(steps = 12, l = 0.72, c = 0.15): string[] {
  const out = Array.from({ length: steps }, (_, i) => toHex(fromOklch({ l, c, h: (360 * i) / steps, a: 1 })));
  return [...out, out[0]!];
}

/** Other names the palette's roles go by, so a preset finds them in any deck. */
const ROLE_NAMES: Record<string, readonly string[]> = {
  bg: ["bg", "background", "paper", "page", "canvas"],
  ink: ["ink", "text", "fg", "foreground"],
  muted: ["muted", "subtle", "secondary", "dim"],
  accent: ["accent", "primary", "brand", "highlight"],
  panel: ["panel", "card", "surface", "tile"],
  "accent-2": ["accent-2", "secondary-accent", "cyan", "sun"],
};

const lab = (c: Oklch) => [c.l, c.c * Math.cos((c.h * Math.PI) / 180), c.c * Math.sin((c.h * Math.PI) / 180)];
const distance = (a: Oklch, b: Oklch) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]!));

/**
 * The deck's palette in a preset's colors. Colors in a role the preset has (by name, or a name
 * that role goes by) take its color; every other color moves the way the nearest of those moved,
 * so it keeps how it stood to it. With no role in common, colors pair up by lightness.
 */
export function applyPreset(palette: PaletteEntry[], preset: Record<string, string>): PaletteEntry[] {
  const roleOf = (name: string) => Object.keys(preset).find((role) => (ROLE_NAMES[role] ?? [role]).includes(name));
  const read = palette.map((entry) => {
    const rgba = parseColor(entry.value);
    return { entry, color: rgba ? toOklch(rgba) : null, role: roleOf(entry.name) };
  });
  // Each role once: the first color in it.
  const seen = new Set<string>();
  const anchors = read.flatMap((r) => {
    if (!r.color || !r.role || seen.has(r.role)) return [];
    const target = parseColor(preset[r.role]!);
    if (!target) return [];
    seen.add(r.role);
    return [{ name: r.entry.name, from: r.color, to: toOklch(target) }];
  });
  if (anchors.length === 0) {
    // Dark to dark, light to light.
    const targets = Object.values(preset)
      .flatMap((v) => (parseColor(v) ? [toOklch(parseColor(v)!)] : []))
      .sort((a, b) => a.l - b.l);
    const colors = read.filter((r) => r.color).sort((a, b) => a.color!.l - b.color!.l);
    colors.forEach((r, i) => {
      const at = colors.length === 1 ? 0 : Math.round((i * (targets.length - 1)) / (colors.length - 1));
      if (targets[at]) anchors.push({ name: r.entry.name, from: r.color!, to: targets[at]! });
    });
  }
  return read.map(({ entry, color }) => {
    if (!color) return entry;
    const own = anchors.find((a) => a.name === entry.name);
    if (own) return { name: entry.name, value: toHex({ ...fromOklch(own.to), a: color.a }) };
    if (anchors.length === 0) return entry;
    const near = anchors.reduce((best, a) => (distance(a.from, color) < distance(best.from, color) ? a : best));
    const ratio = near.from.c < NEUTRAL_CHROMA ? 1 : near.to.c / near.from.c;
    const moved: Oklch = {
      l: color.l + (near.to.l - near.from.l),
      c: color.c < NEUTRAL_CHROMA ? color.c : color.c * ratio,
      h: near.from.c < NEUTRAL_CHROMA || near.to.c < NEUTRAL_CHROMA ? color.h : color.h + (near.to.h - near.from.h),
      a: color.a,
    };
    return { name: entry.name, value: toHex(fromOklch(moved)) };
  });
}
