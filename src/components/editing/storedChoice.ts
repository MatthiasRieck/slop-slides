/**
 * A choice remembered in localStorage, which may be unavailable (a private window, blocked site
 * data): reading then finds nothing, and writing only loses the choice.
 */
export function readChoice(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Remembers `value` under `key`; see `readChoice`. */
export function writeChoice(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Only the choice is lost.
  }
}
