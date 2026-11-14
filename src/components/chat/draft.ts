/**
 * The composer's draft once `text` is handed to it: after what is typed already, a blank line
 * between them, so that nothing typed is lost. Text the draft already ends with is not added again.
 */
export function appendDraft(draft: string, text: string): string {
  const typed = draft.trimEnd();
  if (!typed.trim()) return text;
  if (!text.trim() || typed.endsWith(text.trim())) return draft;
  return `${typed}\n\n${text}`;
}
