/**
 * What the app remembers in `localStorage` between launches, read and written in one way.
 *
 * Reading never throws: storage may be unavailable (a private window, blocked site data), and
 * then nothing is remembered. Saving throws when storage is full or unavailable, except
 * `trySaveText`, for a choice whose loss does not matter.
 */

/**
 * What is stored under `key`, made a `T` by `read` (which gets the parsed JSON and checks it);
 * `fallback` when nothing is stored, it is not JSON, `read` throws, or storage is unavailable.
 */
export function loadJson<T>(key: string, fallback: T, read: (saved: unknown) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : read(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

/** Stores `value` under `key` as JSON; throws when storage is full or unavailable. */
export function saveJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

/** A flag stored as "true" or "false"; `fallback` for anything else, nothing stored, or storage unavailable. */
export function loadFlag(key: string, fallback: boolean): boolean {
  const saved = loadText(key);
  return fallback ? saved !== "false" : saved === "true";
}

/** Stores `value` under `key` as "true" or "false"; throws when storage is full or unavailable. */
export function saveFlag(key: string, value: boolean): void {
  localStorage.setItem(key, String(value));
}

/** The text stored under `key`; null when nothing is stored or storage is unavailable. Callers check it. */
export function loadText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores `value` under `key`, or forgets what is stored when it is null; throws when storage is full or unavailable. */
export function saveText(key: string, value: string | null): void {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

/** Like `saveText`, but a failure only loses what was to be remembered. */
export function trySaveText(key: string, value: string | null): void {
  try {
    saveText(key, value);
  } catch {
    // Only the remembered choice is lost.
  }
}

/**
 * A size in pixels stored under `key` (a panel's width, say); `fallback` when nothing is stored,
 * it is no number, or it lies outside `min` to `max`: a width from a larger window does not fit a smaller one.
 */
export function loadSize(key: string, fallback: number, min: number, max: number): number {
  const saved = loadText(key);
  const size = saved === null || saved.trim() === "" ? Number.NaN : Number(saved);
  return Number.isFinite(size) && size >= min && size <= max ? size : fallback;
}

/** Remembers a size in pixels under `key`, rounded; a failure only loses it. */
export function trySaveSize(key: string, size: number): void {
  trySaveText(key, String(Math.round(size)));
}
