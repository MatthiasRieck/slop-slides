import { ask } from "@tauri-apps/plugin-dialog";
import { AudioLines, Loader2, Play, Sparkles, Square, Trash2 } from "lucide-react";
import { type MouseEvent, useEffect, useRef, useState } from "react";

import { type Deck, errorMessage, type SlideAudio } from "../../lib/api";
import { formatDuration, type Playback, playNarration } from "../../lib/narrationAudio";
import { cn } from "../../lib/utils";
import { canSpeakWith, deckProvider, useNarration } from "../../narrationStore";
import { useApp } from "../../store";
import { Button } from "../Button";
import { usePeaks, useWords, Waveform, Words } from "../NarrationWave";

/** How often the waveform's playhead moves while the audio plays, in ms. */
const PLAYHEAD_TICK = 50;
/** How wide a second of audio is at least once its words are shown, in pixels, so they can be read. */
const WORDS_SECOND_WIDTH = 80;

/**
 * The slide's audio as its waveform, with when each word is said once that is known. Pressing
 * it plays the audio from there; a line shows where it is while it plays. With words, it is as
 * wide as they need and scrolls, following the line.
 */
function SlideWave(props: {
  deck: string;
  slide: string;
  audio: SlideAudio;
  seconds: number;
  playback: Playback | null;
  onPlay: (from: number) => void;
}) {
  const { deck, slide, audio, seconds, playback } = props;
  const peaks = usePeaks(deck, slide, audio);
  const words = useWords(deck, slide, audio);
  const [at, setAt] = useState<number | null>(null);
  const playhead = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!playback) return setAt(null);
    const tick = () => setAt(Math.min(seconds, playback.time()));
    tick();
    const ticking = setInterval(tick, PLAYHEAD_TICK);
    return () => clearInterval(ticking);
  }, [playback, seconds]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The line moves with the time.
  useEffect(() => {
    playhead.current?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [at]);
  const press = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    props.onPlay(Math.min(seconds, Math.max(0, ((event.clientX - box.left) / (box.width || 1)) * seconds)));
  };
  const stale = audio.state === "stale";
  return (
    <div className="overflow-x-auto overflow-y-hidden rounded-md border">
      <button
        type="button"
        aria-label={stale ? "Narration audio, out of date" : "Narration audio"}
        title="Press to play from there"
        onClick={press}
        className={cn(
          "relative block h-16 min-w-full cursor-pointer bg-primary/15 text-primary",
          stale && "text-muted-foreground",
        )}
        style={words.length > 0 ? { width: seconds * WORDS_SECOND_WIDTH } : undefined}
      >
        {peaks.length > 0 && <Waveform peaks={peaks} />}
        {words.length > 0 && <Words words={words} seconds={seconds} />}
        {at !== null && (
          <span
            ref={playhead}
            data-testid="wave-playhead"
            className="pointer-events-none absolute inset-y-0 w-px bg-destructive"
            style={{ left: `${(at / seconds) * 100}%` }}
          />
        )}
      </button>
    </div>
  );
}

/** What the slide's audio is: its waveform, and buttons to hear it and to (re)make it. */
export function SlideAudioControls(props: {
  deck: Deck;
  slide: string;
  hasText: boolean;
  locked: boolean;
  flush: () => Promise<void>;
}) {
  const { deck, slide } = props;
  const audio = useNarration((s) => (s.audioDeck === deck.id ? s.audio[slide] : undefined));
  const speech = useNarration((s) => s.speech);
  const render = useNarration((s) => s.render);
  const [playback, setPlayback] = useState<Playback | null>(null);
  useEffect(() => () => playback?.stop(), [playback]);

  const provider = speech ? deckProvider(deck, speech) : undefined;
  const canSpeak = canSpeakWith(speech, provider);
  const generate = async () => {
    playback?.stop();
    await props.flush();
    await useNarration.getState().renderAudio(deck.id, [slide]);
  };
  const play = async (from?: number) => {
    // Pressed on the waveform, it starts over from there; the button stops what plays.
    playback?.stop();
    if (playback && from === undefined) return;
    try {
      const started = await playNarration(deck.id, slide, from ?? 0);
      setPlayback(started);
      void started.ended.then(() => setPlayback((p) => (p === started ? null : p)));
    } catch (error) {
      useApp.getState().setError(`Could not play the narration: ${errorMessage(error)}`);
    }
  };
  const clean = async () => {
    await props.flush();
    useApp.getState().cleanNarration(slide);
  };
  const remove = async () => {
    playback?.stop();
    if (await confirmDelete(!!audio?.imported)) await useNarration.getState().deleteRecording(deck.id, slide);
  };
  const recorded = !!audio?.recorded;
  if (!props.hasText && !recorded) return null;
  const busy = render?.slide === slide || (render !== null && render.slide === null && render.deck === deck.id);
  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      {audio?.seconds != null && audio.seconds > 0 && (
        <SlideWave
          deck={deck.id}
          slide={slide}
          audio={audio}
          seconds={audio.seconds}
          playback={playback}
          onPlay={(from) => void play(from)}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
          {busy ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Speaking…
            </>
          ) : (
            audioLabel(audio)
          )}
        </span>
        <div className="flex shrink-0 gap-1">
          {props.hasText && !props.locked && (
            <Button
              size="md"
              onClick={() => void clean()}
              title="Ask the agent to turn this slide's recorded words into clean, fluent sentences"
            >
              <Sparkles />
              Clean up
            </Button>
          )}
          <Button
            size="md"
            disabled={!audio?.seconds || busy}
            onClick={() => void play()}
            title={audio?.state === "stale" ? "Play the out-of-date audio" : "Play the audio"}
          >
            {playback ? <Square /> : <Play />}
            {playback ? "Stop" : "Play"}
          </Button>
          {recorded ? (
            <Button
              size="md"
              disabled={props.locked}
              onClick={() => void remove()}
              title={
                audio?.imported ? "Remove the audio brought in for this slide" : "Delete your recording of this slide"
              }
            >
              <Trash2 />
              {audio?.imported ? "Remove audio" : "Delete recording"}
            </Button>
          ) : (
            <Button
              size="md"
              disabled={!canSpeak || render !== null}
              onClick={() => void generate()}
              title={
                canSpeak
                  ? "Speak this slide's narration"
                  : `Add your ${provider?.name ?? "narration service's"} API key first`
              }
            >
              <AudioLines />
              {audio?.state === "ready" ? "Regenerate" : "Generate"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function audioLabel(audio: SlideAudio | undefined): string {
  if (!audio || audio.state === "missing" || audio.state === "none") return "No audio yet";
  const length = audio.seconds !== null ? formatDuration(audio.seconds) : "";
  if (audio.imported) return `Imported audio ${length}${audio.timed ? ", words timed" : ""}`;
  if (audio.recorded) return `Your recording ${length}${audio.timed ? ", words timed" : ""}`;
  if (audio.state === "stale") return `Audio ${length}, out of date`;
  return `Audio ${length}${audio.timed ? ", words timed" : ""}`;
}

/** Whether the user really wants their recording (or the `imported` audio) gone; it cannot be brought back. */
async function confirmDelete(imported: boolean): Promise<boolean> {
  const message = imported
    ? "Remove the audio brought in for this slide? Its copy in the deck's narration folder is deleted; the file it came from stays."
    : "Delete your recording of this slide? This can't be undone.";
  try {
    const title = imported ? "Remove audio" : "Delete recording";
    return await ask(message, { title, kind: "warning", okLabel: imported ? "Remove" : "Delete" });
  } catch {
    return window.confirm(message);
  }
}
