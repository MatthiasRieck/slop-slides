import { NotebookText } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Deck, Slide } from "../lib/api";
import { markdownText } from "../lib/markdown";
import { speakingTime, wordCount } from "../lib/narration";
import { useDraftText } from "../lib/useDraftText";
import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { Button } from "./Button";
import {
  AgentMark,
  DeckAudio,
  DeckScripts,
  NarrationOverview,
  POLISH_TIP,
  WordTiming,
} from "./narration/DeckNarration";
import { SlideAudioControls } from "./narration/SlideAudio";
import { SpeechSettings } from "./narration/SpeechSettings";
import { ScriptField } from "./ScriptMarkdown";
import { SlideBand, SlideBandHeader } from "./SlideBand";
import { SlideTime } from "./SlideTime";

/** How long typing pauses before the narration is saved to the deck. */
export const NARRATION_SAVE_DELAY = 800;
/**
 * The sidebar's Narration tab: what is said over the current slide, to write, record, generate
 * and hear, and under it what belongs to the whole deck: every slide's narration at a glance, the
 * voice that says it, and what is still to generate or sync. Playing the whole deck on its
 * timeline is a mode of its own, Play (see NarrationTimeline).
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
          <section aria-label="Whole deck" className="mx-auto flex w-full max-w-3xl shrink-0 flex-col border-t">
            <h3 className="px-3 pt-2.5 pb-1 text-2xs font-medium text-muted-foreground">Whole deck</h3>
            <SpeechSettings deck={deck} />
            <DeckAudio deck={deck} />
            <WordTiming deck={deck} />
            <DeckScripts deck={deck} />
            <NarrationOverview deck={deck} selected={slide.id} />
          </section>
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
  // The script saves by itself; the header says when it is on its way and when it is in.
  const [saving, setSaving] = useState<"saving" | "saved" | null>(null);
  /** Counts the changes, so a save that an edit has overtaken does not say "Saved". */
  const typed = useRef(0);
  const { draft, change, flush } = useDraftText(slide.narration ?? "", NARRATION_SAVE_DELAY, async (text) => {
    const at = typed.current;
    await useApp.getState().setNarration(slide.id, text);
    if (typed.current === at) setSaving("saved");
  });
  const edit = (text: string) => {
    typed.current++;
    setSaving("saving");
    change(text);
  };
  const polish = async () => {
    await flush();
    useApp.getState().cleanNarration(slide.id);
  };

  // Only the words are said, not the Markdown around them.
  const spoken = markdownText(draft);
  const words = wordCount(spoken);
  const hasText = draft.trim() !== "";
  const notes = (slide.notes ?? "").trim();
  return (
    <div className="mx-auto flex min-h-64 w-full max-w-3xl flex-1 flex-col gap-2 p-3">
      <SlideBandHeader slide={slide} index={index} total={total} preview={preview} onPreview={props.onPreview}>
        {saving && (
          <span role="status" className="shrink-0 text-2xs text-muted-foreground">
            {saving === "saving" ? "Saving…" : "Saved"}
          </span>
        )}
        <span className="ml-auto shrink-0 tabular-nums">
          {words} {words === 1 ? "word" : "words"} ·{" "}
          <span title="About how long the script takes to say, at 150 words per minute">
            ~{speakingTime(spoken)} to say
          </span>
        </span>
        <SlideTime deck={deck} />
      </SlideBandHeader>
      {/* The audio above the words it says: its waveform, to hear, to record and to make again. */}
      <SlideAudioControls deck={deck} slide={slide.id} hasText={hasText} locked={!!slide.locked} flush={flush} />
      <ScriptField
        label="Narration"
        draft={draft}
        preview={preview}
        readOnly={!!slide.locked}
        onChange={edit}
        onBlur={() => void flush()}
        placeholder={slide.locked ? "No narration." : "What is said while this slide is shown…"}
      />
      {!slide.locked && (hasText || notes !== "") && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {!hasText && (
            <Button
              size="md"
              onClick={() => edit(slide.notes ?? "")}
              title="Copies this slide's speaker notes into its script, to say as they are or to rework. The notes stay."
            >
              <NotebookText />
              Use speaker notes as script
            </Button>
          )}
          {hasText && (
            <Button size="md" variant="ghost" onClick={() => void polish()} title={POLISH_TIP}>
              <AgentMark />
              Polish wording…
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
