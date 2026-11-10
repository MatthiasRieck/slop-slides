import { AudioLines, Loader2, Sparkles, Timer, X } from "lucide-react";

import type { Deck } from "../../lib/api";
import { canSpeakWith, deckProvider, useNarration } from "../../narrationStore";
import { useApp } from "../../store";
import { Button } from "../Button";
import { useDeckAudio } from "./useDeckAudio";

/** Has the agent make clean, fluent scripts of the whole deck's recorded words. */
export function CleanUpAll({ deck }: { deck: Deck }) {
  if (!deck.slides.some((s) => s.narration && !s.locked)) return null;
  return (
    <div className="border-t p-3">
      <Button
        size="md"
        onClick={() => useApp.getState().cleanNarration(null)}
        title="Ask the agent to turn the recorded words of all slides into clean, fluent sentences"
      >
        <Sparkles />
        Clean up all narration
      </Button>
    </div>
  );
}

/** The deck's narration as a whole: how much needs speaking, and the render running. */
export function DeckAudio({ deck }: { deck: Deck }) {
  const audio = useDeckAudio(deck.id);
  const speech = useNarration((s) => s.speech);
  const render = useNarration((s) => s.render);
  const pending = deck.slides.filter((s) => {
    const state = audio[s.id]?.state;
    return state === "missing" || state === "stale";
  }).length;
  const canSpeak = canSpeakWith(speech, speech ? deckProvider(deck, speech) : undefined);
  if (render?.deck === deck.id && render.total > 0) {
    return (
      <div className="flex items-center justify-between gap-2 border-t p-3 text-xs" role="status">
        <span className="flex min-w-0 items-center gap-1">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <span className="truncate">
            Speaking slide {render.done + 1} of {render.total}…
          </span>
        </span>
        <Button size="md" onClick={() => void useNarration.getState().cancelRender()}>
          <X />
          Cancel
        </Button>
      </div>
    );
  }
  if (!canSpeak || pending === 0) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t p-3 text-xs">
      <span className="text-muted-foreground">
        {pending} {pending === 1 ? "slide needs" : "slides need"} audio
      </span>
      <Button
        size="md"
        disabled={render !== null}
        onClick={() => void useNarration.getState().renderAudio(deck.id, null)}
      >
        <AudioLines />
        Generate all
      </Button>
    </div>
  );
}

/**
 * Hearing the deck's narration audio again with the speech-to-text model, to know when each
 * word is said: what timing animations and slide changes to the narration goes by.
 */
export function WordTiming({ deck }: { deck: Deck }) {
  const audio = useDeckAudio(deck.id);
  const timing = useNarration((s) => s.timing);
  const render = useNarration((s) => s.render);
  if (timing?.deck === deck.id) {
    const label = timing.downloading
      ? "Downloading the speech model…"
      : timing.total > 0
        ? `Timing words of slide ${timing.done + 1} of ${timing.total}…`
        : "Timing words…";
    return (
      <div className="flex min-w-0 items-center gap-1 border-t p-3 text-xs" role="status">
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        <span className="truncate">{label}</span>
      </div>
    );
  }
  const untimed = deck.slides.filter((s) => audio[s.id]?.state === "ready" && !audio[s.id]?.timed).length;
  if (untimed === 0) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t p-3 text-xs">
      <span className="text-muted-foreground">
        {untimed} {untimed === 1 ? "slide's words" : "slides' words"} not timed
      </span>
      <Button
        size="md"
        disabled={timing !== null || render !== null}
        onClick={() => void useNarration.getState().timeWords(deck.id, null)}
        title="Listen to the narration audio with the speech-to-text model to find when each word is said"
      >
        <Timer />
        Time words
      </Button>
    </div>
  );
}
