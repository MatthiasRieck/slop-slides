/** A line of a before-and-after: one both texts have, one only the old text had, or one only the new has. */
export interface DiffLine {
  kind: "same" | "removed" | "added";
  text: string;
}

/** Texts of more lines than this (the two multiplied) are compared at their ends only, to stay quick. */
const MAX_CELLS = 40_000;

/**
 * `before` and `after` line by line, as one list: the lines they share in place, those `before`
 * alone had marked removed, those new in `after` marked added (the removed of a change first).
 * What the two start and end with alike is never compared; a middle too large to compare line by
 * line is shown as all of the old lines removed and all of the new ones added.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const midA = a.slice(start, a.length - end);
  const midB = b.slice(start, b.length - end);
  const same = (text: string): DiffLine => ({ kind: "same", text });
  return [...a.slice(0, start).map(same), ...diffMiddle(midA, midB), ...a.slice(a.length - end).map(same)];
}

/** The lines of `a` and `b`, which share neither their first nor their last line, as a diff. */
function diffMiddle(a: string[], b: string[]): DiffLine[] {
  const removed = (text: string): DiffLine => ({ kind: "removed", text });
  const added = (text: string): DiffLine => ({ kind: "added", text });
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_CELLS) {
    return [...a.map(removed), ...b.map(added)];
  }
  // The length of the longest run of lines the rests of `a` (from i) and `b` (from j) share.
  const width = b.length + 1;
  const shared = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      shared[i * width + j] =
        a[i] === b[j]
          ? shared[(i + 1) * width + j + 1]! + 1
          : Math.max(shared[(i + 1) * width + j]!, shared[i * width + j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (shared[(i + 1) * width + j]! >= shared[i * width + j + 1]!) {
      lines.push(removed(a[i++]!));
    } else {
      lines.push(added(b[j++]!));
    }
  }
  while (i < a.length) lines.push(removed(a[i++]!));
  while (j < b.length) lines.push(added(b[j++]!));
  return lines;
}

/** How many unchanged lines stay around a change. */
const CONTEXT_LINES = 2;

/**
 * `lines` with the long stretches of unchanged ones left out: each change keeps two lines around
 * it, and a gap between two of them is a `null` (shown as "⋯"). A diff without a change is empty.
 */
export function foldUnchanged(lines: readonly DiffLine[]): (DiffLine | null)[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, at) => {
    if (line.kind === "same") return;
    for (let near = Math.max(0, at - CONTEXT_LINES); near <= Math.min(lines.length - 1, at + CONTEXT_LINES); near++) {
      keep[near] = true;
    }
  });
  const folded: (DiffLine | null)[] = [];
  lines.forEach((line, at) => {
    if (keep[at]) folded.push(line);
    else if (folded.length > 0 && folded.at(-1) !== null && keep.indexOf(true, at) !== -1) folded.push(null);
  });
  return folded;
}
