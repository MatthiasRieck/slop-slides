/** A stretch of a text, and whether the other version of the text lacks it. */
export interface TextPart {
  text: string;
  changed: boolean;
}

/** Two versions of a text, each cut where they start and stop differing. */
export interface WordDiff {
  before: TextPart[];
  after: TextPart[];
}

/** Texts of more words than this (the two multiplied) are compared at their ends only, to stay quick. */
const MAX_CELLS = 250_000;

/** A text as its words and the spaces between them, in order; joined, they are the text again. */
const words = (text: string) => text.split(/(\s+)/).filter((word) => word !== "");

/**
 * Which words of `before` are not in `after`, and which of `after` are new: the two texts
 * compared word by word, so that one changed number in a paragraph is all that is marked.
 * Changed words next to each other, and the space between them, are one part.
 */
export function wordDiff(before: string, after: string): WordDiff {
  const a = words(before);
  const b = words(after);
  // What the two start and end with alike needs no comparing.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const midA = a.slice(start, a.length - end);
  const midB = b.slice(start, b.length - end);
  const [keptA, keptB] = commonWords(midA, midB);
  const side = (all: string[], mid: string[], kept: boolean[]) =>
    merged([
      ...all.slice(0, start).map((text) => ({ text, changed: false })),
      ...mid.map((text, at) => ({ text, changed: !kept[at] })),
      ...all.slice(all.length - end).map((text) => ({ text, changed: false })),
    ]);
  return { before: side(a, midA, keptA), after: side(b, midB, keptB) };
}

/** For each word of `a` and of `b`, whether it is one of the most words the two have in common, in order. */
function commonWords(a: string[], b: string[]): [boolean[], boolean[]] {
  const keptA = a.map(() => false);
  const keptB = b.map(() => false);
  if (a.length * b.length > MAX_CELLS) return [keptA, keptB];
  const width = b.length + 1;
  // common[i * width + j]: how many words `a` from i and `b` from j have in common, in order.
  const common = new Uint32Array((a.length + 1) * width);
  const at = (i: number, j: number) => common[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      keptA[i++] = true;
      keptB[j++] = true;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      i++;
    } else {
      j++;
    }
  }
  return [keptA, keptB];
}

/**
 * `parts` with neighbours of a kind joined. A space between two changed words is part of the
 * change, so a reworded sentence is marked as one stretch and not word by word.
 */
function merged(parts: TextPart[]): TextPart[] {
  const bridged = parts.map((part, at) => {
    const between = /^\s+$/.test(part.text) && parts[at - 1]?.changed && parts[at + 1]?.changed;
    return between ? { ...part, changed: true } : part;
  });
  const out: TextPart[] = [];
  for (const part of bridged) {
    const last = out[out.length - 1];
    if (last && last.changed === part.changed) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}
