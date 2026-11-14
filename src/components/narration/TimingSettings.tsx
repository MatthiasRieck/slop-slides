import { useState } from "react";

import {
  loadVideoOptions,
  MAX_PAUSE,
  MAX_SECONDS,
  MIN_SECONDS,
  pauseProblem,
  saveVideoOptions,
  secondsProblem,
} from "../../lib/video";
import { NumberField } from "../Field";

/**
 * The times the deck is laid out with wherever it plays by itself: on the timeline, in the show's
 * Play and in a video. How long a slide without narration shows, and the pauses before and after
 * a slide's narration. They are the video export's options (see `loadVideoOptions`), saved as
 * they are typed, each once it is a time the backend takes; what is not says why.
 */
export function TimingSettings() {
  const [initial] = useState(loadVideoOptions);
  const [seconds, setSeconds] = useState(String(initial.secondsPerSlide));
  const [before, setBefore] = useState(String(initial.pauseBefore));
  const [after, setAfter] = useState(String(initial.pauseAfter));
  const problem = secondsProblem(seconds) ?? pauseProblem(before) ?? pauseProblem(after);

  /** Keeps what was typed, and saves it once it is a time that can be used. */
  const change =
    (
      set: (text: string) => void,
      problemOf: (text: string) => string | null,
      key: "secondsPerSlide" | "pauseBefore" | "pauseAfter",
    ) =>
    (text: string) => {
      set(text);
      if (problemOf(text) === null) saveVideoOptions({ ...loadVideoOptions(), [key]: Number(text) });
    };

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div className="text-sm font-medium">Timing</div>
      <NumberField
        label="Seconds per slide without narration"
        aria-label="Seconds per slide without narration"
        min={MIN_SECONDS}
        max={MAX_SECONDS}
        value={seconds}
        onChange={change(setSeconds, secondsProblem, "secondsPerSlide")}
      />
      <div className="flex gap-2">
        <NumberField
          label="Pause before (s)"
          aria-label="Pause before narration"
          min={0}
          max={MAX_PAUSE}
          value={before}
          onChange={change(setBefore, pauseProblem, "pauseBefore")}
        />
        <NumberField
          label="Pause after (s)"
          aria-label="Pause after narration"
          min={0}
          max={MAX_PAUSE}
          value={after}
          onChange={change(setAfter, pauseProblem, "pauseAfter")}
        />
      </div>
      <p role={problem ? "alert" : undefined} className={problem ? "text-destructive" : "text-muted-foreground"}>
        {problem ??
          "Used by the timeline, the show's Play and a video. A slide timed on the timeline keeps its own length."}
      </p>
    </div>
  );
}
