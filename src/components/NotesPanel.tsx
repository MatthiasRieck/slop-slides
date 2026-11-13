import { useRef, useState } from "react";

import type { Deck, Slide } from "../lib/api";
import { useDraftText } from "../lib/useDraftText";
import { useApp } from "../store";
import { ScriptField } from "./ScriptMarkdown";
import { SlideBand, SlideBandHeader } from "./SlideBand";

/** How long typing pauses before the notes are saved to the deck. */
export const NOTES_SAVE_DELAY = 800;

/**
 * The sidebar's Notes tab: the speaker notes of the current slide, to view and edit, in Markdown. Only the presenter sees them, in the show's presenter view.
 */
export function NotesPanel() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const index = deck?.slides.findIndex((s) => s.id === selected) ?? -1;
  const slide = deck?.slides[index];
  const [preview, setPreview] = useState(false);
  return (
    <SlideBand label="Speaker notes" noun="notes" deck={deck} slide={slide}>
      {(deck, slide) => (
        // One editor per slide: switching slides saves the last one's pending text as it unmounts.
        <NotesEditor key={slide.id} deck={deck} slide={slide} index={index} preview={preview} onPreview={setPreview} />
      )}
    </SlideBand>
  );
}

function NotesEditor(props: {
  deck: Deck;
  slide: Slide;
  index: number;
  preview: boolean;
  onPreview: (preview: boolean) => void;
}) {
  const { deck, slide, index, preview } = props;
  // The notes save by themselves; the header says when they are on their way and when they are in.
  const [saving, setSaving] = useState<"saving" | "saved" | null>(null);
  /** Counts the changes, so a save that an edit has overtaken does not say "Saved". */
  const typed = useRef(0);
  const { draft, change, flush } = useDraftText(slide.notes ?? "", NOTES_SAVE_DELAY, async (text) => {
    const at = typed.current;
    await useApp.getState().setNotes(slide.id, text);
    if (typed.current === at) setSaving("saved");
  });
  const edit = (text: string) => {
    typed.current++;
    setSaving("saving");
    change(text);
  };
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-2 p-3">
      <SlideBandHeader
        slide={slide}
        index={index}
        total={deck.slides.length}
        preview={preview}
        onPreview={props.onPreview}
      >
        {saving && (
          <span role="status" className="shrink-0 text-2xs text-muted-foreground">
            {saving === "saving" ? "Saving…" : "Saved"}
          </span>
        )}
      </SlideBandHeader>
      <ScriptField
        label="Speaker notes"
        draft={draft}
        preview={preview}
        readOnly={!!slide.locked}
        onChange={edit}
        onBlur={() => void flush()}
        placeholder={slide.locked ? "No notes." : "What to remember while this slide is shown…"}
      />
    </div>
  );
}
