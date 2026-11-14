import type { Slide } from "../../lib/api";
import { loadJson, saveJson } from "../../lib/storage";

/** Time since the show started, like `4:07` or `1:04:07`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  const clock = `${minutes % 60}:${pad(seconds % 60)}`;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${minutes % 60 < 10 ? "0" : ""}${clock}` : clock;
}

/** How much of a planned time is little enough left to warn of: a tenth of it, and at least a minute. */
const WARN_SHARE = 0.1;
const WARN_LEAST_MS = 60_000;

/**
 * Time left of `minutes` after `elapsedMs`, like `12:30`, or `+1:05` once over; whether it's
 * over, and whether it soon will be (`low`: less than a tenth of the time left, or a minute).
 */
export function remaining(elapsedMs: number, minutes: number): { text: string; over: boolean; low: boolean } {
  const planned = minutes * 60_000;
  const left = planned - elapsedMs;
  const over = left < 0;
  // Counts seconds up (rounding the other way) once over, so the display never sticks at 0:00.
  const text = formatElapsed(over ? -left : Math.ceil(left / 1000) * 1000);
  const low = !over && left < Math.max(WARN_LEAST_MS, planned * WARN_SHARE);
  return { text: over ? `+${text}` : text, over, low };
}

/**
 * How long each slide was on screen in a show, from its first move on: the time on the slide the
 * show opened on before anyone moved counts for nothing, as a rehearsal starts when the talk
 * does. `on` is the slide on screen (null for none, the end of the show), `since` when it came.
 */
export interface SlideTimings {
  begun: boolean;
  on: string | null;
  since: number | null;
  spent: Record<string, number>;
}

export const NO_TIMINGS: SlideTimings = { begun: false, on: null, since: null, spent: {} };

/** `timings` with `slide` on screen from `now` on. */
export function timeSlide(timings: SlideTimings, slide: string | null, now: number): SlideTimings {
  // The slide the show opens on, as it comes to be known.
  if (!timings.begun && timings.since === null && (timings.on === null || timings.on === slide)) {
    return { ...timings, on: slide };
  }
  if (slide === timings.on && timings.since !== null) return timings;
  return { begun: true, on: slide, since: now, spent: spentBy(timings, now) };
}

/** What `timings` add up to by `now`, the slide on screen counted to then. */
export function spentBy(timings: SlideTimings, now: number): Record<string, number> {
  const { on, since, spent } = timings;
  if (on === null || since === null) return spent;
  return { ...spent, [on]: (spent[on] ?? 0) + Math.max(0, now - since) };
}

/** The least time a slide must have had in a show for it to count as a run through the slides. */
const REHEARSED_LEAST_MS = 2000;

/**
 * The seconds each of the `shown` slides had in a show (`spent`, ms), to keep as their planned
 * times: only when the show went through all of them, each for a moment at least, as a run
 * through the talk does. Null otherwise. Locked slides keep the time they have.
 */
export function rehearsedTimes(spent: Record<string, number>, shown: Slide[]): Record<string, number> | null {
  if (shown.length < 2 || shown.some((s) => (spent[s.id] ?? 0) < REHEARSED_LEAST_MS)) return null;
  const times: Record<string, number> = {};
  for (const slide of shown) if (!slide.locked) times[slide.id] = Math.round(spent[slide.id]! / 1000);
  return Object.keys(times).length > 0 ? times : null;
}

const BUDGET_KEY = "slopslide.presenterBudget";

/** The times the presenter sets for themselves, in minutes; 0 is none. */
export interface Budget {
  total: number;
  perSlide: number;
}

/** The times the presenter set last, kept on this computer. */
export function loadBudget(): Budget {
  const minutes = (value: unknown) => (typeof value === "number" && value > 0 && value < 1000 ? value : 0);
  // A stored null fails the read, and falls back too.
  return loadJson(BUDGET_KEY, { total: 0, perSlide: 0 }, (stored) => {
    const saved = stored as Partial<Record<keyof Budget, unknown>>;
    return { total: minutes(saved.total), perSlide: minutes(saved.perSlide) };
  });
}

export function saveBudget(budget: Budget) {
  saveJson(BUDGET_KEY, budget);
}

/**
 * The times to count down, in minutes: those set on the slides come first, the slide's own
 * (`slide`) and all of the `shown` slides' added up; the presenter's `budget` for the rest.
 */
export function plannedBudget(budget: Budget, shown: Slide[], slide: Slide | undefined): Budget {
  const planned = shown.reduce((sum, s) => sum + (s.time ?? 0), 0) / 60;
  return { total: budget.total || planned, perSlide: slide?.time ? slide.time / 60 : budget.perSlide };
}

/** Where each time counted down comes from, to say beside the field that would set it; null when the presenter's own. */
export function budgetSources(
  budget: Budget,
  shown: Slide[],
  slide: Slide | undefined,
): { total: string | null; perSlide: string | null } {
  const planned = shown.reduce((sum, s) => sum + (s.time ?? 0), 0);
  return {
    total: !budget.total && planned > 0 ? `${formatElapsed(planned * 1000)} from slide times` : null,
    perSlide: slide?.time ? `${formatElapsed(slide.time * 1000)} from this slide's time` : null,
  };
}

/**
 * A clock that can be paused: the time it ran before it last started (`elapsed`, ms), and when
 * that was (`since`, null while paused).
 */
export interface Stopwatch {
  elapsed: number;
  since: number | null;
}

/** A stopwatch at zero, running from `now` unless `paused`. */
export function startWatch(now: number, paused = false): Stopwatch {
  return { elapsed: 0, since: paused ? null : now };
}

/** How long `watch` has run by `now`, in ms. */
export function watchTime(watch: Stopwatch, now: number): number {
  return watch.elapsed + (watch.since === null ? 0 : Math.max(0, now - watch.since));
}

/** `watch` stopped at `now`, keeping the time it ran. */
export function pauseWatch(watch: Stopwatch, now: number): Stopwatch {
  return watch.since === null ? watch : { elapsed: watchTime(watch, now), since: null };
}

/** `watch` running again from `now`. */
export function resumeWatch(watch: Stopwatch, now: number): Stopwatch {
  return watch.since === null ? { ...watch, since: now } : watch;
}

/** The time of day at `now`, hours and minutes as the system writes them. */
export function formatClock(now: number): string {
  return new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
