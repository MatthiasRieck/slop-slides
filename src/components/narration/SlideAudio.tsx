import { ask } from "@tauri-apps/plugin-dialog";
import { AudioLines, Loader2, Pause, Play, Sparkles, Trash2, X } from "lucide-react";
import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Deck, SlideAudio } from "../../lib/api";
import { formatDuration, type Playback, playNarration } from "../../lib/narrationAudio";
import { playheadTransform } from "../../lib/playbackClock";
import { scrollToPlayhead } from "../../lib/timeline";
import { cn } from "../../lib/utils";
import { canSpeakWith, deckProvider, useNarration } from "../../narrationStore";
import { showError, useApp } from "../../store";
import { Button } from "../Button";
import { usePeaks, useWords, Waveform, Words } from "../NarrationWave";

/** How wide a second of audio is at least once its words are shown, in pixels, so they can be read. */
const WORDS_SECOND_WIDTH = 80;

/**
 * The slide's audio as its waveform, with when each word is said once that is known. Pressing
 * it plays the audio from there; a line shows where it is while it plays. With words, it is as
 * wide as they need and scrolls, turning the page when the line runs out of sight.
 *
 * The line is moved every frame by a transform set on the element itself (see
 * `playheadTransform`), asking the audio where it is: the waveform and the words under it are
 * not rendered again for it. `paused`, it stays where the audio stopped.
 */
function SlideWave(props: {
  deck: string;
  slide: string;
  audio: SlideAudio;
  seconds: number;
  playback: Playback | null;
  paused: boolean;
  onPlay: (from: number) => void;
}) {
  const { deck, slide, audio, seconds, playback, paused } = props;
  const peaks = usePeaks(deck, slide, audio);
  const words = useWords(deck, slide, audio);
  const scroller = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!playback) return;
    let frame = 0;
    const follow = () => {
      const at = Math.min(seconds, playback.time()) / seconds;
      if (playhead.current) playhead.current.style.transform = playheadTransform(at);
      const box = scroller.current;
      if (box) {
        const to = scrollToPlayhead(box.scrollWidth * at, box.scrollLeft, box.clientWidth);
        if (to !== box.scrollLeft) box.scrollLeft = to;
      }
      if (!paused) frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [playback, paused, seconds]);
  const press = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    props.onPlay(Math.min(seconds, Math.max(0, ((event.clientX - box.left) / (box.width || 1)) * seconds)));
  };
  const stale = audio.state === "stale";
  return (
    <div ref={scroller} className="overflow-x-auto overflow-y-hidden rounded-md border">
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
        {playback && (
          // As wide as the waveform and just left of it, the line at its edge: see `playheadTransform`.
          <span
            ref={playhead}
            data-testid="wave-playhead"
            className="pointer-events-none absolute inset-y-0 right-full w-full"
          >
            <span className="absolute inset-y-0 left-full w-px bg-destructive" />
          </span>
        )}
      </button>
    </div>
  );
}

/**
 * What the slide's audio is: its waveform, and buttons to hear it and to (re)make it. Play pauses
 * and plays on from there; pressing the waveform plays from that moment. While this slide's audio
 * is being generated, Cancel takes the place of Generate, where the wait is.
 */
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
  // Held where it is, to play on from there.
  const [paused, setPaused] = useState(false);
  useEffect(() => () => playback?.stop(), [playback]);

  const provider = speech ? deckProvider(deck, speech) : undefined;
  const canSpeak = canSpeakWith(speech, provider);
  const generate = async () => {
    playback?.stop();
    await props.flush();
    await useNarration.getState().renderAudio(deck.id, [slide]);
  };
  /** Plays from `from` seconds in, in place of what plays. */
  const play = async (from: number) => {
    playback?.stop();
    setPaused(false);
    try {
      const started = await playNarration(deck.id, slide, from);
      setPlayback(started);
      void started.ended.then(() => setPlayback((p) => (p === started ? null : p)));
    } catch (error) {
      showError(error, "Could not play the narration: ");
    }
  };
  /** The button: plays from the start, pauses what plays, or plays on what is paused. */
  const toggle = async () => {
    if (!playback) return play(0);
    if (!paused) {
      playback.pause();
      return setPaused(true);
    }
    try {
      await playback.resume();
      setPaused(false);
    } catch (error) {
      showError(error, "Could not play the narration: ");
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
          paused={paused}
          onPlay={(from) => void play(from)}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
          {busy ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Generating audio…
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
              title="Puts a request in the chat, for the agent to turn this slide's recorded words into clean, fluent sentences. It opens the chat; you send it."
            >
              <Sparkles />
              Clean up
            </Button>
          )}
          <Button
            size="md"
            disabled={!audio?.seconds || busy}
            onClick={() => void toggle()}
            title={
              playback
                ? paused
                  ? "Play on from where it was paused"
                  : "Pause the audio"
                : audio?.state === "stale"
                  ? "Play the out-of-date audio from the start; press the waveform to play from there"
                  : "Play the audio from the start; press the waveform to play from there"
            }
          >
            {playback && !paused ? <Pause /> : <Play />}
            {playback ? (paused ? "Resume" : "Pause") : "Play"}
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
          ) : busy ? (
            <Button
              size="md"
              onClick={() => void useNarration.getState().cancelRender()}
              title="Stop generating the audio"
            >
              <X />
              Cancel
            </Button>
          ) : (
            <Button
              size="md"
              disabled={!canSpeak || render !== null}
              onClick={() => void generate()}
              title={
                !canSpeak
                  ? `Add your ${provider?.name ?? "narration service's"} API key first`
                  : render !== null
                    ? "Audio is being generated for another slide"
                    : "Generate this slide's audio from its narration"
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
  if (audio.imported) return `Imported audio ${length}${audio.timed ? ", words synced" : ""}`;
  if (audio.recorded) return `Your recording ${length}${audio.timed ? ", words synced" : ""}`;
  if (audio.state === "stale") return `Audio ${length}, out of date`;
  return `Audio ${length}${audio.timed ? ", words synced" : ""}`;
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
