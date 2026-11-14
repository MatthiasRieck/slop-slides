import { AudioLines, Loader2, Mic, Pause, Play, Square, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { Deck, SlideAudio } from "../../lib/api";
import { formatDuration, type Playback, playNarration } from "../../lib/narrationAudio";
import { canSpeakWith, deckProvider, useNarration } from "../../narrationStore";
import { showError } from "../../store";
import { confirmAction } from "../../store/confirm";
import { Button } from "../Button";
import { LevelMeter, type NarrationRecorder, RecordingTime, useNarrationRecorder } from "../NarrationRecorder";
import { SlideWave } from "./SlideWave";

/**
 * What the slide's audio is: its waveform, and buttons to hear it, to make it from the script,
 * and to record it oneself. Play pauses and plays on from there; pressing the waveform plays from
 * that moment. While this slide's audio is being generated, Cancel takes the place of Generate,
 * where the wait is.
 *
 * Record takes the user's own voice as the slide's audio, after a countdown, with the
 * microphone's level and the time while it runs; a slide that has a recording offers Record
 * again, which replaces the take, and Delete recording, which brings the generated voice back.
 * Audio whose script (or voice) changed since it was made says so as a warning, with Update
 * audio to make it again.
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
  const recorder = useNarrationRecorder(deck.id, slide);
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
  const remove = async () => {
    playback?.stop();
    if (await confirmDelete(!!audio?.imported)) await useNarration.getState().deleteRecording(deck.id, slide);
  };
  const record = () => {
    playback?.stop();
    void recorder.toggle("audio");
  };

  const recorded = !!audio?.recorded;
  const ownTake = recorded && !audio?.imported;
  const stale = audio?.state === "stale";
  const busy = render?.slide === slide || (render !== null && render.slide === null && render.deck === deck.id);
  const taking = recorder.phase !== "off";
  // A locked slide with nothing to hear has nothing to do here.
  if (!props.hasText && !recorded && props.locked) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      {audio?.seconds != null && audio.seconds > 0 && !taking && (
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
        <AudioStatus audio={audio} busy={busy} recorder={recorder} />
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {taking ? (
            <RecordingButton recorder={recorder} />
          ) : (
            <>
              {!!audio?.seconds && (
                <Button
                  size="md"
                  disabled={busy}
                  onClick={() => void toggle()}
                  title={
                    playback
                      ? paused
                        ? "Play on from where it was paused"
                        : "Pause the audio"
                      : stale
                        ? "Play the out-of-date audio from the start; press the waveform to play from there"
                        : "Play the audio from the start; press the waveform to play from there"
                  }
                >
                  {playback && !paused ? <Pause /> : <Play />}
                  {playback ? (paused ? "Resume" : "Pause") : "Play"}
                </Button>
              )}
              {!busy && (
                <Button
                  size="md"
                  disabled={props.locked}
                  onClick={record}
                  title={
                    props.locked
                      ? "This slide is locked; unlock it in the slide list to record over it"
                      : ownTake
                        ? "Record this slide again with your microphone, in place of the recording it has. It starts after a countdown."
                        : "Record your own voice for this slide with your microphone. It starts after a countdown, and takes the place of generated audio."
                  }
                >
                  <Mic />
                  {ownTake ? "Record again" : "Record"}
                </Button>
              )}
              {recorded ? (
                <Button
                  size="md"
                  disabled={props.locked}
                  onClick={() => void remove()}
                  title={
                    audio?.imported
                      ? "Remove the audio brought in for this slide"
                      : "Delete your recording of this slide"
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
                props.hasText && (
                  <Button
                    size="md"
                    variant={stale ? "primary" : undefined}
                    disabled={!canSpeak || render !== null}
                    onClick={() => void generate()}
                    title={
                      !canSpeak
                        ? `Add your ${provider?.name ?? "narration service's"} API key first, under Voice below`
                        : render !== null
                          ? "Audio is being generated for another slide"
                          : stale
                            ? "Generate this slide's audio again, from the script as it is now"
                            : "Generate this slide's audio from its script"
                    }
                  >
                    <AudioLines />
                    {stale ? "Update audio" : audio?.state === "ready" ? "Regenerate" : "Generate"}
                  </Button>
                )
              )}
            </>
          )}
        </div>
      </div>
      {recorder.error && (
        <p role="alert" className="text-destructive text-xs">
          Could not record: {recorder.error}
        </p>
      )}
    </div>
  );
}

/** What the slide's audio is, in a line: being made, being recorded, out of date, or what there is. */
function AudioStatus(props: { audio: SlideAudio | undefined; busy: boolean; recorder: NarrationRecorder }) {
  const { audio, recorder } = props;
  const line = "flex min-w-0 items-center gap-1.5";
  if (recorder.phase === "countdown") {
    return (
      <span role="status" className={`${line} text-destructive`}>
        <span className="font-semibold tabular-nums">{recorder.count}</span>
        Recording starts…
      </span>
    );
  }
  if (recorder.phase === "recording") {
    return (
      <span role="status" className={`${line} text-destructive`}>
        <LevelMeter />
        Recording
        <RecordingTime since={recorder.since} />
      </span>
    );
  }
  if (recorder.phase !== "off" || props.busy) {
    return (
      <span role="status" className={`${line} text-muted-foreground`}>
        <Loader2 className="size-3.5 animate-spin" />
        {props.busy ? "Generating audio…" : recorder.phase === "saving" ? "Saving the recording…" : "Starting…"}
      </span>
    );
  }
  if (audio?.state === "stale") {
    return (
      <span data-testid="audio-stale" className={`${line} text-warning`}>
        <TriangleAlert className="size-3.5 shrink-0" />
        <span className="min-w-0">
          Script or voice changed
          {audio.seconds !== null && (
            <span className="text-muted-foreground"> · old audio {formatDuration(audio.seconds)}</span>
          )}
        </span>
      </span>
    );
  }
  return <span className={`${line} text-muted-foreground`}>{audioLabel(audio)}</span>;
}

/** While a take is counted down, recorded or saved: what ends it. */
function RecordingButton({ recorder }: { recorder: NarrationRecorder }) {
  if (recorder.phase === "countdown") {
    return (
      <Button size="md" onClick={() => void recorder.toggle("audio")} title="Call the recording off">
        <X />
        Cancel
      </Button>
    );
  }
  return (
    <Button
      size="md"
      variant="destructive"
      disabled={recorder.phase !== "recording"}
      onClick={() => void recorder.toggle("audio")}
      title="Stop recording and keep the take"
    >
      <Square className="fill-current" />
      Stop
    </Button>
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
function confirmDelete(imported: boolean): Promise<boolean> {
  return confirmAction(
    imported
      ? {
          title: "Remove this slide's audio?",
          message:
            "Its copy in the deck's narration folder is deleted; the file it came from stays. The slide's script can be generated as audio again.",
          confirmLabel: "Remove audio",
          destructive: true,
        }
      : {
          title: "Delete your recording?",
          message: "Your recording of this slide is deleted. This can't be undone.",
          confirmLabel: "Delete recording",
          destructive: true,
        },
  );
}
