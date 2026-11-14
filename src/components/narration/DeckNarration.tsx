import { AudioLines, ChevronDown, ChevronRight, Loader2, Mic, NotebookText, Sparkles, Timer, X } from "lucide-react";
import { useState } from "react";

import { api, type Deck, errorMessage, type Slide, type SlideAudio } from "../../lib/api";
import { markdownText } from "../../lib/markdown";
import {
  describeGeneration,
  generationSize,
  MARK_LABELS,
  type NarrationMark,
  narrationMark,
  slidesToScriptFromNotes,
} from "../../lib/narration";
import { loadFlag, saveFlag } from "../../lib/storage";
import { cn } from "../../lib/utils";
import { formatBytes } from "../../lib/voice";
import { canSpeakWith, deckProvider, useNarration } from "../../narrationStore";
import { showError, useApp } from "../../store";
import { Button } from "../Button";
import { useDeckAudio } from "./useDeckAudio";

/** The mark of a control that hands a request to the agent instead of acting itself. */
export function AgentMark() {
  return <Sparkles size={12} className="text-primary" />;
}

/** What polishing does, for the tooltips of the buttons that ask for it. */
export const POLISH_TIP =
  "Rewrites rough or dictated wording as clean, fluent sentences, keeping what is said. Opens the chat with the request, for you to send · asks the agent";

/**
 * What can be done to the scripts of the whole deck: taking the speaker notes as the script of
 * every slide that has notes and no script yet, and having the agent polish the wording of all
 * of them. Each shows only when it applies.
 */
export function DeckScripts({ deck }: { deck: Deck }) {
  const fromNotes = slidesToScriptFromNotes(deck.slides).length;
  const polishable = deck.slides.some((s) => s.narration && !s.locked);
  if (fromNotes === 0 && !polishable) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t p-3">
      {fromNotes > 0 && (
        <Button
          size="md"
          onClick={() => void useApp.getState().scriptsFromNotes()}
          title="Copies the speaker notes of every slide that has notes and no script into its script. Slides that have a script keep it."
        >
          <NotebookText />
          Use speaker notes for {fromNotes} empty {fromNotes === 1 ? "script" : "scripts"}
        </Button>
      )}
      {polishable && (
        <Button size="md" onClick={() => useApp.getState().cleanNarration(null)} title={POLISH_TIP}>
          <AgentMark />
          Polish all scripts…
        </Button>
      )}
    </div>
  );
}

/**
 * The deck's narration as a whole: how much needs speaking, said in full before it is asked for
 * (how many slides, how many characters go to the service, about how long it plays), and the
 * render running.
 */
export function DeckAudio({ deck }: { deck: Deck }) {
  const audio = useDeckAudio(deck.id);
  const speech = useNarration((s) => s.speech);
  const render = useNarration((s) => s.render);
  const size = generationSize(deck.slides, audio);
  const provider = speech ? deckProvider(deck, speech) : undefined;
  const canSpeak = canSpeakWith(speech, provider);
  if (render?.deck === deck.id && render.total > 0) {
    return (
      <div className="flex items-center justify-between gap-2 border-t p-3 text-xs" role="status">
        <span className="flex min-w-0 items-center gap-1">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <span className="truncate">
            Generating audio for slide {render.done + 1} of {render.total}…
          </span>
        </span>
        <Button size="md" onClick={() => void useNarration.getState().cancelRender()}>
          <X />
          Cancel
        </Button>
      </div>
    );
  }
  if (!canSpeak || size.slides === 0) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t p-3 text-xs">
      <span className="flex min-w-0 flex-col">
        <span>
          {size.slides} {size.slides === 1 ? "slide needs" : "slides need"} audio
        </span>
        <span data-testid="generation-size" className="text-2xs text-muted-foreground">
          {size.characters.toLocaleString("en-US")} characters go to {provider?.name ?? "the service"}, about{" "}
          {describeGeneration(size).split("about ")[1]}
        </span>
      </span>
      <Button
        size="md"
        disabled={render !== null}
        onClick={() => void useNarration.getState().renderAudio(deck.id, null)}
        title={`Generates the audio of ${describeGeneration(size)}. Slides whose audio is up to date, and your own recordings, are left alone.`}
      >
        <AudioLines />
        Generate all
      </Button>
    </div>
  );
}

