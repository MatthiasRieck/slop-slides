// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { DECK_HTML, deckFor } from "../test/fixtures";
import { selectedSlideLocked, selectedSlideNarrated } from "./chrome";

const deck = deckFor(DECK_HTML);
const withSlide = (patch: object) => ({
  ...deck,
  slides: deck.slides.map((slide) => (slide.id === "intro" ? { ...slide, ...patch } : slide)),
});

describe("what the chrome shows of the selected slide", () => {
  it("says whether it is locked, and whether it has narration", () => {
    expect(selectedSlideLocked({ deck, selected: "intro" })).toBe(false);
    expect(selectedSlideLocked({ deck: withSlide({ locked: true }), selected: "intro" })).toBe(true);
    expect(selectedSlideLocked({ deck: withSlide({ locked: true }), selected: "outro" })).toBe(false);
    expect(selectedSlideNarrated({ deck, selected: "intro" })).toBe(false);
    expect(selectedSlideNarrated({ deck: withSlide({ narration: "Hello." }), selected: "intro" })).toBe(true);
    expect(selectedSlideNarrated({ deck: null, selected: null })).toBe(false);
    expect(selectedSlideNarrated({ deck, selected: "gone" })).toBe(false);
  });

  it("looks the slide up once for the same slides and selection, however often it is asked", () => {
    const narrated = withSlide({ narration: "Hello." });
    const find = vi.spyOn(narrated.slides, "find");
    for (let update = 0; update < 100; update++) {
      // Each update of the store is another state object around the same slides.
      expect(selectedSlideNarrated({ deck: narrated, selected: "intro" })).toBe(true);
      expect(selectedSlideLocked({ deck: narrated, selected: "intro" })).toBe(false);
    }
    expect(find).toHaveBeenCalledOnce();
    expect(selectedSlideNarrated({ deck: narrated, selected: "outro" })).toBe(false);
    expect(find).toHaveBeenCalledTimes(2);
  });
});
