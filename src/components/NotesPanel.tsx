import { Lock } from "lucide-react";

import type { Deck, Slide } from "../lib/api";
import { useDraftText } from "../lib/useDraftText";
import { useApp } from "../store";

/** How long typing pauses before the notes are saved to the deck. */
export const NOTES_SAVE_DELAY = 800;

/**
 * Notes mode's tools, in a band above the slide: the speaker notes of the current slide, to view
 * and edit. Only the presenter sees them, in the show's presenter view.
 */
export function NotesPanel() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const index = deck?.slides.findIndex((s) => s.id === selected) ?? -1;
  const slide = deck?.slides[index];
  if (!deck || !slide) {
    return (
      <p className="shrink-0 border-b bg-background p-4 text-sm text-muted-foreground">
        {deck ? "Add a slide to write its notes." : "Open a deck to write notes for its slides."}
      </p>
    );
  }
  return (
    <section aria-label="Speaker notes" className="flex h-52 shrink-0 justify-center border-b bg-background">
      {/* One editor per slide: switching slides saves the last one's pending text as it unmounts. */}
      <NotesEditor key={slide.id} deck={deck} slide={slide} index={index} />
    </section>
  );
}

function NotesEditor(props: { deck: Deck; slide: Slide; index: number }) {
  const { deck, slide, index } = props;
  const { draft, change, flush } = useDraftText(slide.notes ?? "", NOTES_SAVE_DELAY, (text) =>
    useApp.getState().setNotes(slide.id, text),
  );
  return (
    <div className="flex min-w-0 max-w-3xl flex-1 flex-col gap-2 p-3">
      <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          Slide {index + 1} of {deck.slides.length} · <span className="font-mono">{slide.id}</span>
        </span>
        {slide.locked && (
          <span className="flex shrink-0 items-center gap-1">
            <Lock className="size-3" />
            Locked
          </span>
        )}
      </div>
      <textarea
        aria-label="Speaker notes"
        value={draft}
        readOnly={slide.locked}
        onChange={(event) => change(event.target.value)}
        onBlur={() => void flush()}
        placeholder={slide.locked ? "No notes." : "What to remember while this slide is shown…"}
        className="selectable min-h-0 flex-1 resize-none rounded-md border bg-card p-3 text-sm leading-relaxed outline-none focus:border-primary"
      />
    </div>
  );
}
