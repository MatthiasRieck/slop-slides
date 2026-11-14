import { useEffect, useMemo, useRef, useState } from "react";

import { type SpeechModelPhase, useSpeechModel } from "../hooks/useSpeechModel";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { api, type VoiceDownloadProgress } from "../lib/api";
import { markdownText, rehypePieces } from "../lib/markdown";
import { scrollBehavior } from "../lib/motion";
import { follow, type Piece, pieces, startTrack, toScript } from "../lib/teleprompter";
import { cn } from "../lib/utils";
import { formatBytes } from "../lib/voice";
import { ScriptMarkdown } from "./ScriptMarkdown";

export type TeleprompterPhase = SpeechModelPhase | "following";

/** Where the speaker's line stays as the script scrolls: a third of the way down. */
const LINE_AT = 1 / 3;

const pieceClass = (piece: Piece) => (piece.said ? "text-foreground/40" : "");

/**
 * Turns the teleprompter on and off: the microphone is on only while it is following, and the
 * first use offers to download the speech model, which then runs locally. Lasts as long as the
 * component using it (the show, see `useShowSession`, not the presenter view that displays it),
 * so the microphone goes off with the show.
 */
export function useTeleprompter() {
  const model = useSpeechModel<"following">("voice-follow-failed", () => void api.cancelRecording());
  const { phase, setPhase } = model;

  const listenToSpeaker = async () => {
    setPhase("starting");
    await api.followSpeech();
    model.started("following");
  };

  const toggle = async () => {
    model.setError(null);
    if (phase === "following") {
      model.stop();
      return setPhase("off");
    }
    if (phase === "offer") return setPhase("off");
    if (phase !== "off") return;
    try {
      await model.withModel(listenToSpeaker);
    } catch (reason) {
      model.fail(reason);
    }
  };

  return {
    phase,
    modelBytes: model.modelBytes,
    progress: model.progress,
    error: model.error,
    toggle,
    download: () => model.download(listenToSpeaker),
    decline: () => setPhase("off"),
  };
}

/** What a listening tool of the presenter view does with the speech model, and what it says about it. */
export interface Listener {
  phase: string;
  modelBytes: number;
  progress: VoiceDownloadProgress | null;
  error: string | null;
  download: () => Promise<void>;
  decline: () => void;
}

/**
 * What the teleprompter (or another tool that listens, naming what it does as `purpose`) has to
 * say above the script: its first-use offer, progress or failure.
 */
export function TeleprompterNotice({
  teleprompter,
  purpose = "The teleprompter listens on this computer with Whisper.",
}: {
  teleprompter: Listener;
  purpose?: string;
}) {
  const { phase, modelBytes, progress, error } = teleprompter;
  if (error)
    return (
      <p role="alert" className="shrink-0 rounded-lg bg-destructive/15 p-2 text-destructive text-xs">
        {error}
      </p>
    );
  if (phase === "offer")
    return (
      <div className="shrink-0 rounded-lg bg-foreground/5 p-2 text-xs">
        <p className="font-medium">Download the speech model?</p>
        <p className="mt-1 text-foreground/60">
          {purpose} The model ({formatBytes(modelBytes)}) is downloaded once to ~/.slopslides/models.
        </p>
        <div className="mt-2 flex justify-end gap-1.5">
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={teleprompter.decline}
            className="rounded-md px-2 py-1 text-foreground/70 hover:bg-foreground/10 hover:text-foreground"
          >
            Not now
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void teleprompter.download()}
            className="rounded-md bg-foreground px-2 py-1 text-background hover:opacity-90"
          >
            Download
          </button>
        </div>
      </div>
    );
  if (phase === "downloading")
    return (
      <p className="shrink-0 rounded-lg bg-foreground/5 p-2 text-foreground/60 text-xs tabular-nums">
        Downloading the speech model…
        {progress ? ` ${formatBytes(progress.received)} of ${formatBytes(progress.total)}` : ""}
      </p>
    );
  return null;
}

/**
 * The script of one slide (Markdown) as the speaker gets through it: what was said fades and the
 * text scrolls along, wherever they go in it. Give it a new `key` for another script.
 */
export function FollowedScript({ text, className }: { text: string; className?: string }) {
  const script = useMemo(() => toScript(markdownText(text)), [text]);
  const [track, setTrack] = useState(() => startTrack(script));
  const box = useRef<HTMLDivElement>(null);

  useTauriEvent<string>("voice-heard", (heard) => setTrack((current) => follow(script, current, heard)));

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls each time the speaker moves.
  useEffect(() => {
    const el = box.current;
    const line = el?.querySelector<HTMLElement>("[data-current]");
    if (!el || !line) return;
    el.scrollTo?.({ top: line.offsetTop - el.clientHeight * LINE_AT, behavior: scrollBehavior() });
  }, [track.position]);

  return (
    <div ref={box} data-testid="presenter-notes" className={cn("relative", className)}>
      <ScriptMarkdown text={text} rehypePlugins={[[rehypePieces, pieces(script, track), pieceClass]]} />
    </div>
  );
}
