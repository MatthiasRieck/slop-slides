/** How a video export is made (src-tauri/src/video.rs reads the same fields). */
export interface VideoOptions {
  /** How long each slide is shown, in seconds; with narration, at least. */
  secondsPerSlide: number;
  /** Frames per second, one of FRAME_RATES. */
  fps: number;
  /** Play entrance animations, slide fades and morphs; otherwise each slide is a still. */
  animate: boolean;
  /** Say each slide's narration over it, the slide staying until it ends. */
  narration: boolean;
  /** Silence before and after a slide's narration, in seconds. */
  pauseBefore: number;
  pauseAfter: number;
}

/** Payload of `video-export-progress` events. */
export interface VideoProgress {
  /** Speaking narration first (`frame` counts slides), then recording frames. */
  phase: "narration" | "video";
  frame: number;
  frames: number;
}

/** The frame rates the backend encodes. */
export const FRAME_RATES = [24, 30, 60] as const;
/** The shortest and longest time a slide may be shown, in seconds, as the backend allows. */
export const MIN_SECONDS = 0.5;
export const MAX_SECONDS = 600;
/** The longest pause around a slide's narration, in seconds, as the backend allows. */
export const MAX_PAUSE = 10;

export const DEFAULT_VIDEO_OPTIONS: VideoOptions = {
  secondsPerSlide: 5,
  fps: 30,
  animate: true,
  narration: true,
  pauseBefore: 0.5,
  pauseAfter: 1,
};

/** The backend's error for an export the user cancelled. */
export const VIDEO_CANCELLED = "the video export was cancelled";

const STORAGE_KEY = "slopslide.video";

/** What is wrong with showing each slide for `seconds`, or null when nothing is. */
export function secondsProblem(seconds: string): string | null {
  const value = Number(seconds);
  if (seconds.trim() === "" || !Number.isFinite(value)) return "Enter how many seconds each slide is shown.";
  if (value < MIN_SECONDS || value > MAX_SECONDS)
    return `Show each slide for ${MIN_SECONDS} to ${MAX_SECONDS} seconds.`;
  return null;
}

/** What is wrong with a pause of `seconds` around narration, or null when nothing is. */
export function pauseProblem(seconds: string): string | null {
  const value = Number(seconds);
  if (seconds.trim() === "" || !Number.isFinite(value)) return "Enter the pauses around narration in seconds.";
  if (value < 0 || value > MAX_PAUSE) return `Pause 0 to ${MAX_PAUSE} seconds around narration.`;
  return null;
}

/**
 * How many frames a slide is shown for, as the backend counts them: the set time, or longer to
 * fit its narration (`narration` seconds, null without) and the pauses around it.
 */
export function slideFrames(options: VideoOptions, narration: number | null): number {
  const least = Math.max(1, Math.round(options.secondsPerSlide * options.fps));
  if (!options.narration || narration === null) return least;
  return Math.max(least, Math.ceil((options.pauseBefore + narration + options.pauseAfter) * options.fps));
}

/**
 * The video's length, as "1:05", for slides whose narration lasts `narrations` seconds each
 * (null for a slide without).
 */
export function videoLength(narrations: (number | null)[], options: VideoOptions): string {
  const frames = narrations.reduce<number>((sum, seconds) => sum + slideFrames(options, seconds), 0);
  const total = Math.round(frames / options.fps);
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

/** The options last used, or the defaults. */
export function loadVideoOptions(): VideoOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<VideoOptions> | null;
    if (!saved || typeof saved !== "object") return DEFAULT_VIDEO_OPTIONS;
    const seconds = Number(saved.secondsPerSlide);
    const pause = (value: unknown, fallback: number) => {
      const n = Number(value);
      return value !== undefined && Number.isFinite(n) && n >= 0 && n <= MAX_PAUSE ? n : fallback;
    };
    return {
      secondsPerSlide:
        Number.isFinite(seconds) && seconds >= MIN_SECONDS && seconds <= MAX_SECONDS
          ? seconds
          : DEFAULT_VIDEO_OPTIONS.secondsPerSlide,
      fps: FRAME_RATES.includes(saved.fps as (typeof FRAME_RATES)[number])
        ? (saved.fps as number)
        : DEFAULT_VIDEO_OPTIONS.fps,
      animate: typeof saved.animate === "boolean" ? saved.animate : DEFAULT_VIDEO_OPTIONS.animate,
      narration: typeof saved.narration === "boolean" ? saved.narration : DEFAULT_VIDEO_OPTIONS.narration,
      pauseBefore: pause(saved.pauseBefore, DEFAULT_VIDEO_OPTIONS.pauseBefore),
      pauseAfter: pause(saved.pauseAfter, DEFAULT_VIDEO_OPTIONS.pauseAfter),
    };
  } catch {
    return DEFAULT_VIDEO_OPTIONS;
  }
}

export function saveVideoOptions(options: VideoOptions) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
}
