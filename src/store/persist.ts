// What the app keeps in localStorage between launches, read and written in one way.

/** The JSON value saved under `key`; null when nothing is saved or it is not JSON. Callers check its shape. */
export function loadJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

export function saveJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

/** A flag saved as "true" or "false"; anything else, or nothing saved, is `fallback`. */
export function loadFlag(key: string, fallback: boolean): boolean {
  const saved = localStorage.getItem(key);
  return fallback ? saved !== "false" : saved === "true";
}

export function saveFlag(key: string, value: boolean): void {
  localStorage.setItem(key, String(value));
}
