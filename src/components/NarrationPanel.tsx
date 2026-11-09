import { ask } from "@tauri-apps/plugin-dialog";
import { AudioLines, Download, KeyRound, Loader2, Play, Sparkles, Square, Timer, Trash2, X } from "lucide-react";
import { type MouseEvent, useEffect, useRef, useState } from "react";

import { type Deck, errorMessage, type NarrationProvider, type Slide, type SlideAudio } from "../lib/api";
import { markdownText } from "../lib/markdown";
import { speakingTime, wordCount } from "../lib/narration";
import { formatDuration, type Playback, playNarration } from "../lib/narrationAudio";
import { useDraftText } from "../lib/useDraftText";
import { cn } from "../lib/utils";
import { formatBytes } from "../lib/voice";
import { canSpeakWith, deckProvider, useNarration } from "../narrationStore";
import { useApp } from "../store";
import { Button } from "./Button";
import { Field, inputClass, wideSelectClass } from "./Field";
import { usePeaks, useWords, Waveform, Words } from "./NarrationWave";
import { ScriptField } from "./ScriptMarkdown";
import { SlideBand, SlideBandHeader } from "./SlideBand";
import { SlideTime } from "./SlideTime";

/** How long typing pauses before the narration is saved to the deck. */
export const NARRATION_SAVE_DELAY = 800;

/** No audio known yet; one object, so selecting it does not re-render. */
const NO_AUDIO: Record<string, SlideAudio> = {};

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

/** The deck's provider, voice and language, and the voice model's download or the service's API key. */
function SpeechSettings({ deck }: { deck: Deck }) {
  const speech = useNarration((s) => s.speech);
  const accountVoices = useNarration((s) => s.accountVoices);
  const loadVoices = useNarration((s) => s.loadVoices);
  const provider = speech ? deckProvider(deck, speech) : undefined;
  const providerId = provider?.id;
  const hasKey = provider?.key != null;
  useEffect(() => {
    // ElevenLabs accounts have voices of their own, such as the user's cloned voice.
    if (providerId === "elevenlabs" && hasKey) void loadVoices(providerId);
  }, [providerId, hasKey, loadVoices]);
  if (!speech || !provider) return null;
  const settings = deck.narration ?? { voice: provider.voices[0]?.id ?? "", language: "en" };
  const languageName = (id: string) => speech.languages.find((l) => l.id === id)?.name ?? id;
  const voices = accountVoices[provider.id] ?? provider.voices;
  // A voice the deck names that is not listed (an account's own, before the list came) stays pickable.
  const listed = voices.some((v) => v.id === settings.voice);
  return (
    <div className="flex flex-col gap-2 p-3 text-xs">
      <Field label="Spoken by" className="flex min-w-0 flex-col gap-1">
        <select
          aria-label="Narration provider"
          value={provider.id}
          onChange={(event) => void useApp.getState().setNarrationProvider(event.target.value)}
          className={wideSelectClass}
        >
          {speech.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex gap-2">
        <Field label="Voice" className="flex min-w-0 flex-[3] flex-col gap-1">
          <select
            aria-label="Narration voice"
            value={settings.voice}
            onChange={(event) => void useApp.getState().setNarrationVoice(event.target.value)}
            className={wideSelectClass}
          >
            {!listed && <option value={settings.voice}>{settings.voice}</option>}
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name}
                {voice.description ? ` — ${voice.description}` : ""}
                {voice.native ? ` (${languageName(voice.native)})` : ""}
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
      {provider.needsKey ? <ApiKey provider={provider} /> : <LocalModel />}
    </div>
  );
}

/** Whether the local voice model can run here, and its download. */
function LocalModel() {
  const speech = useNarration((s) => s.speech);
  const download = useNarration((s) => s.download);
  const downloadModel = useNarration((s) => s.downloadModel);
  if (!speech) return null;
  const percent = download && download.total > 0 ? Math.round((download.received / download.total) * 100) : 0;
  if (!speech.available) {
    return (
      <p className="text-muted-foreground">
        The local voice model is not available on this platform yet. Pick ElevenLabs or OpenAI above.
      </p>
    );
  }
  if (speech.modelReady) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card p-2">
      <p className="text-muted-foreground">
        Narration is spoken on this computer by a voice model ({formatBytes(speech.modelBytes)}), downloaded once for
        every deck. All its voices come with it.
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
  );
}

/** The environment variable a hosted provider's key may come from. */
const KEY_ENV: Record<string, string> = { elevenlabs: "ELEVENLABS_API_KEY", openai: "OPENAI_API_KEY" };

/** A hosted provider's API key: entered once, kept in ~/.slopslides for every deck. */
function ApiKey({ provider }: { provider: NarrationProvider }) {
  const [key, setKey] = useState("");
  const save = async () => {
    if (await useNarration.getState().setKey(provider.id, key)) setKey("");
  };
  if (provider.key === "environment") {
    return (
      <p className="text-muted-foreground">
        Using {KEY_ENV[provider.id] ?? "the API key"} from your environment. Narration text is sent to {provider.name}.
      </p>
    );
  }
  if (provider.key === "saved") {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <KeyRound className="size-3.5 shrink-0" />
          {provider.name} API key saved
        </span>
        <Button
          size="md"
          onClick={() => void useNarration.getState().setKey(provider.id, null)}
          title={`Forget the ${provider.name} API key on this computer`}
        >
          <Trash2 />
          Remove
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-2 rounded-md border bg-card p-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="text-muted-foreground">
        {provider.name} says the narration with your account. Its API key is kept on this computer for every deck, never
        in a deck. Narration text is sent to {provider.name}.
      </p>
      <div className="flex gap-1">
        <input
          type="password"
          aria-label={`${provider.name} API key`}
          placeholder="API key"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          className={`${inputClass} flex-1 text-xs`}
        />
        <Button size="md" type="submit" disabled={key.trim() === ""}>
          Save
        </Button>
      </div>
    </form>
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
                  : provider?.needsKey
                    ? `Add your ${provider.name} API key first`
                    : "Download the voice model first"
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

function audioLabel(audio: SlideAudio | undefined): string {
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
