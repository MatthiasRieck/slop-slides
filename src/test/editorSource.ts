/**
 * The slide editor's source for the tests, as the backend embeds it: the parts in
 * src-tauri/assets/editor/, joined in the order of their names (src-tauri/build.rs joins them the
 * same way). The parts are one script cut up, so only the whole of them runs.
 */
const parts = import.meta.glob<string>("../../src-tauri/assets/editor/*.js", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The parts, in the order they run: [file name, source]. */
export const EDITOR_PARTS: [string, string][] = Object.keys(parts)
  .sort()
  .map((key) => [key.slice(key.lastIndexOf("/") + 1), parts[key]!]);

/** The whole slide editor. */
export const EDITOR = EDITOR_PARTS.map(([, source]) => source).join("");
