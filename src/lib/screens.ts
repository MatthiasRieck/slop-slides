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

/** The choice a picker starts with: the last one made, or else the show on the last screen and
 * the presenter view on the first. */
export function defaultChoice(screens: Screen[]): ScreenChoice {
  return recalled(screens) ?? { audience: screens.length - 1, presenter: screens.length > 1 ? 0 : null };
}

/** Tells a screen apart from the others across pickers, where its index may change as screens
 * come and go. */
function identify(screen: Screen): string {
  return `${screen.name}@${screen.x},${screen.y}`;
}

/** The last choice made in a picker, by screen, while the app runs. It isn't saved anywhere:
 * which screens are attached is a matter of the moment, not of the deck. */
let last: { audience: string; presenter: string | null } | null = null;

/** Remembers `choice` for the next picker, which starts with it if its screens are still there. */
export function rememberChoice(screens: Screen[], choice: ScreenChoice): void {
  const at = (index: number) => screens.find((s) => s.index === index);
  const audience = at(choice.audience);
  if (!audience) return;
  const presenter = choice.presenter === null ? undefined : at(choice.presenter);
  last = { audience: identify(audience), presenter: presenter ? identify(presenter) : null };
}

/** Forgets the remembered choice (for tests). */
export function forgetChoice(): void {
  last = null;
}

/** The remembered choice on `screens`; null without one, or when its slides' screen is gone. A
 * presenter view whose screen is gone goes to another free one. */
function recalled(screens: Screen[]): ScreenChoice | null {
  if (!last) return null;
  const find = (id: string) => screens.find((s) => identify(s) === id)?.index;
  const audience = find(last.audience);
  if (audience === undefined) return null;
  if (last.presenter === null) return { audience, presenter: null };
  const presenter = find(last.presenter) ?? screens.find((s) => s.index !== audience)?.index ?? null;
  return { audience, presenter: presenter === audience ? null : presenter };
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
