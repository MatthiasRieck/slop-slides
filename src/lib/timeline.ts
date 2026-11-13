import type { Slide, SlideAudio, SlideTiming } from "./api";
import { markdownText } from "./markdown";
import { wordsSeconds } from "./narration";
import { slideFrames, type VideoOptions } from "./video";

/** The shortest and longest a slide can be shown, in seconds, as the backend allows. */
export const MIN_DURATION = 0.5;
export const MAX_DURATION = 3600;

/** A shown slide on the timeline, from `start` to `end` in seconds. */
export interface TimelineSlide {
  id: string;
  start: number;
  end: number;
  locked: boolean;
  /** The length set on the timeline; null when it follows its narration. */
  duration: number | null;
  /** The narration start set on the timeline; null for the pause before. */
  narrationStart: number | null;
}

/** A slide's narration on the timeline. It need not lie inside the slide. */
export interface TimelineClip {
  slide: string;
  start: number;
  end: number;
}

export interface Timeline {
  slides: TimelineSlide[];
  clips: TimelineClip[];
  /** How long it all lasts, in seconds. */
  end: number;
}

/**
 * How `slides` play out, as `timeline` in src-tauri/src/video.rs works it out for a video. A
 * slide shows for its `duration`, or else as long as `slideFrames` says; its narration, lasting
 * `spoken[id]` seconds, starts `narrationStart` (or the pause before) into it. Narration never
 * talks over the narration before it, and the last slide stays until the last word. Without
 * `options.narration`, none of that applies: every slide shows for the set time.
 */
export function layoutTimeline(
  slides: Slide[],
  spoken: Record<string, number | null>,
  options: VideoOptions,
): Timeline {
  const { fps } = options;
  const out: TimelineSlide[] = [];
  const clips: TimelineClip[] = [];
  let shown = 0;
  let voice = 0;
  // Where the slides so far end, unrounded: a pinned length ends its slide on the frame nearest
  // that, so rounding to frames never adds up over slides at any frame rate.
  let exact = 0;
  for (const slide of slides) {
    const narration = options.narration ? (spoken[slide.id] ?? null) : null;
    const duration = options.narration ? (slide.duration ?? null) : null;
    const narrationStart = options.narration ? (slide.narrationStart ?? null) : null;
    const offset = narrationStart ?? options.pauseBefore;
    let frames: number;
    if (duration !== null) {
      exact += duration;
      frames = Math.max(1, Math.round(exact * fps) - shown);
    } else {
      frames = slideFrames({ ...options, pauseBefore: Math.max(0, offset) }, narration);
      exact = (shown + frames) / fps;
    }
    const start = shown / fps;
    if (narration !== null) {
      const from = Math.max(start + offset, voice);
      voice = from + narration;
      clips.push({ slide: slide.id, start: from, end: voice });
    }
    shown += frames;
    out.push({ id: slide.id, start, end: shown / fps, locked: slide.locked, duration, narrationStart });
  }
  const end = Math.max(shown, Math.ceil(voice * fps)) / fps;
  const last = out[out.length - 1];
  if (last) last.end = end;
  return { slides: out, clips, end };
}

/**
 * How long each slide's narration lasts for the timeline, by slide id: the audio there is, or,
 * until it is spoken, an estimate; null without narration or a recording.
 */
export function spokenSeconds(slides: Slide[], audio: Record<string, SlideAudio>): Record<string, number | null> {
  return Object.fromEntries(
    slides.map((slide) => {
      const text = (slide.narration ?? "").trim();
      const seconds = audio[slide.id]?.seconds ?? null;
      if (audio[slide.id]?.recorded) return [slide.id, seconds];
      return [slide.id, text === "" ? null : (seconds ?? wordsSeconds(markdownText(text)))];
    }),
  );
}

