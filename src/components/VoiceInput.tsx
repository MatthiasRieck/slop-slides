import { listen } from "@tauri-apps/api/event";
import { Loader2, Mic, Square } from "lucide-react";
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { api, errorMessage, type VoiceDownloadProgress } from "../lib/api";
import { cn } from "../lib/utils";
import { formatBytes, WAVEFORM_BAR, WAVEFORM_STEP, waveformBars } from "../lib/voice";
import { useApp } from "../store";
import { ComposerPopover } from "./ComposerPopover";

type Phase = "idle" | "offer" | "downloading" | "starting" | "recording" | "transcribing";

/** What the composer does with dictation. */
export interface DictationHandlers {
  /** Recording started. */
  onStart: () => void;
  /** Everything said so far, while recording. */
  onPartial: (text: string) => void;
  /**
   * Dictation is over: what was said, or `""` when it was discarded or failed. `send` is set
   * when it was ended with {@link VoiceInputHandle.finishAndSend} and went through.
   */
  onEnd: (text: string, send: boolean) => void;
}

/** What the composer's send button does with a running dictation. */
export interface VoiceInputHandle {
  /** Stops recording (or lets the transcription finish) and asks for the result to be sent. */
  finishAndSend: () => void;
}

/** How often the waveform takes in a new level, like the backend's `LEVEL_INTERVAL`. */
const WAVEFORM_INTERVAL = 60;
/** The recording color (Tailwind's red-500), as a canvas can't take a class. */
const WAVEFORM_COLOR = "#ef4444";

/**
 * The microphone's level over time, coming out of the stop button on its right. Once `live`
 * is off (the words are being transcribed) the bars keep moving and run out, leaving a dotted line.
 */
