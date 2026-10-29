/** How a video export is made (src-tauri/src/video.rs reads the same fields). */
export interface VideoOptions {
  /** How long each slide is shown, in seconds. */
  secondsPerSlide: number;
  /** Frames per second, one of FRAME_RATES. */
  fps: number;
  /** Play entrance animations, slide fades and morphs; otherwise each slide is a still. */
  animate: boolean;
}

/** The frame rates the backend encodes. */
export const FRAME_RATES = [24, 30, 60] as const;
/** The shortest and longest time a slide may be shown, in seconds, as the backend allows. */
export const MIN_SECONDS = 0.5;
export const MAX_SECONDS = 600;

export const DEFAULT_VIDEO_OPTIONS: VideoOptions = { secondsPerSlide: 5, fps: 30, animate: true };

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

/** The video's length for `slides` slides of `seconds` each at `fps`, as "1:05". */
export function videoLength(slides: number, seconds: number, fps: number): string {
  // Each slide is a whole number of frames (at least one), as the backend counts them.
  const total = Math.round((slides * Math.max(1, Math.round(seconds * fps))) / fps);
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
    return {
      secondsPerSlide:
        Number.isFinite(seconds) && seconds >= MIN_SECONDS && seconds <= MAX_SECONDS
          ? seconds
          : DEFAULT_VIDEO_OPTIONS.secondsPerSlide,
      fps: FRAME_RATES.includes(saved.fps as (typeof FRAME_RATES)[number])
        ? (saved.fps as number)
        : DEFAULT_VIDEO_OPTIONS.fps,
      animate: typeof saved.animate === "boolean" ? saved.animate : DEFAULT_VIDEO_OPTIONS.animate,
    };
  } catch {
    return DEFAULT_VIDEO_OPTIONS;
  }
}

export function saveVideoOptions(options: VideoOptions) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
}