/** Hundredths of a second, which is finer than a frame and short in the deck file. */
function rounded(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * What to save for slide `index` to end at `to`. Only its length changes: the slides after it
 * follow, and every narration keeps its place in its slide. The timeline gets longer or shorter.
 */
export function moveEdge(timeline: Timeline, index: number, to: number): SlideTiming[] {
  const slide = timeline.slides[index];
  if (!slide) return [];
  const duration = clamp(rounded(to - slide.start), MIN_DURATION, MAX_DURATION);
  if (Math.abs(duration - (slide.end - slide.start)) < 0.005) return [];
  return [{ slide: slide.id, duration, narrationStart: slide.narrationStart }];
}

/**
 * What to save for `id`'s narration to move by `by` seconds, stopping at the narration on either
 * side. The slide keeps its length, so nothing else moves.
 */
export function moveClip(timeline: Timeline, id: string, by: number): SlideTiming[] {
  const index = timeline.clips.findIndex((c) => c.slide === id);
  const clip = timeline.clips[index];
  const slide = timeline.slides.find((s) => s.id === id);
  if (!clip || !slide) return [];
  const earliest = Math.max(timeline.clips[index - 1]?.end ?? 0, slide.start - MAX_DURATION);
  const next = (timeline.clips[index + 1]?.start ?? Infinity) - (clip.end - clip.start);
  const start = clamp(clip.start + by, earliest, Math.min(next, slide.start + MAX_DURATION));
  if (Math.abs(start - clip.start) < 0.005) return [];
  return [
    {
      slide: id,
      duration: slide.duration ?? rounded(slide.end - slide.start),
      narrationStart: rounded(start - slide.start),
    },
  ];
}

/** `slides` with `timing` saved. */
export function withTiming(slides: Slide[], timing: SlideTiming[]): Slide[] {
  return slides.map((slide) => {
    const change = timing.find((t) => t.slide === slide.id);
    return change ? { ...slide, duration: change.duration, narrationStart: change.narrationStart } : slide;
  });
}

/** The slide showing at `time`: the last one, past the end. */
export function slideAt(timeline: Timeline, time: number): number {
  const index = timeline.slides.findIndex((s) => time < s.end);
  return index >= 0 ? index : timeline.slides.length - 1;
}

/** How much of its picture a filmstrip must have room for to show it, as a part of the picture's width. */
export const LEAST_PICTURE = 0.25;

/**
 * Whether a filmstrip shows its picture. A strip has one picture, `picture` wide, at its start;
 * the rest of it is empty film. The strip starts `left` along the track and is `width` wide, and
 * what lies between `from` and `to` of the track is in sight. All in pixels. A strip with room
 * for only a sliver of the picture shows none: a slide nobody could make out is not worth loading.
 */
export function showsPicture(left: number, width: number, picture: number, from: number, to: number): boolean {
  if (!(picture > 0) || !(width >= picture * LEAST_PICTURE)) return false;
  return left < to && left + Math.min(width, picture) > from;
}

/**
 * How far a track is scrolled, in steps of `step` pixels: what is in sight is worked out anew
 * only from one step to the next, not with every pixel scrolled.
 */
export function scrollStep(scrolled: number, step: number): number {
  return step > 0 ? Math.floor(scrolled / step) * step : 0;
}

/** `seconds` to the tenth, like `0:03.2`: what a step of a tenth of a second changes. */
export function formatTenths(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, "0")}.${tenths % 10}`;
}

/** How long a slide shows, for its block on the track: `5.0s`, or `1:05` from a minute on. */
export function formatShown(seconds: number): string {
  if (seconds < 59.95) return `${seconds.toFixed(1)}s`;
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** How far from the edge of what is in sight the playhead is kept, as a part of it. */
const VIEW_MARGIN = 0.1;

/**
 * Where a track scrolled to `scrolled` (showing `view` pixels of it) scrolls to, for the playhead
 * at `x` to be in sight: where it is while the playhead is, or else on by a page, the playhead
 * near its left, as a playing track turns its pages.
 */
export function scrollToPlayhead(x: number, scrolled: number, view: number): number {
  if (!(view > 0) || (x >= scrolled && x <= scrolled + view)) return scrolled;
  return Math.max(0, x - view * VIEW_MARGIN);
}

/**
 * Where a track scrolls to as its width changes from `before` to `after` (a zoom), for the
 * playhead, at `at` of its length (0 to 1), to stay where it is on screen; one out of sight
 * comes to the middle.
 */
export function scrollForZoom(at: number, before: number, after: number, scrolled: number, view: number): number {
  const was = at * before - scrolled;
  const offset = was >= 0 && was <= view ? was : view / 2;
  return Math.max(0, Math.min(at * after - offset, Math.max(0, after - view)));
}
