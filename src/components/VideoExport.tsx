import { useEffect, useState } from "react";

import type { Slide, SlideAudio } from "../lib/api";
import { wordsSeconds } from "../lib/narration";
import { cn } from "../lib/utils";
import {
  FRAME_RATES,
  loadVideoOptions,
  MAX_PAUSE,
  MAX_SECONDS,
  MIN_SECONDS,
  pauseProblem,
  saveVideoOptions,
  secondsProblem,
  type VideoOptions,
  videoLength,
} from "../lib/video";
import { useNarration } from "../narrationStore";
import { useApp } from "../store";

const NO_AUDIO: Record<string, SlideAudio> = {};
const input = "h-7 w-full min-w-0 rounded-md border bg-background px-1.5 tabular-nums";

/**
 * Picks how a video export is made: how long each slide is shown, the frame rate, whether
 * animations play or each slide is a still, and whether the narration is spoken (each slide
 * then staying until its narration and the pauses around it end). Remembers the choice.
 */
export function VideoExportPanel(props: {
  /** The slides the video shows: those not hidden. */
  slides: Slide[];
  onExport: (options: VideoOptions) => void;
  onCancel: () => void;
}) {
  const [initial] = useState(loadVideoOptions);
  const [seconds, setSeconds] = useState(String(initial.secondsPerSlide));
  const [fps, setFps] = useState(initial.fps);
  const [animate, setAnimate] = useState(initial.animate);
  const [narration, setNarration] = useState(initial.narration);
  const [before, setBefore] = useState(String(initial.pauseBefore));
  const [after, setAfter] = useState(String(initial.pauseAfter));
  const deck = useApp((s) => s.deck?.id);
  const audio = useNarration((s) => (s.audioDeck === deck ? s.audio : NO_AUDIO));
  const speech = useNarration((s) => s.speech);
  useEffect(() => {
    void useNarration.getState().loadSpeech();
  }, []);

  const narrated = props.slides.filter((s) => (s.narration ?? "").trim() !== "");
  const pending = narrated.filter((s) => audio[s.id]?.state !== "ready");
  const speaks = narration && narrated.length > 0;
  const canSpeak = !!speech?.available && !!speech.modelReady;
  const problem =
    props.slides.length === 0
      ? "Every slide is hidden; show one to export a video."
      : (secondsProblem(seconds) ??
        (speaks ? (pauseProblem(before) ?? pauseProblem(after)) : null) ??
        (speaks && pending.length > 0 && speech && !canSpeak
          ? speech.available
            ? "Download the voice model in the Narration tab, or leave the narration out."
            : "Narration cannot be spoken on this platform; leave it out."
          : null));

  const options = (): VideoOptions => ({
    secondsPerSlide: Number(seconds),
    fps,
    animate,
    narration,
    pauseBefore: Number(before),
    pauseAfter: Number(after),
  });
  const submit = () => {
    if (problem) return;
    saveVideoOptions(options());
    props.onExport(options());
  };

  // Each narrated slide's length: its audio's, or, until it is spoken, an estimate.
  const lengths = props.slides.map((s) => {
    if (!(s.narration ?? "").trim()) return null;
    const ready = audio[s.id];
    return ready?.state === "ready" && ready.seconds !== null ? ready.seconds : wordsSeconds(s.narration ?? "");
  });
  const estimated = speaks && pending.length > 0;
  const count = props.slides.length;
  const summary = `${count} ${count === 1 ? "slide" : "slides"}, ${estimated ? "about " : ""}${videoLength(lengths, options())} long. Hidden slides are left out.`;

  return (
    <form
      className="flex flex-col gap-3 p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="text-sm font-medium">Export video</div>
      <div className="flex items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-muted-foreground">{speaks ? "Seconds per slide, at least" : "Seconds per slide"}</span>
          <input
            aria-label="Seconds per slide"
            type="number"
            inputMode="decimal"
            min={MIN_SECONDS}
            max={MAX_SECONDS}
            step="any"
            value={seconds}
            onChange={(event) => setSeconds(event.target.value)}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Frame rate</span>
          <select
            aria-label="Frame rate"
            value={fps}
            onChange={(event) => setFps(Number(event.target.value))}
            className="h-7 rounded-md border bg-background px-1.5"
          >
            {FRAME_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate} fps
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={animate}
          onChange={(event) => setAnimate(event.target.checked)}
          className="mt-0.5"
        />
        <span className="flex flex-col">
          <span className="font-medium">Play animations</span>
          <span className="text-2xs text-muted-foreground">
            Entrances, slide fades and morphs, as when presenting. Off, each slide is a still of its final frame.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={narration}
          onChange={(event) => setNarration(event.target.checked)}
          className="mt-0.5"
        />
        <span className="flex flex-col">
          <span className="font-medium">Speak narration</span>
          <span className="text-2xs text-muted-foreground">
            {narrated.length === 0
              ? "No shown slide has narration."
              : `Each slide stays until its narration ends.${pending.length > 0 ? ` ${pending.length} ${pending.length === 1 ? "slide is" : "slides are"} spoken first.` : ""}`}
          </span>
        </span>
      </label>
      {speaks && (
        <div className="flex gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-muted-foreground">Pause before (s)</span>
            <input
              aria-label="Pause before narration"
              type="number"
              inputMode="decimal"
              min={0}
              max={MAX_PAUSE}
              step="any"
              value={before}
              onChange={(event) => setBefore(event.target.value)}
              className={input}
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-muted-foreground">Pause after (s)</span>
            <input
              aria-label="Pause after narration"
              type="number"
              inputMode="decimal"
              min={0}
              max={MAX_PAUSE}
              step="any"
              value={after}
              onChange={(event) => setAfter(event.target.value)}
              className={input}
            />
          </label>
        </div>
      )}
      <p
        role={problem ? "alert" : undefined}
        className={cn("min-h-4 text-2xs", problem ? "text-destructive" : "text-muted-foreground")}
      >
        {problem ?? summary}
      </p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded-md border px-2.5 py-1 font-medium hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!!problem}
          className="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          Save video…
        </button>
      </div>
    </form>
  );
}
