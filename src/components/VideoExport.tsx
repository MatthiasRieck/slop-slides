import { useState } from "react";

import { cn } from "../lib/utils";
import {
  FRAME_RATES,
  loadVideoOptions,
  MAX_SECONDS,
  MIN_SECONDS,
  saveVideoOptions,
  secondsProblem,
  type VideoOptions,
  videoLength,
} from "../lib/video";

/**
 * Picks how a video export is made: how long each slide is shown, the frame rate, and whether
 * animations play or each slide is a still. Remembers the choice for next time.
 */
export function VideoExportPanel(props: {
  /** The slides the video shows: those not hidden. */
  slides: number;
  onExport: (options: VideoOptions) => void;
  onCancel: () => void;
}) {
  const [initial] = useState(loadVideoOptions);
  const [seconds, setSeconds] = useState(String(initial.secondsPerSlide));
  const [fps, setFps] = useState(initial.fps);
  const [animate, setAnimate] = useState(initial.animate);
  const problem = props.slides === 0 ? "Every slide is hidden; show one to export a video." : secondsProblem(seconds);

  const submit = () => {
    if (problem) return;
    const options = { secondsPerSlide: Number(seconds), fps, animate };
    saveVideoOptions(options);
    props.onExport(options);
  };

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
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-muted-foreground">Seconds per slide</span>
          <input
            aria-label="Seconds per slide"
            type="number"
            inputMode="decimal"
            min={MIN_SECONDS}
            max={MAX_SECONDS}
            step="any"
            value={seconds}
            onChange={(event) => setSeconds(event.target.value)}
            className="h-7 w-full min-w-0 rounded-md border bg-background px-1.5 tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Frame rate</span>
          <select
            aria-label="Frame rate"
            value={fps}
            onChange={(event) => setFps(Number(event.target.value))}
            className="h-7 rounded-md border bg-background px-1.5"
          >
            {FRAME_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate} fps
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={animate}
          onChange={(event) => setAnimate(event.target.checked)}
          className="mt-0.5"
        />
        <span className="flex flex-col">
          <span className="font-medium">Play animations</span>
          <span className="text-2xs text-muted-foreground">
            Entrances, slide fades and morphs, as when presenting. Off, each slide is a still of its final frame.
          </span>
        </span>
      </label>
      <p
        role={problem ? "alert" : undefined}
        className={cn("min-h-4 text-2xs", problem ? "text-destructive" : "text-muted-foreground")}
      >
        {problem ??
          `${props.slides} ${props.slides === 1 ? "slide" : "slides"}, ${videoLength(props.slides, Number(seconds), fps)} long. Hidden slides are left out.`}
      </p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded-md border px-2.5 py-1 font-medium hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!!problem}
          className="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          Save video…
        </button>
      </div>
    </form>
  );
}
