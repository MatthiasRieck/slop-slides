/**
 * Works out where a speaker is in a script from what speech recognition heard. People don't
 * say the exact words and recognition makes mistakes, so what was heard is aligned with the
 * script (a local alignment, as in Smith-Waterman), which puts up with words left out, added or
 * changed, and finds the speaker wherever they went: a jump needs more proof than reading on.
 */

/** A word of the script, where it is in the text and in the form words are compared. */
interface Word {
  start: number;
  end: number;
  form: string;
}

export interface Script {
  text: string;
  words: Word[];
}

/** How far the speaker got. */
export interface Track {
  /** Index of the word the speaker gets to next. */
  position: number;
  /** For each word of the script, whether it has been said. Words jumped over stay unsaid. */
  said: boolean[];
}

/** A stretch of the script, as it is shown. */
export interface Piece {
  text: string;
  said: boolean;
  /** The last word the speaker said. */
  current: boolean;
}

/** Points for a word heard as written, and as nearly written; short words are said everywhere. */
const LONG_WORD = 4;
const MATCH = 3;
const NEAR_MATCH = 2;
const SHORT_MATCH = 1;
/** Points lost for a word that differs, and for one only the script or only the speech has. */
const MISMATCH = -1;
const GAP = -1;
/** How many letters in ten may differ in nearly the same word. */
const NEAR_TENTHS = 3;
/** Only the last few words heard count: what came before is where the speaker was, not where they are. */
const LATEST_WORDS = 8;
/** How far ahead of and behind the speaker reading on still counts: this is paraphrasing. */
const AHEAD = 12;
const BEHIND = 6;
/** Points of agreement it takes to read on (about two words), and to jump (three in a row). */
const MIN_NEAR = 5;
const MIN_JUMP = 9;

function comparable(word: string): string {
  return word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\p{M}'’]/gu, "");
}

/** The words of `text`, in any language: some scripts put no spaces between them. */
function words(text: string): Word[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  return [...segmenter.segment(text)]
    .filter((s) => s.isWordLike)
    .map((s) => ({ start: s.index, end: s.index + s.segment.length, form: comparable(s.segment) }));
}

export function toScript(text: string): Script {
  return { text, words: words(text) };
}

export function startTrack(script: Script): Track {
  return { position: 0, said: script.words.map(() => false) };
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const change = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      row[j] = Math.min(change, previous[j]! + 1, row[j - 1]! + 1);
    }
    previous = row;
  }
  return previous[b.length]!;
}

/** What it is worth that `a` and `b` are the same word; 0 when they aren't. */
function wordPoints(a: string, b: string): number {
  const length = Math.max(a.length, b.length);
  if (a === b) return length < LONG_WORD ? SHORT_MATCH : MATCH;
  if (length < LONG_WORD || Math.abs(a.length - b.length) * 10 > length * NEAR_TENTHS) return 0;
  return editDistance(a, b) * 10 <= length * NEAR_TENTHS ? NEAR_MATCH : 0;
}

/** The stretch of the script the words heard last agree with best; indices of its first and last word. */
function align(script: string[], heard: string[], position: number): { first: number; last: number } | null {
  const scores = heard.map(() => new Array<number>(script.length).fill(0));
  const at = (i: number, j: number) => (i < 0 || j < 0 ? 0 : scores[i]![j]!);
  let best: { i: number; j: number; rank: number } | null = null;
  for (let i = 0; i < heard.length; i++) {
    for (let j = 0; j < script.length; j++) {
      const points = wordPoints(heard[i]!, script[j]!);
      const score = Math.max(0, at(i - 1, j - 1) + (points || MISMATCH), at(i - 1, j) + GAP, at(i, j - 1) + GAP);
      scores[i]![j] = score;
      if (!points) continue;
      const near = j >= position - BEHIND && j <= position + AHEAD;
      if (score < (near ? MIN_NEAR : MIN_JUMP)) continue;
      // Reading on wins a tie, then what is closest, so a repeated phrase stays where it was.
      const rank = (near ? MIN_JUMP : 0) + score - Math.abs(j - position) / script.length;
      if (!best || rank > best.rank) best = { i, j, rank };
    }
  }
  if (!best) return null;
  let { i, j } = best;
  let first = j;
  while (i >= 0 && j >= 0 && at(i, j) > 0) {
    const score = at(i, j);
    const points = wordPoints(heard[i]!, script[j]!);
    if (score === at(i - 1, j - 1) + (points || MISMATCH)) {
      if (points) first = j;
      i--;
      j--;
    } else if (score === at(i - 1, j) + GAP) i--;
    else j--;
  }
  return { first, last: best.j };
}

/** `track` moved on by what was just heard; `track` itself when that says nothing new. */
export function follow(script: Script, track: Track, heard: string): Track {
  const match = align(
    script.words.map((w) => w.form),
    words(heard)
      .slice(-LATEST_WORDS)
      .map((w) => w.form),
    track.position,
  );
  if (!match) return track;
  const { first, last } = match;
  const readingOn = last >= track.position - BEHIND && last <= track.position + AHEAD;
  // Reading on, a word recognition missed was still said. Having jumped, what's between wasn't.
  const from = readingOn ? Math.min(first, track.position) : first;
  const position = readingOn ? Math.max(track.position, last + 1) : last + 1;
  const covered = track.said.slice(from, last + 1).every(Boolean);
  if (covered && position === track.position) return track;
  return { position, said: track.said.map((said, i) => said || (i >= from && i <= last)) };
}

/** The script cut up into stretches said and not, with the last word said on its own. */
export function pieces(script: Script, track: Track): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  const add = (end: number, said: boolean, current = false) => {
    if (end <= at) return;
    const text = script.text.slice(at, end);
    const last = out[out.length - 1];
    if (last && last.said === said && !last.current && !current) last.text += text;
    else out.push({ text, said, current });
    at = end;
  };
  script.words.forEach((word, i) => {
    const said = track.said[i] ?? false;
    // The highlight runs on through the space between two words said.
    add(word.start, said && i > 0 && track.said[i - 1] === true);
    add(word.end, said, i === track.position - 1);
  });
  add(script.text.length, false);
  return out;
}
