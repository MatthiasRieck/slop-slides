import type { Screen } from "./api";

/** Where the show goes: the audience's screen, and the presenter view's, if it has one. */
export interface ScreenChoice {
  audience: number;
  presenter: number | null;
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

/** The choice a picker starts with: the show on the last screen, the presenter view on the first. */
export function defaultChoice(screens: Screen[]): ScreenChoice {
  const audience = screens.length - 1;
  return { audience, presenter: screens.length > 1 ? 0 : null };
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
