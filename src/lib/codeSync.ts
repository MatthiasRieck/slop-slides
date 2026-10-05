/** Pure helpers behind the HTML view's syncing between the editor and deck.html on disk. */

/** The editor treats line breaks as `\n`; normalize so text comparisons are meaningful. */
export const normalizeNewlines = (text: string) => text.replace(/\r\n?/g, "\n");

/** The smallest single replacement turning `current` into `next`, or null when equal. */
export function changedRange(
  current: string,
  next: string,
): { from: number; to: number; insert: string } | null {
  if (current === next) return null;
  const max = Math.min(current.length, next.length);
  let start = 0;
  while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < max - start &&
    current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
  )
    end++;
  return { from: start, to: current.length - end, insert: next.slice(start, next.length - end) };
}

/**
 * What to do when deck.html is read from disk:
 * - `load`: replace the editor's text (it has no unsaved edits, or already matches disk);
 * - `conflict`: the file moved on underneath unsaved edits, so the user must choose;
 * - `keep`: disk still matches what the edits started from; nothing to do.
 */
export function onDiskRead(state: { doc: string; baseline: string; disk: string }): "load" | "conflict" | "keep" {
  const { doc, baseline, disk } = state;
  if (doc === baseline || doc === disk) return "load";
  return disk === baseline ? "keep" : "conflict";
}
