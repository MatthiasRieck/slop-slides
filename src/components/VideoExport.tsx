import { AudioLines } from "lucide-react";
import { useEffect, useState } from "react";

import type { Deck } from "../lib/api";
import { VIDEO_HEIGHTS } from "../lib/exportOptions";
import { formatDuration } from "../lib/narrationAudio";
import { generationSize } from "../lib/narrationSize";
import { pixelsOf } from "../lib/slideSize";
import { layoutTimeline, spokenSeconds } from "../lib/timeline";
import { plural } from "../lib/utils";
import {
  CODEC_NOTE,
  FRAME_RATES,
  loadVideoOptions,
  saveVideoOptions,
  type VideoOptions,
  videoSize,
} from "../lib/video";
import { canSpeakWith, deckProvider, useNarration } from "../narrationStore";
import { useApp } from "../store";
import { useExports, videoRunning } from "../store/exports";
import { Button } from "./Button";
import { ExportShell, Row, Segmented, useExportForm } from "./export/ExportShell";
import { startExport } from "./export/run";
import { CheckboxRow, selectClass } from "./Field";
import { TimingLine } from "./narration/TimingSettings";
import { useDeckAudio } from "./narration/useDeckAudio";
import { useDeckVideoOptions } from "./narration/useVideoOptions";

/** "1080p", "4K", or the slides' own size. */
const heightName = (height: number | null) => (height === null ? "Slide size" : height === 2160 ? "4K" : `${height}p`);

/**
 * The video export's dialog: which slides, how large, the frame rate, whether animations play or
 * each slide is a still, whether the narration is spoken (each slide then staying until its
 * narration and the pauses around it end), and captions of it beside the video. How long slides
 * show and the pauses are the deck's own times, set in one place (see `TimingSettings`) and only
 * shown here, with the button that changes them. The rest is remembered as it is chosen.
 * Narration that still has to be spoken is said first, which the dialog says on a line of its
 * own, with how much goes to the service.
 */
