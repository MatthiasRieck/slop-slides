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

/**
 * What an empty message says when it goes out for the review alone: the comments (`comments` of
 * them) and the sketch sent along with it are for the agent to address. Null with nothing to
 * address, when an empty message is not sent.
 */
export function reviewPrompt(comments: number, sketch: boolean): string | null {
  const items = [comments > 0 && (comments === 1 ? "the comment" : "the comments"), sketch && "the sketch"];
  const named = items.filter(Boolean);
  return named.length > 0 ? `Please address ${named.join(" and ")}.` : null;
}
