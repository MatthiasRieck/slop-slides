import { useEffect, useState } from "react";

import { useApp } from "../../store";
import { appendDraft } from "./draft";

/**
 * The text being written in the composer, which is the composer's own: each key pressed changes
 * it, and nothing but the composer shows it. Other parts of the app (the lint status, a
 * suggestion of the empty chat) can hand over a prepared message, which goes after what is typed
 * already. Taken, it is the composer's: it does not come again when the chat is shown the next time.
 */
export function useComposerDraft() {
  const [draft, setDraft] = useState("");
  const fill = useApp((s) => s.composerFill);
  useEffect(() => {
    if (!fill) return;
    if (fill.text) setDraft((typed) => appendDraft(typed, fill.text));
    useApp.getState().clearComposerFill();
  }, [fill]);
  return [draft, setDraft] as const;
}
