import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

import { api, errorMessage, type NarrationRecordMode, type VoiceDownloadProgress } from "../lib/api";

export type RecorderPhase = "off" | "offer" | "downloading" | "starting" | "recording" | "saving";

/**
 * Takes down what the presenter says while they go through the slides, to make the deck's
 * narration from: as `text` (each slide's narration grows, ready to be cleaned up in the Narration
 * tab) or as `audio` (their voice is the slide's narration audio). What is said always goes to
 * the end of the slide on screen, so going back to a slide adds to it. The backend cuts the
 * recording by slide; this tells it about each slide as it comes. Only text needs the speech
 * model, offered on first use. Lasts as long as the component using it: the microphone goes off
 * with it, and what was recorded is kept.
 */
export function useNarrationRecorder(deck: string, slide: string | null) {
  const [phase, setPhase] = useState<RecorderPhase>("off");
  const [mode, setMode] = useState<NarrationRecordMode>("text");
  const [modelBytes, setModelBytes] = useState(0);
  const [progress, setProgress] = useState<VoiceDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const mounted = useRef(true);
  const slideRef = useRef(slide);
  slideRef.current = slide;

  const fail = (reason: unknown) => {
    active.current = false;
    setPhase("off");
    setError(errorMessage(reason));
  };

  const record = async (next: NarrationRecordMode) => {
    const from = slideRef.current;
    if (!from) return setPhase("off");
    setPhase("starting");
    await api.startNarrationRecording(deck, from, next);
    active.current = true;
    if (mounted.current) setPhase("recording");
    else endRecording(active);
  };

  const download = async () => {
    setProgress(null);
    setPhase("downloading");
    try {
      await api.downloadVoiceModel();
      if (mounted.current) await record("text");
    } catch (reason) {
      fail(reason);
    }
  };

  const stop = async () => {
    active.current = false;
    setPhase("saving");
    try {
      await api.stopNarrationRecording();
      if (mounted.current) setPhase("off");
    } catch (reason) {
      fail(reason);
    }
  };

  const toggle = async (next: NarrationRecordMode) => {
    setError(null);
    if (phase === "recording") return mode === next ? stop() : undefined;
    if (phase === "offer") return setPhase("off");
    if (phase !== "off") return;
    setMode(next);
    try {
      if (next === "audio") return await record(next);
      const status = await api.voiceStatus();
      setModelBytes(status.modelBytes);
      if (status.modelReady) await record(next);
      // A download already running (started from the chat) is waited for.
      else if (status.downloading) await download();
      else setPhase("offer");
    } catch (reason) {
      fail(reason);
    }
  };

  useEffect(() => {
    mounted.current = true;
    const off = listen<string>("narration-record-failed", (event) => {
      if (!active.current) return;
      endRecording(active);
      setPhase("off");
      setError(event.payload);
    });
    return () => {
      mounted.current = false;
      void off.then((fn) => fn());
      endRecording(active);
    };
  }, []);

  useEffect(() => {
    if (phase === "recording" && slide) void api.narrationRecordingSlide(slide);
  }, [phase, slide]);

  useEffect(() => {
    if (phase !== "downloading") return;
    const off = listen<VoiceDownloadProgress>("voice-download", (event) => setProgress(event.payload));
    return () => void off.then((fn) => fn());
  }, [phase]);

  return { phase, mode, modelBytes, progress, error, toggle, download, decline: () => setPhase("off") };
}

/** Ends the recording, if it runs; what was said is kept. */
function endRecording(active: { current: boolean }) {
  if (!active.current) return;
  active.current = false;
  void api.stopNarrationRecording();
}

/** What is being recorded, and that the microphone hears the presenter. */
export function RecordingStatus(props: { recorder: ReturnType<typeof useNarrationRecorder>; locked: boolean }) {
  const { phase, mode } = props.recorder;
  if (phase === "saving")
    return (
      <p role="status" className="shrink-0 rounded-lg bg-white/5 p-2 text-white/60 text-xs">
        Saving the recording…
      </p>
    );
  if (phase !== "recording") return null;
  return (
    <div role="status" className="flex shrink-0 items-center gap-2 rounded-lg bg-red-500/15 p-2 text-red-200 text-xs">
      <LevelDot />
      {props.locked
        ? "This slide is locked: what you say over it is not kept."
        : mode === "text"
          ? "Recording text: what you say is added to the narration of the slide on screen."
          : "Recording audio: your voice is added to the narration of the slide on screen."}
    </div>
  );
}

function LevelDot() {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    const off = listen<number>("voice-level", (event) => setLevel(event.payload));
    return () => void off.then((fn) => fn());
  }, []);
  return (
    <span
      aria-hidden
      data-testid="recording-level"
      className="size-2.5 shrink-0 rounded-full bg-red-500 transition-transform duration-75"
      style={{ transform: `scale(${1 + level})` }}
    />
  );
}
