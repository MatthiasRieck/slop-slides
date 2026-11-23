import { AudioLines, Sparkles, Timer, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";

import type { Deck } from "../../lib/api";
import { canSpeakWith, deckProvider, useNarration } from "../../narrationStore";
import { useApp } from "../../store";
import { useDeckAudio } from "./useDeckAudio";

/** How far along `done` of `total` is, in percent, for a progress bar. */
const percentDone = (done: number, total: number) => Math.min(100, Math.round((100 * done) / total));

/** Has the agent make clean, fluent scripts of the whole deck's recorded words. */
export function CleanUpAll({ deck }: { deck: Deck }) {
  if (!deck.slides.some((s) => s.narration && !s.locked)) return null;
  return (
    <div className="border-t p-3">
      <Button
        variant="outline"
        size="xs"
        onClick={() => useApp.getState().cleanNarration(null)}
        tooltip="Puts a request in the chat, for the agent to turn the recorded words of all slides into clean, fluent sentences. It opens the chat; you send it."
      >
        <Sparkles data-icon="inline-start" />
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
      <div className="flex flex-col gap-2 border-t p-3 text-xs">
        <div className="flex items-center justify-between gap-2" role="status">
          <span className="flex min-w-0 items-center gap-1">
            <Spinner aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">
              Generating audio for slide {render.done + 1} of {render.total}…
            </span>
          </span>
          <Button variant="outline" size="xs" onClick={() => void useNarration.getState().cancelRender()}>
            <X data-icon="inline-start" />
            Cancel
          </Button>
        </div>
        <Progress aria-label="Audio generated" value={percentDone(render.done, render.total)} />
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
        variant="outline"
        size="xs"
        disabled={render !== null}
        onClick={() => void useNarration.getState().renderAudio(deck.id, null)}
      >
        <AudioLines data-icon="inline-start" />
        Generate all
      </Button>
    </div>
  );
}

/**
 * Syncing the words to the audio: hearing the deck's narration audio again with the
 * speech-to-text model, to know when each word is said. That is what timing animations and slide
 * changes to the narration goes by.
 */
export function WordTiming({ deck }: { deck: Deck }) {
  const audio = useDeckAudio(deck.id);
  const timing = useNarration((s) => s.timing);
  const render = useNarration((s) => s.render);
  if (timing?.deck === deck.id) {
    const label = timing.downloading
      ? "Downloading the speech model…"
      : timing.total > 0
        ? `Syncing words of slide ${timing.done + 1} of ${timing.total}…`
        : "Syncing words to audio…";
    return (
      <div className="flex flex-col gap-2 border-t p-3 text-xs">
        <div className="flex min-w-0 items-center gap-1" role="status">
          <Spinner aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </div>
        {/* How many slides are through; while the model downloads or nothing is counted yet, only that it runs. */}
        <Progress
          aria-label="Words synced"
          value={!timing.downloading && timing.total > 0 ? percentDone(timing.done, timing.total) : null}
        />
      </div>
    );
  }
  const untimed = deck.slides.filter((s) => audio[s.id]?.state === "ready" && !audio[s.id]?.timed).length;
  if (untimed === 0) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t p-3 text-xs">
      <span className="text-muted-foreground">
        {untimed} {untimed === 1 ? "slide's words are" : "slides' words are"} not synced to the audio
      </span>
      <Button
        variant="outline"
        size="xs"
        disabled={timing !== null || render !== null}
        onClick={() => void useNarration.getState().timeWords(deck.id, null)}
        tooltip="Find when each word is said in the audio, by listening to it with the speech-to-text model on this computer. Animations and slide changes can then follow the words."
      >
        <Timer data-icon="inline-start" />
        Sync words to audio
      </Button>
    </div>
  );
}
