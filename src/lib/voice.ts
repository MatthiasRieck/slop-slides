/** `draft` with `text` put in place of its selection, spaced from the words around it. */
export function insertTranscript(
  draft: string,
  text: string,
  start = draft.length,
  end = start,
): { draft: string; caret: number } {
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const inserted = lead + text + trail;
  return { draft: before + inserted + after, caret: before.length + lead.length + text.length };
}

/** A byte count as a short size, like `190 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** Width of a waveform bar, in CSS pixels. */
export const WAVEFORM_BAR = 2;
/** Distance from one waveform bar to the next, in CSS pixels. */
export const WAVEFORM_STEP = 4;

/**
 * Where to draw the waveform's bars. `levels` runs oldest to newest (each 0 to 1); the newest
 * sits at the right edge and the rest trail off to the left, fading out, with `scroll` (0 to 1)
 * being how far they have moved towards their next position.
 */
export function waveformBars(
  levels: number[],
  width: number,
  height: number,
  scroll = 0,
): { x: number; height: number; opacity: number }[] {
  const bars: { x: number; height: number; opacity: number }[] = [];
  levels.forEach((level, i) => {
    const x = width - WAVEFORM_BAR / 2 - (levels.length - 1 - i + scroll) * WAVEFORM_STEP;
    if (x < 0) return;
    // Square root, so quiet speech still moves; even silence leaves a dot.
    const bar = WAVEFORM_BAR + Math.sqrt(Math.min(level, 1)) * (height - WAVEFORM_BAR);
    bars.push({ x, height: bar, opacity: Math.min(1, (x / width) * 1.5) });
  });
  return bars;
}
