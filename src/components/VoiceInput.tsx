import { Check, Mic } from "lucide-react";
import { type Ref, type RefObject, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { api, type VoiceDownloadProgress } from "../lib/api";
import { openLayer } from "../lib/layers";
import { cn } from "../lib/utils";
import { formatBytes, WAVEFORM_BAR, WAVEFORM_STEP, waveformBars } from "../lib/voice";
import { showError } from "../store";

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

/**
 * The microphone's level over time, coming out of the stop button on its right. Once `live`
 * is off (the words are being transcribed) the bars keep moving and run out, leaving a dotted line.
 */
function Waveform(props: { level: RefObject<number>; live: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef(props);
  input.current = props;

  useEffect(() => {
    const el = canvas.current;
    const context = el?.getContext("2d");
    if (!el || !context) return;
    const color = getComputedStyle(el).color;
    const levels: number[] = [];
    let last = performance.now();
    let peak = 0;
    let frame = 0;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const { level, live } = input.current;
      peak = Math.max(peak, live ? level.current : 0);
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
      context.strokeStyle = color;
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
      <canvas
        ref={canvas}
        aria-hidden
        data-testid="voice-waveform"
        className="absolute inset-0 size-full text-destructive"
      />
    </div>
  );
}

/**
 * A microphone button for a text field: click to dictate (the text shows up as you speak), click
 * again (it shows a check meanwhile) to keep it. The first use offers to download the speech model, which then runs locally.
 *
 * - `label`: what the button does while idle, "Dictate a message" by default.
 * - `portal`: no longer needed, and ignored: the download offer is a popover that another one it
 *   opens from knows as its own, so a press on it is not a press outside of that.
 */
export function VoiceInput(
  props: DictationHandlers & { ref?: Ref<VoiceInputHandle>; label?: string; portal?: boolean },
) {
  const handlers = useRef(props);
  handlers.current = props;
  const sendWhenDone = useRef(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [modelBytes, setModelBytes] = useState(0);
  const [progress, setProgress] = useState<VoiceDownloadProgress | null>(null);
  // The microphone's level comes many times a second and is only drawn: by the waveform, on its
  // own frames, and as the ring around the button, which is moved by hand. It renders nothing.
  const level = useRef(0);
  const ring = useRef<HTMLSpanElement>(null);
  const setLevel = (value: number) => {
    level.current = value;
    if (ring.current) ring.current.style.transform = `scale(${1 + value * 0.35})`;
  };
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const fail = (error: unknown) => {
    setPhase("idle");
    showError(error);
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

  useTauriEvent("voice-level", setLevel, phase === "recording");
  useTauriEvent<string>("voice-partial", (text) => handlers.current.onPartial(text), phase === "recording");
  useTauriEvent("voice-download", setProgress, phase === "downloading");

  // Escape throws the recording away, before it closes anything opened earlier.
  useEffect(() => {
    if (phase === "recording") return openLayer(cancel);
  }, [phase, cancel]);

  // Leaving the composer mid-recording releases the microphone.
  useEffect(() => cancel, [cancel]);

  const closeOffer = useCallback(() => setPhase((p) => (p === "offer" ? "idle" : p)), []);
  const percent = progress && progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : 0;
  const label = props.label ?? "Dictate a message";
  const title = {
    idle: label,
    offer: label,
    downloading: "Downloading the speech model…",
    starting: "Starting the microphone…",
    recording: "Stop dictating (Esc discards it)",
    transcribing: "Transcribing…",
  }[phase];

  const busy = phase === "transcribing" || phase === "starting" || phase === "downloading";
  const offered = phase === "offer" || phase === "downloading";

  return (
    <>
      {(phase === "recording" || phase === "transcribing") && <Waveform level={level} live={phase === "recording"} />}
      {/* The offer opens when the model turns out to be missing, not on the press itself: the
          button only ever closes it (and a download, once started, stays on show). */}
      <Popover
        open={offered}
        onOpenChange={(open) => {
          if (!open) closeOffer();
        }}
      >
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void click()}
              tooltip={title}
              aria-label={title}
              aria-pressed={phase === "recording"}
              disabled={phase === "starting" || phase === "transcribing"}
              className={cn(
                "relative shrink-0 rounded-full",
                phase === "recording"
                  ? "bg-destructive/15 text-destructive hover:bg-destructive/25 hover:text-destructive aria-pressed:bg-destructive/15 aria-pressed:text-destructive dark:hover:bg-destructive/25"
                  : "text-muted-foreground",
              )}
            />
          }
        >
          {phase === "recording" && (
            <span
              ref={ring}
              aria-hidden
              data-testid="voice-level"
              className="pointer-events-none absolute inset-0 rounded-full border-2 border-destructive/60 transition-transform duration-75"
            />
          )}
          {busy ? (
            <Spinner aria-hidden="true" />
          ) : phase === "recording" ? (
            // A check, not a square: it keeps what was said, where a square would look like stopping the agent.
            <Check />
          ) : (
            <Mic />
          )}
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-[280px] gap-0 p-3 text-xs">
          {phase === "offer" ? (
            <>
              <PopoverTitle className="text-xs">Download the speech model?</PopoverTitle>
              <PopoverDescription className="mt-1 text-xs">
                Voice input transcribes on this computer with Whisper. The model ({formatBytes(modelBytes)}) is
                downloaded once to ~/.slopslides/models.
              </PopoverDescription>
              <div className="mt-3 flex justify-end gap-1.5">
                <Button variant="ghost" size="xs" onClick={closeOffer} className="text-muted-foreground">
                  Not now
                </Button>
                <Button size="xs" onClick={() => void download()}>
                  Download
                </Button>
              </div>
            </>
          ) : (
            <>
              <PopoverTitle className="text-xs">Downloading the speech model…</PopoverTitle>
              <Progress aria-label="Speech model download" value={percent} className="mt-2 gap-0" />
              <p className="mt-1.5 text-muted-foreground">
                {progress ? `${formatBytes(progress.received)} of ${formatBytes(progress.total)}` : "Starting…"}
              </p>
            </>
          )}
        </PopoverContent>
      </Popover>
    </>
  );
}
