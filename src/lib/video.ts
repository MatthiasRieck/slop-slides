import { loadText, saveJson } from "./storage";

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

/** What the video is of and how it comes out, beyond its timing (src-tauri/src/video/mod.rs, `Output`). */
export interface VideoOutput {
  slides?: string[];
  includeHidden: boolean;
  /** How tall, in pixels (one of VIDEO_HEIGHTS in ./exportOptions.ts); the slides' own size when null. */
  height: number | null;
  /** Captions of the narration written beside the video, as SubRip or WebVTT. */
  captions: "srt" | "vtt" | null;
}

/** The largest video the encoder writes: 4K. */
const MAX_VIDEO: [number, number] = [3840, 2160];

/**
 * The video's size for slides `width` × `height`, as the backend makes it: theirs, or as tall as
 * `tall` in the same shape, within 4K, in even pixels.
 */
export function videoSize(width: number, height: number, tall: number | null): [number, number] {
  const [w, h] = [Math.max(1, width), Math.max(1, height)];
  const asked = tall === null ? 1 : Math.max(2, tall) / h;
  const scale = Math.min(MAX_VIDEO[0] / w, MAX_VIDEO[1] / h, asked);
  const even = (v: number) => Math.max(2, Math.round((v * scale) / 2) * 2);
  return [even(w), even(h)];
}

/** What the video file is, and where it plays: AV1 is royalty-free but not yet everywhere. */
export const CODEC_NOTE =
  "MP4 with AV1 video and Opus audio. Plays in current browsers, VLC and up-to-date Windows and macOS; older QuickTime, Keynote and PowerPoint may not open it.";

/**
 * About how long a video export still takes: its phase's pace so far (`elapsedMs` since the phase
 * began) carried to its end. Null until there is enough to go on.
 */
export function videoTimeLeft(progress: VideoProgress, elapsedMs: number): number | null {
  if (progress.phase !== "video" || progress.frame < 1 || progress.frames <= progress.frame || elapsedMs < 2000) {
    return null;
  }
  return ((progress.frames - progress.frame) * elapsedMs) / progress.frame / 1000;
}

/** "about 2 min left", "less than a minute left". */
export function timeLeftText(seconds: number): string {
  if (seconds < 60) return "less than a minute left";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `about ${minutes} min left` : `about ${Math.round(minutes / 6) / 10} h left`;
}

/** Payload of `video-export-progress` events. */
export interface VideoProgress {
  /** Speaking narration first (`frame` counts slides), then recording frames. */
  phase: "narration" | "video";
  frame: number;
  frames: number;
}

/** How far along its phase a video export is, in whole percent. */
export function videoPercent(progress: VideoProgress): number {
  if (!(progress.frames > 0)) return 0;
  return Math.min(100, Math.max(0, Math.floor((progress.frame / progress.frames) * 100)));
}

/** What a video export is doing, in full: "Generating narration 2 of 4", "Rendering video 42%". */
export function videoPhase(progress: VideoProgress): string {
  if (progress.phase === "narration") {
    return `Generating narration ${Math.min(progress.frame + 1, progress.frames)} of ${progress.frames}`;
  }
  return `Rendering video ${videoPercent(progress)}%`;
}

/** The same in the room of a button: "Narration 2/4", "42%". */
export function videoPhaseShort(progress: VideoProgress): string {
  if (progress.phase === "narration") {
    return `Narration ${Math.min(progress.frame + 1, progress.frames)}/${progress.frames}`;
  }
  return `${videoPercent(progress)}%`;
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

/** What is stored, and the options read from it: the same options for as long as what is stored stays. */
let read: { raw: string | null; options: VideoOptions } | null = null;
const listeners = new Set<() => void>();

/**
 * The options last set, or the defaults. Besides a video export, the timeline under the slide and
 * the show's Play lay the deck out with the times in them (how long a slide without narration
 * shows, and the pauses around narration), whatever `narration` says. The same object comes back
 * until they change.
 */
export function loadVideoOptions(): VideoOptions {
  const raw = loadText(STORAGE_KEY);
  if (!read || read.raw !== raw) read = { raw, options: parseVideoOptions(raw) };
  return read.options;
}

function parseVideoOptions(raw: string | null): VideoOptions {
  if (raw === null) return DEFAULT_VIDEO_OPTIONS;
  try {
    return readVideoOptions(JSON.parse(raw));
  } catch {
    return DEFAULT_VIDEO_OPTIONS;
  }
}

/** Calls `listener` whenever the options are saved; gives back how to stop. */
export function onVideoOptions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Saved options, each one that is missing or out of range replaced by its default. */
function readVideoOptions(stored: unknown): VideoOptions {
  const saved = stored as Partial<VideoOptions> | null;
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
}

/** Remembers `options`, and tells whoever lays the deck out with them (see `onVideoOptions`). */
export function saveVideoOptions(options: VideoOptions) {
  saveJson(STORAGE_KEY, options);
  for (const listener of listeners) listener();
}
