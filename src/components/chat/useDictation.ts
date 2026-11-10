import { type RefObject, useState } from "react";

import { insertTranscript } from "../../lib/voice";
import type { DictationHandlers } from "../VoiceInput";

/**
 * Dictation into the composer's `draft`. It goes in at the caret (or in place of the selection),
 * which the textarea keeps while the microphone button has focus. While it runs, the text so far
 * shows in place (`shownDraft`); once it ends it is kept, or sent with `send` when asked to.
 */
export function useDictation(props: {
  draft: string;
  setDraft: (text: string) => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
  send: (text: string) => void;
}) {
  const { draft, setDraft, textarea, send } = props;
  const [dictation, setDictation] = useState<{ start: number; end: number; text: string } | null>(null);
  const dictated = (text: string) =>
    dictation ? insertTranscript(draft, text, dictation.start, dictation.end) : { draft, caret: draft.length };
  const shownDraft = dictation?.text ? dictated(dictation.text).draft : draft;
  const handlers: DictationHandlers = {
    onStart: () => {
      const el = textarea.current;
      setDictation({ start: el?.selectionStart ?? draft.length, end: el?.selectionEnd ?? draft.length, text: "" });
    },
    onPartial: (text: string) => setDictation((d) => d && { ...d, text }),
    onEnd: (text: string, sendNow: boolean) => {
      setDictation(null);
      const result = text && dictation ? dictated(text) : null;
      if (!result && !sendNow) return;
      if (result) setDraft(result.draft);
      if (sendNow) send(result?.draft ?? draft);
      requestAnimationFrame(() => {
        textarea.current?.focus();
        if (result && !sendNow) textarea.current?.setSelectionRange(result.caret, result.caret);
      });
    },
  };
  /** Where the end of the dictated text so far is in the shown draft, while there is some. */
  const caret = dictation?.text ? dictated(dictation.text).caret : null;
  return { dictating: dictation !== null, shownDraft, caret, handlers };
}
