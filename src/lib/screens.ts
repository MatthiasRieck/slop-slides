import type { Screen } from "./api";
import { loadJson, saveJson } from "./storage";

/** Where the show goes: the audience's screen, and the presenter view's, if it has one. */
export interface ScreenChoice {
  audience: number;
  presenter: number | null;
}

/**
 * Where the show goes: on screens picked for it, or in windows (the slides in the app window as
 * it is, the presenter view in a window of its own) for sharing the slides' window in a call.
 */
export type Placement = ScreenChoice | "windows";

/** Where a show starts: on the slide selected in the editor, or on the deck's first slide. */
export type ShowStart = "current" | "start";

/** Whether the presenter view has a window of its own, rather than a panel beside the slides. */
export function hasPresenterWindow(placement: Placement | null): boolean {
  if (placement === "windows") return true;
  return placement?.presenter != null;
}

/** A screen drawn to scale in a box: percentages of the arrangement's bounding box. */
export interface ScreenBox {
  screen: Screen;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The screens laid out as they sit on the desk, fitted into a box of the arrangement's shape. */
export function arrange(screens: Screen[]): { aspect: number; boxes: ScreenBox[] } {
  if (screens.length === 0) return { aspect: 16 / 9, boxes: [] };
  const left = Math.min(...screens.map((s) => s.x));
  const top = Math.min(...screens.map((s) => s.y));
  const width = Math.max(...screens.map((s) => s.x + s.width)) - left;
  const height = Math.max(...screens.map((s) => s.y + s.height)) - top;
  return {
    aspect: width / height,
    boxes: screens.map((screen) => ({
      screen,
      left: ((screen.x - left) / width) * 100,
      top: ((screen.y - top) / height) * 100,
      width: (screen.width / width) * 100,
      height: (screen.height / height) * 100,
    })),
  };
}

/**
 * The choice for screens used for the first time: the slides on a screen that is not the
 * computer's main one (a projector, the last of them), the presenter view on the main one.
 * Without a screen marked as main, the slides go on the last screen and the presenter view on the first.
 */
export function defaultChoice(screens: Screen[]): ScreenChoice {
  const audience = screens.findLast((s) => !s.primary) ?? screens[screens.length - 1];
  const presenter = screens.find((s) => s.primary && s !== audience) ?? screens.find((s) => s !== audience);
  return { audience: audience?.index ?? 0, presenter: presenter?.index ?? null };
}

/** The slides and the presenter view on each other's screen; as it is without a presenter view. */
export function swap(choice: ScreenChoice): ScreenChoice {
  return choice.presenter === null ? choice : { audience: choice.presenter, presenter: choice.audience };
}

const CHOICES_KEY = "slopslide.screenChoices";
/** How many sets of screens are remembered. */
const MAX_CHOICES = 12;

/** What tells one set of screens (a desk, a lecture hall) from another: each screen's name, size and place, in order. */
export function screensKey(screens: Screen[]): string {
  return screens.map((s) => `${s.index}:${s.name}:${s.pixelWidth}x${s.pixelHeight}@${s.x},${s.y}`).join("|");
}

function loadChoices(): [string, ScreenChoice][] {
  return loadJson<[string, ScreenChoice][]>(CHOICES_KEY, [], (stored) =>
    Array.isArray(stored) ? stored.filter((entry) => Array.isArray(entry) && typeof entry[0] === "string") : [],
  );
}

/** The choice made last for this set of `screens`, when it still fits them; else the default one. */
export function loadChoice(screens: Screen[]): ScreenChoice {
  const saved = loadChoices().find(([key]) => key === screensKey(screens))?.[1];
  const has = (index: unknown) => screens.some((s) => s.index === index);
  if (!saved || !has(saved.audience)) return defaultChoice(screens);
  const presenter = saved.presenter !== null && saved.presenter !== saved.audience && has(saved.presenter);
  return { audience: saved.audience, presenter: presenter ? saved.presenter : null };
}

/** Remembers `choice` for this set of `screens`. A failure only loses what was to be remembered. */
export function saveChoice(screens: Screen[], choice: ScreenChoice) {
  const key = screensKey(screens);
  const others = loadChoices().filter(([saved]) => saved !== key);
  try {
    saveJson(CHOICES_KEY, [...others, [key, choice]].slice(-MAX_CHOICES));
  } catch {
    // Only the remembered choice is lost.
  }
}

/**
 * Picks `index` for the audience or the presenter view, each of which is on one screen at a time.
 * The two can't share a screen: the slides push the presenter view off theirs, and as the slides
 * always need a screen, the presenter view can't take theirs.
 */
export function choose(choice: ScreenChoice, role: "audience" | "presenter", index: number): ScreenChoice {
  if (role === "audience") {
    return { audience: index, presenter: choice.presenter === index ? null : choice.presenter };
  }
  if (index === choice.audience) return choice;
  return { ...choice, presenter: index };
}