/**
 * Syncing the words to the audio: hearing the deck's narration audio again with the
 * speech-to-text model, to know when each word is said. That is what timing animations and slide
 * changes to the narration goes by. The model is a large download: the first time, it is offered
 * with its size before anything is fetched, shows how far it has come, and can be stopped, as the
 * hearing after it can.
 */
export function WordTiming({ deck }: { deck: Deck }) {
  const audio = useDeckAudio(deck.id);
  const timing = useNarration((s) => s.timing);
  const render = useNarration((s) => s.render);
  // The model's size, while its download is offered.
  const [offer, setOffer] = useState<number | null>(null);
  const sync = () => {
    setOffer(null);
    void useNarration.getState().timeWords(deck.id, null);
  };
  /** Syncs at once with the model there (or on its way); offers its download otherwise. */
  const start = async () => {
    try {
      const status = await api.voiceStatus();
      if (status.modelReady || status.downloading) sync();
      else setOffer(status.modelBytes);
    } catch (error) {
      showError(errorMessage(error));
    }
  };
  if (timing?.deck === deck.id) {
    const download = timing.downloading ? timing.download : undefined;
    const percent = download && download.total > 0 ? Math.round((download.received / download.total) * 100) : 0;
    const label = timing.downloading
      ? download
        ? `Downloading the speech model: ${formatBytes(download.received)} of ${formatBytes(download.total)}`
        : "Downloading the speech model…"
      : timing.total > 0
        ? `Syncing words of slide ${timing.done + 1} of ${timing.total}…`
        : "Syncing words to audio…";
    return (
      <div className="flex flex-col gap-1.5 border-t p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1" role="status">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            <span className="truncate">{label}</span>
          </span>
          <Button
            size="md"
            onClick={() => void useNarration.getState().cancelTiming()}
            title={
              timing.downloading
                ? "Stop the download; nothing of it is kept"
                : "Stop after the slide being heard; the slides already synced stay synced"
            }
          >
            <X />
            Cancel
          </Button>
        </div>
        {timing.downloading && (
          <div
            role="progressbar"
            aria-label="Speech model download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            {/* As wide as its track and moved into it from the left: moving takes no layout, a width changing does. */}
            <div
              className="h-full bg-primary transition-transform"
              style={{ transform: `translateX(${percent - 100}%)` }}
            />
          </div>
        )}
      </div>
    );
  }
  const untimed = deck.slides.filter((s) => audio[s.id]?.state === "ready" && !audio[s.id]?.timed).length;
  if (untimed === 0) return null;
  if (offer !== null) {
    return (
      <section aria-label="Download the speech model?" className="flex flex-col gap-2 border-t p-3 text-xs">
        <p className="font-medium">Download the speech model?</p>
        <p className="text-muted-foreground">
          Syncing listens to the audio on this computer with Whisper. The model ({formatBytes(offer)}) is downloaded
          once to ~/.slopslides/models.
        </p>
        <div className="flex justify-end gap-1.5">
          <Button size="md" onClick={() => setOffer(null)}>
            Not now
          </Button>
          <Button size="md" variant="primary" onClick={sync}>
            Download and sync
          </Button>
        </div>
      </section>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 border-t p-3 text-xs">
      <span className="text-muted-foreground">
        {untimed} {untimed === 1 ? "slide's words are" : "slides' words are"} not synced to the audio
      </span>
      <Button
        size="md"
        disabled={timing !== null || render !== null}
        onClick={() => void start()}
        title="Find when each word is said in the audio, by listening to it with the speech-to-text model on this computer. Animations and slide changes can then follow the words."
      >
        <Timer />
        Sync words to audio
      </Button>
    </div>
  );
}

const OVERVIEW_OPEN_KEY = "slopslide.narrationOverview";

/** How a mark shows in a slide's row: its dot. */
const MARK_DOTS: Record<NarrationMark, string> = {
  none: "border border-border",
  script: "border border-foreground/60",
  ready: "bg-primary",
  stale: "bg-warning",
  recorded: "bg-primary",
};

/** How many slides have a script, audio that is up to date, and audio that is not. */
function overviewCounts(slides: Slide[], audio: Record<string, SlideAudio>) {
  const marks = slides.map((slide) => narrationMark(slide, audio[slide.id]));
  const count = (...wanted: NarrationMark[]) => marks.filter((mark) => wanted.includes(mark)).length;
  return {
    scripts: slides.filter((s) => (s.narration ?? "").trim() !== "").length,
    audio: count("ready", "recorded"),
    stale: count("stale"),
  };
}

/**
 * The whole deck's narration at a glance: a line of counts that folds open into one row per
 * slide, with how its script starts and what it has of audio (none yet, up to date, out of date,
 * the user's own recording). Pressing a row goes to that slide.
 */
export function NarrationOverview({ deck, selected }: { deck: Deck; selected: string }) {
  const audio = useDeckAudio(deck.id);
  const [open, setOpen] = useState(() => loadFlag(OVERVIEW_OPEN_KEY, false));
  const toggle = () => {
    saveFlag(OVERVIEW_OPEN_KEY, !open);
    setOpen(!open);
  };
  const counts = overviewCounts(deck.slides, audio);
  const total = deck.slides.length;
  const summary = [
    `${counts.scripts} of ${total} ${total === 1 ? "slide has" : "slides have"} a script`,
    `${counts.audio} with audio`,
    ...(counts.stale > 0 ? [`${counts.stale} out of date`] : []),
  ].join(" · ");
  return (
    <div className="flex flex-col border-t text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex items-center gap-1.5 px-3 py-2 text-left hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span className="font-medium">Every slide</span>
        <span data-testid="narration-counts" className="min-w-0 truncate text-muted-foreground">
          {summary}
        </span>
      </button>
      {open && (
        <ul aria-label="Narration of every slide" className="max-h-64 overflow-y-auto px-1.5 pb-2">
          {deck.slides.map((slide, index) => {
            const mark = narrationMark(slide, audio[slide.id]);
            const script = markdownText(slide.narration ?? "").trim();
            return (
              <li key={slide.id}>
                <button
                  type="button"
                  aria-current={slide.id === selected ? "true" : undefined}
                  title={`Go to slide ${index + 1}`}
                  onClick={() => useApp.getState().select(slide.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                    slide.id === selected && "bg-accent",
                  )}
                >
                  <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">{index + 1}</span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      (script === "" || slide.hidden) && "text-muted-foreground",
                    )}
                  >
                    {script === "" ? "No script" : script}
                  </span>
                  <span
                    data-mark={mark}
                    className={cn(
                      "flex shrink-0 items-center gap-1 text-2xs",
                      mark === "stale" ? "text-warning" : "text-muted-foreground",
                    )}
                  >
                    {mark === "recorded" ? (
                      <Mic className="size-3 text-primary" />
                    ) : (
                      <span aria-hidden="true" className={cn("size-2 rounded-full", MARK_DOTS[mark])} />
                    )}
                    {mark === "none" ? (slide.hidden ? "Hidden" : "") : shortMark(mark, audio[slide.id])}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A mark in the room of a row: "No audio", "Audio", "Out of date", "Recording". */
function shortMark(mark: NarrationMark, audio: SlideAudio | undefined): string {
  if (mark === "script") return "No audio";
  if (mark === "stale") return "Out of date";
  if (mark === "recorded") return audio?.imported ? "Imported" : "Recording";
  return MARK_LABELS[mark];
}
