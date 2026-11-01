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
  /** Its length was set on the timeline; otherwise it follows its narration. */
  timed: boolean;
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
  for (const slide of slides) {
    const narration = options.narration ? (spoken[slide.id] ?? null) : null;
    const duration = options.narration ? (slide.duration ?? null) : null;
    const offset = (options.narration ? slide.narrationStart : null) ?? options.pauseBefore;
    const frames =
      duration !== null
        ? Math.max(1, Math.round(duration * fps))
        : slideFrames({ ...options, pauseBefore: Math.max(0, offset) }, narration);
    const start = shown / fps;
    if (narration !== null) {
      const from = Math.max(start + offset, voice);
      voice = from + narration;
      clips.push({ slide: slide.id, start: from, end: voice });
    }
    shown += frames;
    out.push({ id: slide.id, start, end: shown / fps, locked: slide.locked, timed: duration !== null });
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

/** Where each slide ends. */
function ends(timeline: Timeline): number[] {
  return timeline.slides.map((s) => s.end);
}

/** Hundredths of a second, which is finer than a frame and short in the deck file. */
function rounded(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * The `ends` of `timeline` with slide `index`'s end at `to`. The next slide gives or takes the
 * time, so the slides after it stay where they are; the last slide's end is the timeline's.
 */
export function moveEdge(timeline: Timeline, index: number, to: number): number[] {
  const next = ends(timeline);
  const start = timeline.slides[index]?.start ?? 0;
  const after = next[index + 1];
  next[index] = clamp(to, start + MIN_DURATION, Math.min(start + MAX_DURATION, (after ?? Infinity) - MIN_DURATION));
  return next;
}

/**
 * The `ends` of `timeline` with slide `index` moved by `by` seconds, keeping its length: the
 * slides on either side give or take the time. The first slide always starts the timeline, so
 * it does not move; moving the last changes where the timeline ends.
 */
export function moveSlide(timeline: Timeline, index: number, by: number): number[] {
  const next = ends(timeline);
  const before = timeline.slides[index - 1];
  const slide = timeline.slides[index];
  if (!before || !slide) return next;
  const following = timeline.slides[index + 1];
  const late = following ? following.end - MIN_DURATION - slide.end : Infinity;
  const moved = clamp(by, before.start + MIN_DURATION - slide.start, late);
  next[index - 1] = slide.start + moved;
  next[index] = slide.end + moved;
  return next;
}

/** Whether a slide's edge, between it and the next (if any), can move: locked slides cannot change. */
export function edgeMovable(timeline: Timeline, index: number): boolean {
  return !timeline.slides[index]?.locked && !timeline.slides[index + 1]?.locked;
}

/** Whether a slide can move across the audio: it and its neighbours change. */
export function slideMovable(timeline: Timeline, index: number): boolean {
  return index > 0 && edgeMovable(timeline, index - 1) && edgeMovable(timeline, index);
}

/**
 * What to save for the slides `next` changes, `next` being where each slide ends. The audio
 * stays where it is, so a slide that moves gets a narration start to keep it there.
 */
export function retime(timeline: Timeline, next: number[]): SlideTiming[] {
  const changed = (a: number, b: number) => Math.abs(a - b) >= 0.005;
  return timeline.slides.flatMap((slide, i) => {
    const start = next[i - 1] ?? 0;
    const end = next[i] ?? slide.end;
    if (!changed(start, slide.start) && !changed(end, slide.end)) return [];
    const clip = timeline.clips.find((c) => c.slide === slide.id);
    return [
      { slide: slide.id, duration: rounded(end - start), narrationStart: clip ? rounded(clip.start - start) : null },
    ];
  });
}

/** The slide showing at `time`: the last one, past the end. */
export function slideAt(timeline: Timeline, time: number): number {
  const index = timeline.slides.findIndex((s) => time < s.end);
  return index >= 0 ? index : timeline.slides.length - 1;
}