function Waveform(props: { level: number; live: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef(props);
  input.current = props;

  useEffect(() => {
    const el = canvas.current;
    const context = el?.getContext("2d");
    if (!el || !context) return;
    const levels: number[] = [];
    let last = performance.now();
    let peak = 0;
    let frame = 0;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const { level, live } = input.current;
      peak = Math.max(peak, live ? level : 0);
      const width = el.clientWidth;
      const height = el.clientHeight;
      while (now - last >= WAVEFORM_INTERVAL) {
        levels.push(peak);
        peak = 0;
        last += WAVEFORM_INTERVAL;
      }
      levels.splice(0, levels.length - Math.ceil(width / WAVEFORM_STEP) - 2);

      const scale = window.devicePixelRatio || 1;
      if (el.width !== Math.round(width * scale) || el.height !== Math.round(height * scale)) {
        el.width = Math.round(width * scale);
        el.height = Math.round(height * scale);
      }
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, width, height);
      context.strokeStyle = WAVEFORM_COLOR;
      context.lineCap = "round";
      context.lineWidth = WAVEFORM_BAR;
      const scroll = Math.max(0, (now - last) / WAVEFORM_INTERVAL);
      for (const bar of waveformBars(levels, width, height, scroll)) {
        // The round caps add a bar's width to the length of the line.
        const reach = (bar.height - WAVEFORM_BAR) / 2;
        context.globalAlpha = bar.opacity;
        context.beginPath();
        context.moveTo(bar.x, height / 2 - reach);
        context.lineTo(bar.x, height / 2 + reach);
        context.stroke();
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="relative h-6 min-w-0 flex-1">
      <canvas ref={canvas} aria-hidden data-testid="voice-waveform" className="absolute inset-0 size-full" />
    </div>
  );
}

/**
 * The composer's microphone button: click to dictate (the text shows up as you speak), click
 * again to keep it. The first use offers to download the speech model, which then runs locally.
 */
export function VoiceInput(props: DictationHandlers & { ref?: Ref<VoiceInputHandle> }) {
  const handlers = useRef(props);
  handlers.current = props;
  const sendWhenDone = useRef(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [modelBytes, setModelBytes] = useState(0);
  const [progress, setProgress] = useState<VoiceDownloadProgress | null>(null);
  const [level, setLevel] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const fail = (error: unknown) => {
    setPhase("idle");
    useApp.getState().setError(errorMessage(error));
  };

  const record = async () => {
    setPhase("starting");
    try {
      await api.startRecording();
      setLevel(0);
      setPhase("recording");
      handlers.current.onStart();
    } catch (error) {
      fail(error);
    }
  };

  const stop = async () => {
    setPhase("transcribing");
    try {
      const text = await api.stopRecording();
      setPhase("idle");
      handlers.current.onEnd(text, sendWhenDone.current);
    } catch (error) {
      handlers.current.onEnd("", false);
      fail(error);
    }
    sendWhenDone.current = false;
  };

  useImperativeHandle(props.ref, () => ({
    finishAndSend: () => {
      sendWhenDone.current = true;
      if (phaseRef.current === "recording") void stop();
    },
  }));

  const download = async () => {
    setProgress(null);
    setPhase("downloading");
    try {
      await api.downloadVoiceModel();
      await record();
    } catch (error) {
      fail(error);
    }
  };

  const click = async () => {
    if (phase === "recording") return stop();
    if (phase === "offer") return setPhase("idle");
    if (phase !== "idle") return;
    try {
      const status = await api.voiceStatus();
      setModelBytes(status.modelBytes);
      if (status.modelReady) await record();
      // A download already running (started before this composer was shown) is waited for.
      else if (status.downloading) await download();
      else setPhase("offer");
    } catch (error) {
      fail(error);
    }
  };

  const cancel = useCallback(() => {
    if (phaseRef.current !== "recording") return;
    setPhase("idle");
    handlers.current.onEnd("", false);
    void api.cancelRecording();
  }, []);

  useEffect(() => {
    if (phase !== "recording" && phase !== "downloading") return;
    let disposed = false;
    const unlisten =
      phase === "recording"
        ? [
            listen<number>("voice-level", (e) => !disposed && setLevel(e.payload)),
            listen<string>("voice-partial", (e) => !disposed && handlers.current.onPartial(e.payload)),
          ]
        : [listen<VoiceDownloadProgress>("voice-download", (e) => !disposed && setProgress(e.payload))];
    return () => {
      disposed = true;
      for (const u of unlisten) void u.then((fn) => fn());
    };
  }, [phase]);

  // Escape throws the recording away.
  useEffect(() => {
    if (phase !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancel();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [phase, cancel]);

  // Leaving the composer mid-recording releases the microphone.
  useEffect(() => cancel, [cancel]);

  const closeOffer = useCallback(() => setPhase((p) => (p === "offer" ? "idle" : p)), []);
  const percent = progress && progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : 0;
  const title = {
    idle: "Dictate a message",
    offer: "Dictate a message",
    downloading: "Downloading the speech model…",
    starting: "Starting the microphone…",
    recording: "Stop dictating (Esc discards it)",
    transcribing: "Transcribing…",
  }[phase];

  return (
    <>
      {(phase === "recording" || phase === "transcribing") && <Waveform level={level} live={phase === "recording"} />}
      <button
        ref={button}
        type="button"
        onClick={() => void click()}
        title={title}
        aria-label={title}
        aria-pressed={phase === "recording"}
        disabled={phase === "starting" || phase === "transcribing"}
        className={cn(
          "relative flex size-8 shrink-0 items-center justify-center rounded-full",
          phase === "recording"
            ? "bg-red-500/15 text-red-500 hover:bg-red-500/25"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        {phase === "recording" && (
          <span
            aria-hidden
            data-testid="voice-level"
            className="pointer-events-none absolute inset-0 rounded-full border-2 border-red-500/60 transition-transform duration-75"
            style={{ transform: `scale(${1 + level * 0.35})` }}
          />
        )}
        {phase === "transcribing" || phase === "starting" || phase === "downloading" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : phase === "recording" ? (
          <Square className="size-3 fill-current" />
        ) : (
          <Mic className="size-4" />
        )}
      </button>
      {(phase === "offer" || phase === "downloading") && (
        <ComposerPopover anchor={button} onClose={closeOffer} width={280} className="p-3 text-xs">
          {phase === "offer" ? (
            <>
              <p className="font-medium text-foreground">Download the speech model?</p>
              <p className="mt-1 text-muted-foreground">
                Voice input transcribes on this computer with Whisper. The model ({formatBytes(modelBytes)}) is
                downloaded once to ~/.slopslides/models.
              </p>
              <div className="mt-3 flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={closeOffer}
                  className="rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  Not now
                </button>
                <button
                  type="button"
                  onClick={() => void download()}
                  className="rounded-md bg-primary px-2 py-1 text-primary-foreground hover:opacity-90"
                >
                  Download
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="font-medium text-foreground">Downloading the speech model…</p>
              <div
                role="progressbar"
                aria-label="Speech model download"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
              </div>
              <p className="mt-1.5 text-muted-foreground">
                {progress ? `${formatBytes(progress.received)} of ${formatBytes(progress.total)}` : "Starting…"}
              </p>
            </>
          )}
        </ComposerPopover>
      )}
    </>
  );
}
