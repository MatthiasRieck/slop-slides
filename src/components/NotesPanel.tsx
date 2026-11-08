import { useState } from "react";

import type { Deck, Slide } from "../lib/api";
import { useDraftText } from "../lib/useDraftText";
import { useApp } from "../store";
import { ScriptField } from "./ScriptMarkdown";
import { SlidePanel, SlidePanelHeader } from "./SlidePanel";

/** How long typing pauses before the notes are saved to the deck. */
export const NOTES_SAVE_DELAY = 800;

/**
 * The Notes tab of the right sidebar: the speaker notes of the selected slide, to view and edit,
 * in Markdown. Only the presenter sees them, in the show's presenter view.
 */
export function NotesPanel() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const index = deck?.slides.findIndex((s) => s.id === selected) ?? -1;
  const slide = deck?.slides[index];
  const [preview, setPreview] = useState(false);
  return (
    <SlidePanel label="Speaker notes" noun="notes" deck={deck} slide={slide}>
      {(deck, slide) => (
        // One editor per slide: switching slides saves the last one's pending text as it unmounts.
        <NotesEditor key={slide.id} deck={deck} slide={slide} index={index} preview={preview} onPreview={setPreview} />
      )}
    </SlidePanel>
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
  const { draft, change, flush } = useDraftText(slide.notes ?? "", NOTES_SAVE_DELAY, (text) =>
    useApp.getState().setNotes(slide.id, text),
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-3">
      <SlidePanelHeader
        slide={slide}
        index={index}
        total={deck.slides.length}
        preview={preview}
        onPreview={props.onPreview}
      />
      <ScriptField
        label="Speaker notes"
        draft={draft}
        preview={preview}
        readOnly={!!slide.locked}
        onChange={change}
        onBlur={() => void flush()}
        placeholder={slide.locked ? "No notes." : "What to remember while this slide is shown…"}
      />
    </div>
  );
}
