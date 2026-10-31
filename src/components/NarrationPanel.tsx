import { AudioLines, Download, Loader2, Lock, Play, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

import { type Deck, errorMessage, type Slide, type SlideAudio } from "../lib/api";
import { speakingTime, wordCount } from "../lib/narration";
import { formatDuration, type Playback, playNarration } from "../lib/narrationAudio";
import { useDraftText } from "../lib/useDraftText";
import { formatBytes } from "../lib/voice";
import { useNarration } from "../narrationStore";
import { useApp } from "../store";

/** How long typing pauses before the narration is saved to the deck. */
export const NARRATION_SAVE_DELAY = 800;

/** No audio known yet; one object, so selecting it does not re-render. */
const NO_AUDIO: Record<string, SlideAudio> = {};

const field = "h-7 w-full min-w-0 rounded-md border bg-background px-1.5 text-xs";
const button =
  "flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent [&_svg]:size-3.5";

/**
 * Narration mode's tools, in a band above the slide: what is said over the current slide, to
 * view, edit and hear. The text stays a readable width however wide the stage is, with the
 * voice beside it.
 */
export function NarrationPanel() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const loadSpeech = useNarration((s) => s.loadSpeech);
  useEffect(() => {
    void loadSpeech();
  }, [loadSpeech]);
  const index = deck?.slides.findIndex((s) => s.id === selected) ?? -1;
  const slide = deck?.slides[index];
  if (!deck || !slide) {
    return (
      <p className="shrink-0 border-b bg-background p-4 text-sm text-muted-foreground">
        {deck ? "Add a slide to write its narration." : "Open a deck to write narration for its slides."}
      </p>
    );
  }
  return (
    <section aria-label="Narration tools" className="flex h-52 shrink-0 justify-center border-b bg-background">
      {/* One editor per slide: switching slides saves the last one's pending text as it unmounts. */}
      <NarrationEditor key={slide.id} deck={deck} slide={slide} index={index} total={deck.slides.length} />
      <div className="flex w-72 shrink-0 flex-col justify-between overflow-y-auto border-l">
        <SpeechSettings deck={deck} />
        <DeckAudio deck={deck} />
      </div>
    </section>
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
        <label className="flex min-w-0 flex-[3] flex-col gap-1">
          <span className="text-muted-foreground">Voice</span>
          <select
            aria-label="Narration voice"
            value={settings.voice}
            onChange={(event) => void useApp.getState().setNarrationVoice(event.target.value)}
            className={field}
          >
            {speech.voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name} — {voice.description} ({languageName(voice.native)})
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-[2] flex-col gap-1">
          <span className="text-muted-foreground">Language</span>
          <select
            aria-label="Narration language"
            value={settings.language}
            onChange={(event) => void useApp.getState().setNarrationLanguage(event.target.value)}
            className={field}
          >
            {speech.languages.map((language) => (
              <option key={language.id} value={language.id}>
                {language.name}
              </option>
            ))}
          </select>
        </label>
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
              <button type="button" className={`${button} self-start`} onClick={() => void downloadModel()}>
                <Download />
                Download voice model
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}

function NarrationEditor(props: { deck: Deck; slide: Slide; index: number; total: number }) {
  const { deck, slide, index, total } = props;
  const { draft, change, flush } = useDraftText(slide.narration ?? "", NARRATION_SAVE_DELAY, (text) =>
    useApp.getState().setNarration(slide.id, text),
  );

  const words = wordCount(draft);
  return (
    <div className="flex min-w-0 max-w-3xl flex-1 flex-col gap-2 p-3">
      <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          Slide {index + 1} of {total} · <span className="font-mono">{slide.id}</span>
        </span>
        <span className="ml-auto shrink-0 tabular-nums">
          {words} {words === 1 ? "word" : "words"} ·{" "}
          <span title="Estimated at 150 words per minute">~{speakingTime(draft)}</span>
        </span>
        {slide.locked && (
          <span className="flex shrink-0 items-center gap-1">
            <Lock className="size-3" />
            Locked
          </span>
        )}
      </div>
      <textarea
        aria-label="Narration"
        value={draft}
        readOnly={slide.locked}
        onChange={(event) => change(event.target.value)}
        onBlur={() => void flush()}
        placeholder={slide.locked ? "No narration." : "What is said while this slide is shown…"}
        className="selectable min-h-0 flex-1 resize-none rounded-md border bg-card p-3 text-sm leading-relaxed outline-none focus:border-primary"
      />
      <SlideAudioControls deck={deck} slide={slide.id} hasText={draft.trim() !== ""} flush={flush} />
    </div>
  );
}

/** What the slide's audio is, and buttons to hear it and to (re)make it. */
function SlideAudioControls(props: { deck: Deck; slide: string; hasText: boolean; flush: () => Promise<void> }) {
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
  if (!props.hasText) return null;
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
        <button
          type="button"
          className={button}
          disabled={!audio?.seconds || busy}
          onClick={() => void play()}
          title={audio?.state === "stale" ? "Play the out-of-date audio" : "Play the audio"}
        >
          {playback ? <Square /> : <Play />}
          {playback ? "Stop" : "Play"}
        </button>
        <button
          type="button"
          className={button}
          disabled={!canSpeak || render !== null}
          onClick={() => void generate()}
          title={canSpeak ? "Speak this slide's narration" : "Download the voice model first"}
        >
          <AudioLines />
          {audio?.state === "ready" ? "Regenerate" : "Generate"}
        </button>
      </div>
    </div>
  );
}

function audioLabel(audio: SlideAudio | undefined): string {
  if (!audio || audio.state === "missing" || audio.state === "none") return "No audio yet";
  const length = audio.seconds !== null ? formatDuration(audio.seconds) : "";
  return audio.state === "stale" ? `Audio ${length}, out of date` : `Audio ${length}`;
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
        <button type="button" className={button} onClick={() => void useNarration.getState().cancelRender()}>
          <X />
          Cancel
        </button>
      </div>
    );
  }
  if (!canSpeak || pending === 0) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t p-3 text-xs">
      <span className="text-muted-foreground">
        {pending} {pending === 1 ? "slide needs" : "slides need"} audio
      </span>
      <button
        type="button"
        className={button}
        disabled={render !== null}
        onClick={() => void useNarration.getState().renderAudio(deck.id, null)}
      >
        <AudioLines />
        Generate all
      </button>
    </div>
  );
}
