import { ask } from "@tauri-apps/plugin-dialog";
import { AudioLines, Download, Loader2, Play, Sparkles, Square, Timer, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { type Deck, errorMessage, type Slide, type SlideAudio } from "../lib/api";
import { markdownText } from "../lib/markdown";
import { speakingTime, wordCount } from "../lib/narration";
import { formatDuration, type Playback, playNarration } from "../lib/narrationAudio";
import { useDraftText } from "../lib/useDraftText";
import { formatBytes } from "../lib/voice";
import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { Button } from "./Button";
import { Field, wideSelectClass } from "./Field";
import { ScriptField } from "./ScriptMarkdown";
import { SlideBand, SlideBandHeader } from "./SlideBand";
import { SlideTime } from "./SlideTime";

/** How long typing pauses before the narration is saved to the deck. */
export const NARRATION_SAVE_DELAY = 800;

/** No audio known yet; one object, so selecting it does not re-render. */
const NO_AUDIO: Record<string, SlideAudio> = {};

/**
 * Narration mode's tools, in a band above the slide: what is said over the current slide, to
 * view, edit and hear. The text stays a readable width however wide the stage is, with the
 * voice beside it.
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
          <div className="flex w-72 shrink-0 flex-col justify-between overflow-y-auto border-l">
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

/** The deck's voice and language, and the voice model's download. */
function SpeechSettings({ deck }: { deck: Deck }) {
  const speech = useNarration((s) => s.speech);
  const download = useNarration((s) => s.download);
  const downloadModel = useNarration((s) => s.downloadModel);
  if (!speech) return null;
  const settings = deck.narration ?? { voice: "ryan", language: "en" };
  const languageName = (id: string) => speech.languages.find((l) => l.id === id)?.name ?? id;
  const percent = download && download.total > 0 ? Math.round((download.received / download.total) * 100) : 0;
  return (
    <div className="flex flex-col gap-2 p-3 text-xs">
      <div className="flex gap-2">
        <Field label="Voice" className="flex min-w-0 flex-[3] flex-col gap-1">
          <select
            aria-label="Narration voice"
            value={settings.voice}
            onChange={(event) => void useApp.getState().setNarrationVoice(event.target.value)}
            className={wideSelectClass}
          >
            {speech.voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name} — {voice.description} ({languageName(voice.native)})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Language" className="flex min-w-0 flex-[2] flex-col gap-1">
          <select
            aria-label="Narration language"
            value={settings.language}
            onChange={(event) => void useApp.getState().setNarrationLanguage(event.target.value)}
            className={wideSelectClass}
          >
            {speech.languages.map((language) => (
              <option key={language.id} value={language.id}>
                {language.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {!speech.available ? (
        <p className="text-muted-foreground">Speaking narration is not available on this platform yet.</p>
      ) : (
        !speech.modelReady && (
          <div className="flex flex-col gap-2 rounded-md border bg-card p-2">
            <p className="text-muted-foreground">
              Narration is spoken on this computer by a voice model ({formatBytes(speech.modelBytes)}), downloaded once
              for every deck. All its voices come with it.
            </p>
            {download ? (
              <div className="flex flex-col gap-1" role="status">
                <span>Downloading the voice model… {percent}%</span>
                <div className="h-1 overflow-hidden rounded bg-muted">
                  <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
                </div>
              </div>
            ) : (
              <Button size="md" onClick={() => void downloadModel()} className="self-start">
                <Download />
                Download voice model
              </Button>
            )}
          </div>
        )
      )}
    </div>
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
    <div className="flex min-w-0 max-w-3xl flex-1 flex-col gap-2 p-3">
      <SlideBandHeader slide={slide} index={index} total={total} preview={preview} onPreview={props.onPreview}>
        <span className="ml-auto shrink-0 tabular-nums">
          {words} {words === 1 ? "word" : "words"} ·{" "}
          <span title="Estimated at 150 words per minute">~{speakingTime(spoken)}</span>
        </span>
        <SlideTime deck={deck} />
      </SlideBandHeader>
      <ScriptField
        label="Narration"
        draft={draft}
        preview={preview}
        readOnly={!!slide.locked}
        onChange={change}
        onBlur={() => void flush()}
        placeholder={slide.locked ? "No narration." : "What is said while this slide is shown…"}
      />
      <SlideAudioControls
        deck={deck}
        slide={slide.id}
        hasText={draft.trim() !== ""}
        locked={!!slide.locked}
        flush={flush}
      />
    </div>
  );
}

/** What the slide's audio is, and buttons to hear it and to (re)make it. */
function SlideAudioControls(props: {
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

  const canSpeak = !!speech?.available && speech.modelReady;
  const generate = async () => {
    playback?.stop();
    await props.flush();
    await useNarration.getState().renderAudio(deck.id, [slide]);
  };
  const play = async () => {
    if (playback) return playback.stop();
    try {
      const started = await playNarration(deck.id, slide);
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
    if (await confirmDelete()) await useNarration.getState().deleteRecording(deck.id, slide);
  };
  const recorded = !!audio?.recorded;
  if (!props.hasText && !recorded) return null;
  const busy = render?.slide === slide || (render !== null && render.slide === null && render.deck === deck.id);
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
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
            title="Delete your recording of this slide"
          >
            <Trash2 />
            Delete recording
          </Button>
        ) : (
          <Button
            size="md"
            disabled={!canSpeak || render !== null}
            onClick={() => void generate()}
            title={canSpeak ? "Speak this slide's narration" : "Download the voice model first"}
          >
            <AudioLines />
            {audio?.state === "ready" ? "Regenerate" : "Generate"}
          </Button>
        )}
      </div>
    </div>
  );
}

function audioLabel(audio: SlideAudio | undefined): string {
  if (!audio || audio.state === "missing" || audio.state === "none") return "No audio yet";
  const length = audio.seconds !== null ? formatDuration(audio.seconds) : "";
  if (audio.recorded) return `Your recording ${length}${audio.timed ? ", words timed" : ""}`;
  if (audio.state === "stale") return `Audio ${length}, out of date`;
  return `Audio ${length}${audio.timed ? ", words timed" : ""}`;
}

/** Whether the user really wants their recording gone; it cannot be brought back. */
async function confirmDelete(): Promise<boolean> {
  const message = "Delete your recording of this slide? This can't be undone.";
  try {
    return await ask(message, { title: "Delete recording", kind: "warning", okLabel: "Delete" });
  } catch {
    return window.confirm(message);
  }
}

/** Has the agent make clean, fluent scripts of the whole deck's recorded words. */
function CleanUpAll({ deck }: { deck: Deck }) {
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
function DeckAudio({ deck }: { deck: Deck }) {
  const audio = useNarration((s) => (s.audioDeck === deck.id ? s.audio : NO_AUDIO));
  const speech = useNarration((s) => s.speech);
  const render = useNarration((s) => s.render);
  const pending = deck.slides.filter((s) => {
    const state = audio[s.id]?.state;
    return state === "missing" || state === "stale";
  }).length;
  const canSpeak = !!speech?.available && speech.modelReady;
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
function WordTiming({ deck }: { deck: Deck }) {
  const audio = useNarration((s) => (s.audioDeck === deck.id ? s.audio : NO_AUDIO));
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
