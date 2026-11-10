/** Settings the app remembers in `localStorage`, stored as JSON. */

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
