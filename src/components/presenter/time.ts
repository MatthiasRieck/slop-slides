import type { Slide } from "../../lib/api";

/** Time since the show started, like `4:07` or `1:04:07`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  const clock = `${minutes % 60}:${pad(seconds % 60)}`;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${minutes % 60 < 10 ? "0" : ""}${clock}` : clock;
}

/** Time left of `minutes` after `elapsedMs`, like `12:30`, or `+1:05` once over; and whether it's over. */
export function remaining(elapsedMs: number, minutes: number): { text: string; over: boolean } {
  const left = minutes * 60_000 - elapsedMs;
  const over = left < 0;
  // Counts seconds up (rounding the other way) once over, so the display never sticks at 0:00.
  const text = formatElapsed(over ? -left : Math.ceil(left / 1000) * 1000);
  return { text: over ? `+${text}` : text, over };
}

const BUDGET_KEY = "slopslide.presenterBudget";

/** The times the presenter sets for themselves, in minutes; 0 is none. */
export interface Budget {
  total: number;
  perSlide: number;
}

/** The times the presenter set last, kept on this computer. */
export function loadBudget(): Budget {
  try {
    const saved = JSON.parse(localStorage.getItem(BUDGET_KEY) ?? "{}");
    const minutes = (value: unknown) => (typeof value === "number" && value > 0 && value < 1000 ? value : 0);
    return { total: minutes(saved.total), perSlide: minutes(saved.perSlide) };
  } catch {
    return { total: 0, perSlide: 0 };
  }
}

export function saveBudget(budget: Budget) {
  localStorage.setItem(BUDGET_KEY, JSON.stringify(budget));
}

/**
 * The times to count down, in minutes: those set on the slides come first, the slide's own
 * (`slide`) and all of the `shown` slides' added up; the presenter's `budget` for the rest.
 */
export function plannedBudget(budget: Budget, shown: Slide[], slide: Slide | undefined): Budget {
  const planned = shown.reduce((sum, s) => sum + (s.time ?? 0), 0) / 60;
  return { total: budget.total || planned, perSlide: slide?.time ? slide.time / 60 : budget.perSlide };
}
