import { useEffect, useState } from "react";

import type { Deck, Slide } from "../lib/api";
import { markdownText } from "../lib/markdown";
import { speakingTime, wordCount } from "../lib/narration";
import { useDraftText } from "../lib/useDraftText";
import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { CleanUpAll, DeckAudio, WordTiming } from "./narration/DeckNarration";
import { SlideAudioControls } from "./narration/SlideAudio";
import { SpeechSettings } from "./narration/SpeechSettings";
import { ScriptField } from "./ScriptMarkdown";
import { SlideBand, SlideBandHeader } from "./SlideBand";
import { SlideTime } from "./SlideTime";

/** How long typing pauses before the narration is saved to the deck. */
export const NARRATION_SAVE_DELAY = 800;
/**
 * The sidebar's Narration tab: what is said over the current slide, to view, edit and hear, with
 * the deck's voice under it. Playing the whole deck on its timeline is a mode of its own, Play (see
 * NarrationTimeline).
 */
export function NarrationPanel() {
  const [preview, setPreview] = useState(false);
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const loadSpeech = useNarration((s) => s.loadSpeech);
  useEffect(() => {
    void loadSpeech();
  }, [loadSpeech]);
  const index = deck?.slides.findIndex((s) => s.id === selected) ?? -1;
  const slide = deck?.slides[index];
  return (
    <SlideBand label="Narration tools" noun="narration" deck={deck} slide={slide}>
      {(deck, slide) => (
        <>
          {/* One editor per slide: switching slides saves the last one's pending text as it unmounts. */}
          <NarrationEditor
            key={slide.id}
            deck={deck}
            slide={slide}
            index={index}
            total={deck.slides.length}
            preview={preview}
            onPreview={setPreview}
          />
          <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col border-t">
            <SpeechSettings deck={deck} />
            <CleanUpAll deck={deck} />
            <DeckAudio deck={deck} />
            <WordTiming deck={deck} />
          </div>
        </>
      )}
    </SlideBand>
  );
}

function NarrationEditor(props: {
  deck: Deck;
  slide: Slide;
  index: number;
  total: number;
  preview: boolean;
  onPreview: (preview: boolean) => void;
}) {
  const { deck, slide, index, total, preview } = props;
  const { draft, change, flush } = useDraftText(slide.narration ?? "", NARRATION_SAVE_DELAY, (text) =>
    useApp.getState().setNarration(slide.id, text),
  );

  // Only the words are said, not the Markdown around them.
  const spoken = markdownText(draft);
  const words = wordCount(spoken);
  return (
    <div className="mx-auto flex min-h-64 w-full max-w-3xl flex-1 flex-col gap-2 p-3">
      <SlideBandHeader slide={slide} index={index} total={total} preview={preview} onPreview={props.onPreview}>
        <span className="ml-auto shrink-0 tabular-nums">
          {words} {words === 1 ? "word" : "words"} ·{" "}
          <span title="Estimated at 150 words per minute">~{speakingTime(spoken)}</span>
        </span>
        <SlideTime deck={deck} />
      </SlideBandHeader>
      {/* The audio above the words it says: its waveform, to hear and to make again. */}
      <SlideAudioControls
        deck={deck}
        slide={slide.id}
        hasText={draft.trim() !== ""}
        locked={!!slide.locked}
        flush={flush}
      />
      <ScriptField
        label="Narration"
        draft={draft}
        preview={preview}
        readOnly={!!slide.locked}
        onChange={change}
        onBlur={() => void flush()}
        placeholder={slide.locked ? "No narration." : "What is said while this slide is shown…"}
      />
    </div>
  );
}
