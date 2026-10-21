/** `draft` with `text` put in place of its selection, spaced from the words around it. */
export function insertTranscript(draft: string, text: string, start = draft.length, end = start): { draft: string; caret: number } {
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
