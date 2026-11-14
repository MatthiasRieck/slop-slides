import { useEffect, useState } from "react";

import { useApp } from "../../store";
import { appendDraft } from "./draft";

/** A sent message being edited in the composer, and the draft it took the place of. */
export interface Editing {
  /** The id of the sent message. */
  id: string;
  /** What was being written before; it comes back when the edit is given up. */
  before: string;
}

/**
 * The text being written in the composer, which is the composer's own: each key pressed changes
 * it, and nothing but the composer shows it. It starts from `initial`, the draft the chat had
 * when it was last on show. Other parts of the app (the lint status, a suggestion of the empty
 * chat) can hand over a prepared message, which goes after what is typed already; a sent message
 * handed over to be edited takes the draft's place instead, until it is sent or given up
 * (`cancelEdit`). Taken, it is the composer's: it does not come again when the chat is shown the
 * next time.
 */
export function useComposerDraft(initial = "") {
  const [draft, setDraft] = useState(initial);
  const [editing, setEditing] = useState<Editing | null>(null);
  const fill = useApp((s) => s.composerFill);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a message is handed over
  useEffect(() => {
    if (!fill) return;
    if (fill.edit) {
      const id = fill.edit;
      setEditing((was) => ({ id, before: was ? was.before : draft }));
      setDraft(fill.text);
    } else if (fill.text) {
      setDraft((typed) => appendDraft(typed, fill.text));
    }
    useApp.getState().clearComposerFill();
  }, [fill]);
  const cancelEdit = () => {
    if (!editing) return;
    setDraft(editing.before);
    setEditing(null);
  };
  return { draft, setDraft, editing, cancelEdit, endEdit: () => setEditing(null) };
}
