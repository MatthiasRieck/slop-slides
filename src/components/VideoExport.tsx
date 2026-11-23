import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

import type { Slide } from "../lib/api";
import { formatDuration } from "../lib/narrationAudio";
import { layoutTimeline, spokenSeconds } from "../lib/timeline";
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
} from "../lib/video";
import { canSpeakWith, deckProvider, useNarration } from "../narrationStore";
import { useApp } from "../store";
import { CheckField, NumberField } from "./fields";
import { useDeckAudio } from "./narration/useDeckAudio";
import { QUIET_LABEL } from "./styles";

/**
 * Picks how a video export is made: how long each slide is shown, the frame rate, whether
 * animations play or each slide is a still, and whether the narration is spoken (each slide
 * then staying until its narration and the pauses around it end). The choice is remembered as
 * it is made, each time it is one the backend takes: the timeline under the slide and the show's
 * Play lay the deck out with the same times (see `TimingSettings`, which sets them there).
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
  const openDeck = useApp((s) => s.deck);
  const deck = openDeck?.id;
  const audio = useDeckAudio(deck);
  const speech = useNarration((s) => s.speech);
  const id = useId();
  useEffect(() => {
    void useNarration.getState().loadSpeech();
  }, []);

  const narrated = props.slides.filter((s) => (s.narration ?? "").trim() !== "" || audio[s.id]?.recorded);
  const pending = narrated.filter((s) => audio[s.id]?.state !== "ready");
  const speaks = narration && narrated.length > 0;
  const provider = speech && openDeck ? deckProvider(openDeck, speech) : undefined;
  const canSpeak = canSpeakWith(speech, provider);
  const problem =
    props.slides.length === 0
      ? "Every slide is hidden; show one to export a video."
      : (secondsProblem(seconds) ??
        (speaks ? (pauseProblem(before) ?? pauseProblem(after)) : null) ??
        (speaks && pending.length > 0 && speech && !canSpeak
          ? `Add your ${provider?.name ?? "narration service's"} API key in the Narration tab, or leave the narration out.`
          : null));

  const options = (): VideoOptions => ({
    secondsPerSlide: Number(seconds),
    fps,
    animate,
    narration,
    pauseBefore: Number(before),
    pauseAfter: Number(after),
  });
  // Saved as it is set, not only when exporting: each time once it is one that can be used.
  const usable = secondsProblem(seconds) === null && pauseProblem(before) === null && pauseProblem(after) === null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `options` reads the fields listed.
  useEffect(() => {
    if (!usable) return;
    const next = options();
    const saved = loadVideoOptions();
    if ((Object.keys(next) as (keyof VideoOptions)[]).some((key) => next[key] !== saved[key])) saveVideoOptions(next);
  }, [usable, seconds, fps, animate, narration, before, after]);
  const submit = () => {
    if (problem) return;
    props.onExport(options());
  };

  const timed = narration ? props.slides.filter((s) => s.duration != null).length : 0;
  const estimated = speaks && pending.length > 0;
  const count = props.slides.length;
  const length = formatDuration(layoutTimeline(props.slides, spokenSeconds(props.slides, audio), options()).end);
  const summary = `${count} ${count === 1 ? "slide" : "slides"}, ${estimated ? "about " : ""}${length} long. Hidden slides are left out.`;

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
        <NumberField
          label={speaks ? "Seconds per slide without narration" : "Seconds per slide"}
          min={MIN_SECONDS}
          max={MAX_SECONDS}
          value={seconds}
          onChange={setSeconds}
        />
        <Field className="w-auto gap-1">
          <FieldLabel htmlFor={`${id}-fps`} className={QUIET_LABEL}>
            Frame rate
          </FieldLabel>
          <NativeSelect id={`${id}-fps`} size="sm" value={fps} onChange={(event) => setFps(Number(event.target.value))}>
            {FRAME_RATES.map((rate) => (
              <NativeSelectOption key={rate} value={rate}>
                {rate} fps
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <CheckField
        title="Play animations"
        description="Entrances, slide fades and morphs, as when presenting. Off, each slide is a still of its final frame."
        checked={animate}
        onChange={setAnimate}
      />
      <CheckField
        title="Speak narration"
        description={
          narrated.length === 0
            ? "No shown slide has narration."
            : `${timed > 0 ? "Slides timed on the narration timeline keep to it; the others stay until their narration ends." : "Each slide stays until its narration ends."}${pending.length > 0 ? ` ${pending.length} ${pending.length === 1 ? "slide is" : "slides are"} spoken first.` : ""}`
        }
        checked={narration}
        onChange={setNarration}
      />
      {speaks && (
        <div className="flex gap-2">
          <NumberField
            label="Pause before (s)"
            aria-label="Pause before narration"
            min={0}
            max={MAX_PAUSE}
            value={before}
            onChange={setBefore}
          />
          <NumberField
            label="Pause after (s)"
            aria-label="Pause after narration"
            min={0}
            max={MAX_PAUSE}
            value={after}
            onChange={setAfter}
          />
        </div>
      )}
      {problem ? (
        <FieldError className="min-h-4 text-2xs">{problem}</FieldError>
      ) : (
        <FieldDescription className="min-h-4 text-2xs">{summary}</FieldDescription>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="xs" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="xs" type="submit" disabled={!!problem}>
          Save video…
        </Button>
      </div>
    </form>
  );
}
