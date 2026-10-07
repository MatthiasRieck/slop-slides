import { describe, expect, it } from "vitest";

import { deckPageVersion, fitSlide, SWIPE_DISTANCE, swipeDirection } from "./deviceView";

const PHONE_LANDSCAPE = { width: 932, height: 430 };
const PHONE_PORTRAIT = { width: 430, height: 932 };

describe("fitSlide", () => {
  it("fits the slide by height on a wide screen and by width on a tall one", () => {
    expect(fitSlide(PHONE_LANDSCAPE)).toEqual({ width: (430 * 16) / 9, height: 430 });
    expect(fitSlide(PHONE_PORTRAIT)).toEqual({ width: 430, height: (430 * 9) / 16 });
  });

  it("is empty before the screen is measured", () => {
    expect(fitSlide({ width: 0, height: 0 })).toEqual({ width: 0, height: 0 });
  });
});

describe("swipeDirection", () => {
  it("goes to the next slide on a swipe left and the previous one on a swipe right", () => {
    expect(swipeDirection(-SWIPE_DISTANCE, 0)).toBe(1);
    expect(swipeDirection(SWIPE_DISTANCE + 20, 10)).toBe(-1);
  });

  it("ignores short and mostly vertical drags", () => {
    expect(swipeDirection(-(SWIPE_DISTANCE - 1), 0)).toBe(0);
    expect(swipeDirection(-80, 60)).toBe(0);
  });
});

describe("deckPageVersion", () => {
  const deck = {
    shellHash: "s1",
    slides: [
      { id: "intro", hash: "a", hidden: false, moved: false },
      { id: "#2", hash: "b", hidden: false, moved: false },
    ],
  };

  it("is stable, and safe in a URL even for slide ids like #2", () => {
    expect(deckPageVersion(deck, 0)).toBe(deckPageVersion(structuredClone(deck), 0));
    expect(deckPageVersion(deck, 0)).toMatch(/^[0-9a-z]+$/);
  });

  it("changes with any slide, the shared styles, the assets and the slide order", () => {
    const base = deckPageVersion(deck, 0);
    const changed = [
      deckPageVersion({ ...deck, slides: [deck.slides[0]!, { ...deck.slides[1]!, hash: "c" }] }, 0),
      deckPageVersion({ ...deck, shellHash: "s2" }, 0),
      deckPageVersion(deck, 1),
      deckPageVersion({ ...deck, slides: [...deck.slides].reverse() }, 0),
    ];
    for (const version of changed) expect(version).not.toBe(base);
  });
});
