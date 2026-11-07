/**
 * Every color in a deck comes from its palette (see palette.rs): what the edit toolbar picks is
 * written as `var(--name)`. A color the palette does not have yet becomes a new palette color,
 * which the editor shows at once and the next save of the slide writes into the deck.
 */
import type { PaletteEntry } from "./api";
import type { DeckColor, EditStyle, ToolFamily } from "./editTools";
import { SHADOW, SWATCHES } from "./palette";

/** The palette color the editor's shadows are mixed from. */
export const SHADOW_COLOR: PaletteEntry = { name: "shadow-color", value: SHADOW };

/** What a hand-picked color is called in the palette, numbered; the agent renames it later. */
const CUSTOM = "custom";

/** A color as one canonical string, to tell whether two are the same (as palette.rs `normalize`). */
export function normalizeColor(color: string): string {
  const c = color.trim().toLowerCase();
  const short = c.match(/^#([0-9a-f]{3,4})$/)?.[1];
  const hex = short ? [...short].map((d) => d + d).join("") : c.match(/^#([0-9a-f]{6}|[0-9a-f]{8})$/)?.[1];
  if (hex) return `#${hex.length === 8 && hex.endsWith("ff") ? hex.slice(0, 6) : hex}`;
  return c.replace(/\s+/g, "");
}

/** The palette name a `var(--name)` refers to, or null. */
export function paletteName(value: string | null | undefined): string | null {
  return value?.trim().match(/^var\(\s*--([\w-]+)\s*\)$/)?.[1] ?? null;
}

/** The first of `base` (or `base-2`, … ; with `numbered` `base-1`, …) that is not taken. */
export function freeName(base: string, taken: Set<string>, numbered = false): string {
  if (!numbered && !taken.has(base)) return base;
  for (let n = numbered ? 1 : 2; ; n++) {
    const name = `${base}-${n}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Names the palette knows, and hands out new ones. `taken` holds names given out but not yet
 * in the deck's palette (their save is on its way), so two picks in a row get two names.
 */
export class PaletteWriter {
  readonly added: Record<string, string> = {};

  constructor(
    private readonly palette: PaletteEntry[],
    private readonly pending: Map<string, string>,
  ) {}

  private all(): PaletteEntry[] {
    return [...this.palette, ...[...this.pending].map(([name, value]) => ({ name, value }))];
  }

  private taken(): Set<string> {
    return new Set(this.all().map((c) => c.name));
  }

  /** `var(--name)`; a pending color goes along again, in case the editor reloaded since. */
  private use(name: string): string {
    const pending = this.pending.get(name);
    if (pending !== undefined) this.added[name] = pending;
    return `var(--${name})`;
  }

  private add(name: string, value: string): string {
    this.pending.set(name, value);
    this.added[name] = value;
    return `var(--${name})`;
  }

  /** `var(--name)` for `color`: the palette color equal to it, or a new one named `base` (numbered when `numbered`). */
  reference(color: string, base = CUSTOM, numbered = base === CUSTOM): string {
    if (paletteName(color)) return color;
    const key = normalizeColor(color);
    const same = this.all().find((c) => normalizeColor(c.value) === key);
    if (same) return this.use(same.name);
    return this.add(freeName(base, this.taken(), numbered), color);
  }

  /** `var(--name)` for the first of `names` the palette has, or null. */
  byRole(names: readonly string[]): string | null {
    const all = this.all();
    const found = names.map((n) => all.find((c) => c.name === n)).find(Boolean);
    return found ? this.use(found.name) : null;
  }

  /** Makes sure the palette has `entry`, keeping the value it has. */
  ensure(entry: PaletteEntry): void {
    if (this.taken().has(entry.name)) this.use(entry.name);
    else this.add(entry.name, entry.value);
  }

  /** The colors added, or undefined when none were. */
  additions(): Record<string, string> | undefined {
    return Object.keys(this.added).length ? { ...this.added } : undefined;
  }
}

const COLOR_KEYS = ["color", "fill", "stroke"] as const;

/** A restyle with its colors from the palette, picked colors added to it as `custom-N`. */
export function paletteStyle(changes: EditStyle, writer: PaletteWriter): EditStyle {
  const style: EditStyle = { ...changes };
  for (const key of COLOR_KEYS) {
    const value = style[key];
    if (typeof value === "string" && value) style[key] = writer.reference(value);
  }
  if ((style.shadow ?? 0) > 0) writer.ensure(SHADOW_COLOR);
  return style;
}

/** Which palette colors stand in for the editor's default colors, by what they are used for. */
const ROLES: Record<string, { names: readonly string[]; name: string }> = {
  [SWATCHES.ink]: { names: ["ink", "text", "fg", "foreground"], name: "ink" },
  [SWATCHES.blue]: { names: ["accent", "primary"], name: "accent" },
  [SWATCHES.white]: { names: ["on-accent", "bg", "background", "paper"], name: "on-accent" },
};

/**
 * A tool's style for new elements with its colors from the palette: an editor default the
 * user has not changed becomes the deck's own color for that role (its ink, its accent), and
 * any other color the palette color equal to it or a new one.
 */
export function paletteToolStyle(
  style: EditStyle | undefined,
  family: ToolFamily | null,
  writer: PaletteWriter,
): EditStyle | undefined {
  if (!style) return style;
  const out: EditStyle = { ...style };
  for (const key of COLOR_KEYS) {
    const value = out[key];
    if (typeof value !== "string" || !value || paletteName(value)) continue;
    const role = ROLES[normalizeColor(value)];
    out[key] =
      (role && writer.byRole(role.names)) ?? writer.reference(value, role?.name ?? `${family ?? "edit"}-${key}`, false);
  }
  return out;
}

/**
 * The toolbar's deck colors: the palette's, in its order, each shown as the color the slide
 * resolves it to (`resolved`, the editor's report, by name) so it matches the selection's.
 */
export function paletteSwatches(palette: PaletteEntry[], resolved: DeckColor[]): DeckColor[] {
  return palette.map((c) => ({ name: c.name, value: resolved.find((r) => r.name === c.name)?.value ?? c.value }));
}

/** The palette colors an editor commit carries ({ name: value }), as entries. */
export function parsePaletteAdditions(value: unknown): PaletteEntry[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([name, v]) =>
    typeof v === "string" && /^[a-z][\w-]*$/i.test(name) ? [{ name, value: v }] : [],
  );
  return entries.length ? entries : undefined;
}
