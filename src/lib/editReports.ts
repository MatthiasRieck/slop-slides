/**
 * Telling whether a report from the slide editor (src-tauri/assets/editor/) says what the one
 * before it said. The editor reports as things happen (every keystroke, every frame of a drag),
 * mostly the same thing again; the app keeps the report it had then, so nothing that shows it
 * renders. Each comparison goes through the report's own fields, and stops at the first that differs.
 */

import type { EditGeometry, EditLayer } from "./arrange";
import type { DeckColor, EditSelection, FontChoice } from "./editTools";

/** Whether two records of plain values hold the same ones. */
function sameFields<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

const isRecord = (value: unknown): value is object => typeof value === "object" && value !== null;

/** Whether two lists hold the same items in the same order, by `same`. */
function sameList<T>(a: readonly T[], b: readonly T[], same: (a: T, b: T) => boolean): boolean {
  return a === b || (a.length === b.length && a.every((item, i) => same(item, b[i] as T)));
}

/** Whether two selection reports say the same: every field, and those of its line and its proportions. */
export function sameSelection(a: EditSelection | null, b: EditSelection | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as (keyof EditSelection)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    const [was, next] = [a[key], b[key]];
    return Object.is(was, next) || (isRecord(was) && isRecord(next) && sameFields(was, next));
  });
}

/** Whether two geometry reports put the selection in the same place, at the same size and angle. */
export function sameGeometry(a: EditGeometry | null, b: EditGeometry | null): boolean {
  return a === b || (!!a && !!b && sameFields(a, b));
}

const sameLayer = (a: EditLayer, b: EditLayer) =>
  a.name === b.name &&
  a.group === b.group &&
  a.locked === b.locked &&
  a.held === b.held &&
  a.selected === b.selected &&
  a.depth === b.depth &&
  a.canUp === b.canUp &&
  a.canDown === b.canDown &&
  sameList(a.path, b.path, Object.is);

/** Whether two layer lists show the same layers, in the same order and state. */
export function sameLayers(a: readonly EditLayer[], b: readonly EditLayer[]): boolean {
  return sameList(a, b, sameLayer);
}

/** Whether two lists of texts say the same, in the same order. */
export function sameTexts(a: readonly string[], b: readonly string[]): boolean {
  return sameList(a, b, Object.is);
}

const sameFont = (a: FontChoice, b: FontChoice) =>
  a.name === b.name && a.stack === b.stack && sameList(a.weights ?? [], b.weights ?? [], Object.is);

/** Whether two lists of the deck's fonts offer the same ones. */
export function sameFonts(a: readonly FontChoice[], b: readonly FontChoice[]): boolean {
  return sameList(a, b, sameFont);
}

/** Whether two lists of the deck's colors offer the same ones. */
export function sameColors(a: readonly DeckColor[], b: readonly DeckColor[]): boolean {
  return sameList(a, b, sameFields);
}
