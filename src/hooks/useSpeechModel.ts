import { useEffect, useRef, useState } from "react";

import { api, errorMessage, type VoiceDownloadProgress } from "../lib/api";
import { useTauriEvent } from "./useTauriEvent";

/** Where a tool that listens with the speech model is before it listens: `offer` asks to download the model. */
export type SpeechModelPhase = "off" | "offer" | "downloading" | "starting";

/**
 * What a presenter tool that listens on the microphone with the speech model goes through, with
 * its own phases `P` once it listens: the first use offers to download the model (a download
 * already running is waited for), a failure says why, and the microphone goes off when the
 * backend reports `failedEvent` or the component using it goes. `end` turns the microphone off.
 */
export function useSpeechModel<P extends string>(failedEvent: string, end: () => void) {
  const [phase, setPhase] = useState<SpeechModelPhase | P>("off");
  const [modelBytes, setModelBytes] = useState(0);
  const [progress, setProgress] = useState<VoiceDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether the microphone is on for it.
  const active = useRef(false);
  const mounted = useRef(true);

  /** Turns the microphone off, if it is on. */
  const stop = () => {
    if (!active.current) return;
    active.current = false;
    end();
  };

  /** Listening started, in `next`; when the component went meanwhile, the microphone goes off again. */
  const started = (next: P) => {
    active.current = true;
    if (mounted.current) setPhase(next);
    else stop();
  };

  const fail = (reason: unknown) => {
    active.current = false;
    setPhase("off");
    setError(errorMessage(reason));
  };

  /** Downloads the model, then starts listening with `start`. */
  const download = async (start: () => Promise<void>) => {
    setProgress(null);
    setPhase("downloading");
    try {
      await api.downloadVoiceModel();
      if (mounted.current) await start();
    } catch (reason) {
      fail(reason);
    }
  };

  /** Starts listening with `start` once the model is there, or offers to download it. */
  const withModel = async (start: () => Promise<void>) => {
    const status = await api.voiceStatus();
    setModelBytes(status.modelBytes);
    if (status.modelReady) await start();
    // A download already running (started from the chat) is waited for.
    else if (status.downloading) await download(start);
    else setPhase("offer");
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the microphone goes off when the component goes
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
    };
  }, []);

  useTauriEvent<string>(failedEvent, (reason) => {
    if (!active.current) return;
    stop();
    setPhase("off");
    setError(reason);
  });

  useTauriEvent("voice-download", setProgress, phase === "downloading");

  return {
    phase,
    setPhase,
    modelBytes,
    progress,
    error,
    setError,
    stop,
    started,
    fail,
    download,
    withModel,
    /** The microphone went off by the tool's own doing. */
    released: () => {
      active.current = false;
    },
    isMounted: () => mounted.current,
  };
}
