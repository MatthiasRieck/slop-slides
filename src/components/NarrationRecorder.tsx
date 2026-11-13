import { useEffect, useRef, useState } from "react";

import { type SpeechModelPhase, useSpeechModel } from "../hooks/useSpeechModel";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { api, type NarrationRecordMode } from "../lib/api";
import { formatElapsed } from "./presenter/time";

export type RecorderPhase = SpeechModelPhase | "recording" | "saving";

/**
 * Takes down what the presenter says while they go through the slides, to make the deck's
 * narration from: as `text` (each slide's narration grows, ready to be cleaned up in the Narration
 * tab) or as `audio` (their voice is the slide's narration audio). What is said always goes to
 * the end of the slide on screen, so going back to a slide adds to it. The backend cuts the
 * recording by slide; this tells it about each slide as it comes. Only text needs the speech
 * model, offered on first use. Lasts as long as the component using it (the show, not the presenter
 * view that displays it): the microphone goes off with it, and what was recorded is kept.
 */
export function useNarrationRecorder(deck: string, slide: string | null) {
  // Ends the recording, if it runs; what was said is kept.
  const model = useSpeechModel<"recording" | "saving">(
    "narration-record-failed",
    () => void api.stopNarrationRecording(),
  );
  const { phase, setPhase } = model;
  const [mode, setMode] = useState<NarrationRecordMode>("text");
  // When the recording running started, for how long it has run.
  const [since, setSince] = useState<number | null>(null);
  const slideRef = useRef(slide);
  slideRef.current = slide;

  const record = async (next: NarrationRecordMode) => {
    const from = slideRef.current;
    if (!from) return setPhase("off");
    setPhase("starting");
    await api.startNarrationRecording(deck, from, next);
    setSince(Date.now());
    model.started("recording");
  };

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
    if (phase === "offer") return setPhase("off");
    if (phase !== "off") return;
    setMode(next);
    try {
      if (next === "audio") return await record(next);
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
            : "Recording audio: your voice is added to the narration of the slide on screen."}
      </span>
      <RecordingTime since={props.recorder.since} />
    </div>
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