export function VideoExportDialog(props: { deck: Deck; onClose: () => void }) {
  const form = useExportForm("video", props.deck);
  const { slides, scope } = form.chosen;
  const { videoHeight, captions } = form.choices;
  const [initial] = useState(loadVideoOptions);
  const [fps, setFps] = useState(initial.fps);
  const [animate, setAnimate] = useState(initial.animate);
  const [narration, setNarration] = useState(initial.narration);
  const deck = props.deck.id;
  const timing = useDeckVideoOptions(deck);
  const audio = useDeckAudio(deck);
  const speech = useNarration((s) => s.speech);
  const busy = useExports(videoRunning);
  useEffect(() => {
    void useNarration.getState().loadSpeech();
  }, []);

  const narrated = slides.filter((s) => (s.narration ?? "").trim() !== "" || audio[s.id]?.recorded);
  const pending = narrated.filter((s) => audio[s.id]?.state !== "ready");
  const speaks = narration && narrated.length > 0;
  const provider = speech ? deckProvider(props.deck, speech) : undefined;
  const canSpeak = canSpeakWith(speech, provider);
  const needsKey = speaks && pending.length > 0 && !!speech && !canSpeak;
  const problem = busy
    ? "A video is being exported. Wait for it to finish, or cancel it from the Export button."
    : needsKey
      ? `Add your ${provider?.name ?? "narration service's"} API key, or leave the narration out.`
      : null;

  const options = (): VideoOptions => ({
    secondsPerSlide: timing.secondsPerSlide,
    fps,
    animate,
    narration,
    pauseBefore: timing.pauseBefore,
    pauseAfter: timing.pauseAfter,
  });
  // Saved as it is set, not only when exporting; the times are the deck's, and stay as they are here.
  useEffect(() => {
    const saved = loadVideoOptions();
    if (saved.fps !== fps || saved.animate !== animate || saved.narration !== narration) {
      saveVideoOptions({ ...saved, fps, animate, narration });
    }
  }, [fps, animate, narration]);
  const showNarration = () => {
    props.onClose();
    useApp.getState().showNarration();
  };
  const save = () => {
    props.onClose();
    void startExport(props.deck, {
      format: "video",
      options: options(),
      output: { ...scope, height: videoHeight, captions: speaks ? captions : null },
    });
  };

  const timed = narration ? slides.filter((s) => s.duration != null).length : 0;
  const estimated = speaks && pending.length > 0;
  const length = formatDuration(layoutTimeline(slides, spokenSeconds(slides, audio), options()).end);
  const canvas = pixelsOf(props.deck);
  const [width, height] = videoSize(canvas.width, canvas.height, videoHeight);
  const summary = `${plural(slides.length, "slide")}, ${estimated ? "about " : ""}${length} long, ${width} × ${height} px.`;
  const toSay = generationSize(pending, audio);

  return (
    <ExportShell
      form={form}
      summary={summary}
      problem={problem}
      saveLabel="Save video…"
      note={CODEC_NOTE}
      onSave={save}
      onClose={props.onClose}
    >
      <Row label="Resolution">
        <Segmented
          label="Resolution"
          name="export-video-height"
          options={[null, ...VIDEO_HEIGHTS].map(String)}
          labels={(value) => heightName(value === "null" ? null : Number(value))}
          value={String(videoHeight)}
          onChange={(value) => form.change({ videoHeight: value === "null" ? null : Number(value) })}
        />
      </Row>
      <Row label="Frame rate">
        <select
          aria-label="Frame rate"
          value={fps}
          onChange={(event) => setFps(Number(event.target.value))}
          className={`${selectClass} self-start`}
        >
          {FRAME_RATES.map((rate) => (
            <option key={rate} value={rate}>
              {rate} fps
            </option>
          ))}
        </select>
      </Row>
      <Row label="Timing">
        <TimingLine deck={deck} />
      </Row>
      <Row label="Playback">
        <CheckboxRow
          title="Play animations"
          description="Entrances, slide fades and morphs, as when presenting. Off, each slide is a still of its final frame."
          checked={animate}
          onChange={setAnimate}
        />
        <CheckboxRow
          title="Speak narration"
          description={
            narrated.length === 0
              ? "No slide in the video has narration."
              : timed > 0
                ? "Slides timed on the narration timeline keep to it; the others stay until their narration ends."
                : "Each slide stays until its narration ends."
          }
          checked={narration}
          onChange={setNarration}
        />
        {narrated.length === 0 && (
          <Button size="md" className="self-start" onClick={showNarration}>
            <AudioLines />
            Add narration
          </Button>
        )}
        {speaks && (
          <CheckboxRow
            title="Captions"
            description="The narration as subtitles, in a file beside the video for players and video sites."
            checked={captions !== null}
            onChange={(on) => form.change({ captions: on ? "srt" : null })}
          />
        )}
        {speaks && captions !== null && (
          <Segmented
            label="Captions file"
            name="export-video-captions"
            options={["srt", "vtt"] as const}
            labels={(value) => (value === "srt" ? "SubRip (.srt)" : "WebVTT (.vtt)")}
            value={captions}
            onChange={(value) => form.change({ captions: value })}
          />
        )}
      </Row>
      {speaks && pending.length > 0 && canSpeak && (
        <p data-testid="spoken-first" className="flex items-start gap-1.5 rounded-md bg-warning/10 p-2 text-2xs">
          <AudioLines className="mt-px size-3.5 shrink-0 text-warning" />
          <span>
            {pending.length} {pending.length === 1 ? "slide is" : "slides are"} spoken by{" "}
            {provider?.name ?? "the service"} first ({toSay.characters.toLocaleString("en-US")} characters, about{" "}
            {formatDuration(toSay.seconds)} of audio).
          </span>
        </p>
      )}
      {needsKey && (
        <Button size="md" className="self-start" onClick={showNarration}>
          Open Narration settings
        </Button>
      )}
    </ExportShell>
  );
}
