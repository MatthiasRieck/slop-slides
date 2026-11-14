import { describe, expect, it } from "vitest";

import type { Deck } from "../../lib/api";
import { DECK_HTML, deckFor } from "../../test/fixtures";
import { sectionStartingAt } from "./ShowOverview";
import { slideNumber, typedGoal, webLink } from "./showSlides";

/** The test deck (intro, #2, outro) with the slides at `hidden` hidden. */
function deck(hidden: number[] = []): Deck {
  const base = deckFor(DECK_HTML);
  return { ...base, slides: base.slides.map((s, i) => ({ ...s, hidden: hidden.includes(i) })) };
}

describe("slideNumber", () => {
  it("numbers the slide on screen as the slide list does, hidden slides counted", () => {
    expect(slideNumber(deck(), 1)).toBe(2);
    expect(slideNumber(deck([1]), 0)).toBe(1);
    expect(slideNumber(deck([1]), 1)).toBe(3);
    // A place past the slides shown is the last of them.
    expect(slideNumber(deck([1]), 7)).toBe(3);
  });
});

describe("typedGoal", () => {
  it("says which slide a typed number goes to, as the player takes it", () => {
    expect(typedGoal(deck(), "2")).toBe("Go to slide 2");
    expect(typedGoal(deck([1]), "2")).toBe("Slide 2 is hidden: go to 3");
    expect(typedGoal(deck(), "12")).toBe("Go to the last slide, 3");
    expect(typedGoal(deck([2]), "3")).toBe("Slide 3 is hidden: go to 2");
    expect(typedGoal(deck(), "0")).toBe("Go to slide 1");
  });
});

describe("webLink", () => {
  it("opens web and mail addresses only", () => {
    expect(webLink("https://example.com/demo?x=1")).toBe("https://example.com/demo?x=1");
    expect(webLink("http://example.com")).toBe("http://example.com/");
    expect(webLink("mailto:me@example.com")).toBe("mailto:me@example.com");
    for (const href of ["javascript:alert(1)", "file:///etc/passwd", "slop://deck/x.html", "other.html", "", 7, null]) {
      expect(webLink(href)).toBeNull();
    }
  });
});

describe("sectionStartingAt", () => {
  it("names the section a slide starts, and only that slide", () => {
    const sections = [{ index: 0, title: "Why", before: 1 }];
    expect(sectionStartingAt({ ...deck(), sections }, 1)).toBe("Why");
    expect(sectionStartingAt({ ...deck(), sections }, 2)).toBeNull();
    expect(sectionStartingAt({ ...deck(), sections: [{ index: 0, title: "", before: 0 }] }, 0)).toBeNull();
  });
});
