// What a path handed to the app from outside (dropped on the start screen) opens as.

/** A PowerPoint file, which is imported as a new deck. */
export const isPowerPoint = (path: string) => /\.(pptx|pptm|potx)$/i.test(path);

/** An HTML file, which opens as a deck in its folder. */
export const isHtml = (path: string) => /\.html?$/i.test(path);

/** What to do with a path: open a deck file, import a PowerPoint file, or open a folder. */
export interface Openable {
  kind: "deck" | "powerpoint" | "folder";
  path: string;
}

/**
 * What the first of the dropped `paths` opens as: an HTML file as a deck, a PowerPoint file as
 * an import, anything else as a folder (the backend refuses what is not one). Null for no paths.
 */
export function openableOf(paths: readonly string[]): Openable | null {
  const path = paths[0];
  if (!path) return null;
  return { kind: isHtml(path) ? "deck" : isPowerPoint(path) ? "powerpoint" : "folder", path };
}
