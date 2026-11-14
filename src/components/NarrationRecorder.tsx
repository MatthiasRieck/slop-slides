import { useEffect, useRef, useState } from "react";

import { type SpeechModelPhase, useSpeechModel } from "../hooks/useSpeechModel";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { api, type NarrationRecordMode } from "../lib/api";
import { formatElapsed } from "./presenter/time";

export type RecorderPhase = SpeechModelPhase | "countdown" | "recording" | "saving";

/** How long a recording of audio counts down before the microphone is on, in seconds. */
export const COUNTDOWN_SECONDS = 3;

/**
 * Takes down what is said over the slides, to make the deck's narration from: as `text` (each
 * slide's narration grows, ready to be polished in the Narration tab) or as `audio` (the voice
 * is the slide's narration audio). It records the slide it is given, and when that changes while
 * it records (a show going through its slides), the next one: the backend cuts the recording by
 * slide, this tells it about each slide as it comes.
 *
 * Audio is a take: it starts after a countdown (3, 2, 1, so the click and the breath are not in
 * it; pressing again meanwhile calls it off), and what is kept for a slide takes the place of the
 * recording that slide had, so recording a slide again replaces its take. Within one recording,
 * coming back to a slide adds to what was just said over it. Text always adds to the slide's
 * script. Only text needs the speech model, offered on first use.
 *
 * Lasts as long as the component using it (the show, not the presenter view that displays it; the
 * Narration tab's slide): the microphone goes off with it, and what was recorded is kept.
 */
export function useNarrationRecorder(deck: string, slide: string | null) {
  // Ends the recording, if it runs; what was said is kept.
  const model = useSpeechModel<"countdown" | "recording" | "saving">(
    "narration-record-failed",
    () => void api.stopNarrationRecording(),
  );
  const { phase, setPhase } = model;
  const [mode, setMode] = useState<NarrationRecordMode>("text");
  // When the recording running started, for how long it has run.
  const [since, setSince] = useState<number | null>(null);
  // The seconds left of the countdown.
  const [count, setCount] = useState(0);
  const slideRef = useRef(slide);
  slideRef.current = slide;

  const record = async (next: NarrationRecordMode) => {
    const from = slideRef.current;
    if (!from) return setPhase("off");
    setPhase("starting");
    // Audio is a take of its own; text goes on from the script.
    await api.startNarrationRecording(deck, from, next, next === "audio");
    setSince(Date.now());
    model.started("recording");
  };

  // The countdown, a second at a time; at its end the microphone goes on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs for each second of the countdown.
  useEffect(() => {
    if (phase !== "countdown") return;
    const timer = setTimeout(() => {
      if (count > 1) return setCount(count - 1);
      record("audio").catch(model.fail);
    }, 1000);
    return () => clearTimeout(timer);
  }, [phase, count]);

  const stop = async () => {
    model.released();
    setPhase("saving");
    try {
      await api.stopNarrationRecording();
      if (model.isMounted()) setPhase("off");
    } catch (reason) {
      model.fail(reason);
    }
  };

  const toggle = async (next: NarrationRecordMode) => {
    model.setError(null);
    if (phase === "recording") return mode === next ? stop() : undefined;
    if (phase === "offer" || phase === "countdown") return setPhase("off");
    if (phase !== "off") return;
    setMode(next);
    try {
      if (next === "audio") {
        setCount(COUNTDOWN_SECONDS);
        return setPhase("countdown");
      }
      await model.withModel(() => record(next));
    } catch (reason) {
      model.fail(reason);
    }
  };

  useEffect(() => {
    if (phase === "recording" && slide) void api.narrationRecordingSlide(slide);
  }, [phase, slide]);

  return {
    phase,
    mode,
    since: phase === "recording" ? since : null,
    /** The seconds left before the microphone goes on; 0 unless it counts down. */
    count: phase === "countdown" ? count : 0,
    modelBytes: model.modelBytes,
    progress: model.progress,
    error: model.error,
    toggle,
    download: () => model.download(() => record("text")),
    decline: () => setPhase("off"),
  };
}

/** The recorder of a show, as `useNarrationRecorder` gives it. */
export type NarrationRecorder = ReturnType<typeof useNarrationRecorder>;

/** How long the recording has run, like `1:05`, counting on every second; nothing when none runs. */
export function RecordingTime({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (since === null) return null;
  return (
    <span data-testid="recording-time" title="How long the recording has run" className="tabular-nums">
      {formatElapsed(now - since)}
    </span>
  );
}

/** What is being recorded, for how long, and that the microphone hears the presenter. */
export function RecordingStatus(props: { recorder: NarrationRecorder; locked: boolean }) {
  const { phase, mode } = props.recorder;
  if (phase === "countdown")
    return (
      <p role="status" className="shrink-0 rounded-lg bg-destructive/15 p-2 text-destructive text-xs">
        Recording starts in {props.recorder.count}… Press the button again to call it off.
      </p>
    );
  if (phase === "saving")
    return (
      <p role="status" className="shrink-0 rounded-lg bg-foreground/5 p-2 text-foreground/60 text-xs">
        Saving the recording…
      </p>
    );
  if (phase !== "recording") return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 rounded-lg bg-destructive/15 p-2 text-destructive text-xs"
    >
      <LevelDot />
      <span className="min-w-0 flex-1">
        {props.locked
          ? "This slide is locked: what you say over it is not kept."
          : mode === "text"
            ? "Recording text: what you say is added to the narration of the slide on screen."
            : "Recording audio: your voice becomes the narration of each slide you speak over, in place of an earlier recording of it."}
      </span>
      <RecordingTime since={props.recorder.since} />
    </div>
  );
}

/** How loud the microphone hears the speaker, as a bar that fills with it: that it hears them at all, and not too loud. */
export function LevelMeter() {
  const [level, setLevel] = useState(0);
  useTauriEvent("voice-level", setLevel);
  const heard = Math.min(1, Math.max(0, level));
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native meter cannot be drawn in the recording's colors in every webview.
    <span
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(heard * 100)}
      data-testid="recording-meter"
      className="block h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-destructive/20"
    >
      <span
        className="block size-full origin-left rounded-full bg-destructive transition-transform duration-75"
        style={{ transform: `scaleX(${heard})` }}
      />
    </span>
  );
}

/** A dot that swells with how loud the microphone hears the presenter. */
export function LevelDot() {
  const [level, setLevel] = useState(0);
  useTauriEvent("voice-level", setLevel);
  return (
    <span
      aria-hidden
      data-testid="recording-level"
      className="size-2.5 shrink-0 rounded-full bg-destructive transition-transform duration-75"
      style={{ transform: `scale(${1 + level})` }}
    />
  );
}
