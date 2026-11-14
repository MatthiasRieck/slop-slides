import { beforeEach, describe, expect, it } from "vitest";

import type { Slide } from "./api";
import {
  chooseSlides,
  DEFAULT_CHOICES,
  imageOptions,
  loadChoices,
  pdfOptions,
  privateParts,
  readChoices,
  type SlideChoice,
  saveChoices,
  slidePercent,
  slideProgress,
  slideProgressShort,
  webPageOptions,
  webPageProblem,
} from "./exportOptions";

const slide = (id: string, more: Partial<Slide> = {}): Slide => ({
  id,
  hash: id,
  hidden: false,
  locked: false,
  moved: false,
  ...more,
});

const DECK = [slide("a"), slide("b", { hidden: true }), slide("c"), slide("d")];
const ids = (slides: Slide[]) => slides.map((s) => s.id);
const choice = (more: Partial<SlideChoice> = {}): SlideChoice => ({
  range: "all",
  from: "1",
  to: "4",
  includeHidden: false,
  ...more,
});

describe("chooseSlides", () => {
  it("takes every shown slide, leaving the list to the backend", () => {
    const chosen = chooseSlides(DECK, choice(), "a");
    expect(ids(chosen.slides)).toEqual(["a", "c", "d"]);
    expect(chosen.scope).toEqual({ includeHidden: false });
    expect(chosen.problem).toBeNull();
    const all = chooseSlides(DECK, choice({ includeHidden: true }), null);
    expect(ids(all.slides)).toEqual(["a", "b", "c", "d"]);
    expect(all.scope).toEqual({ includeHidden: true });
  });

  it("takes the current slide", () => {
    const chosen = chooseSlides(DECK, choice({ range: "current" }), "c");
    expect(chosen.scope).toEqual({ slides: ["c"], includeHidden: false });
    expect(chooseSlides(DECK, choice({ range: "current" }), null).problem).toBe("Select a slide first.");
    expect(chooseSlides(DECK, choice({ range: "current" }), "b").problem).toMatch(/current slide is hidden/);
    expect(chooseSlides(DECK, choice({ range: "current", includeHidden: true }), "b").problem).toBeNull();
  });

  it("takes a range by the numbers every slide has, hidden ones too", () => {
    const chosen = chooseSlides(DECK, choice({ range: "range", from: "2", to: "3" }), null);
    expect(ids(chosen.slides)).toEqual(["c"]);
    expect(chosen.scope).toEqual({ slides: ["b", "c"], includeHidden: false });
    expect(chooseSlides(DECK, choice({ range: "range", from: "2", to: "2" }), null).problem).toMatch(
      /Every slide in this range is hidden/,
    );
    for (const [from, to] of [
      ["0", "2"],
      ["1", "5"],
      ["", "2"],
      ["1.5", "2"],
      ["a", "2"],
    ]) {
      expect(chooseSlides(DECK, choice({ range: "range", from, to }), null).problem).toBe(
        "Enter slide numbers from 1 to 4.",
      );
    }
    expect(chooseSlides(DECK, choice({ range: "range", from: "3", to: "1" }), null).problem).toBe(
      "The first slide must come before the last.",
    );
  });

  it("says so when there is nothing to export", () => {
    expect(chooseSlides([], choice(), null).problem).toBe("The deck has no slides.");
    const hidden = DECK.map((s) => ({ ...s, hidden: true }));
    expect(chooseSlides(hidden, choice(), null).problem).toMatch(/^Every slide is hidden/);
  });
});

describe("remembered choices", () => {
  beforeEach(() => localStorage.removeItem("slopslide.export.pdf"));

  it("start from the defaults, which leave hidden slides and private material out", () => {
    expect(loadChoices("pdf")).toEqual(DEFAULT_CHOICES);
    expect(DEFAULT_CHOICES.includeHidden).toBe(false);
    expect(DEFAULT_CHOICES.notes || DEFAULT_CHOICES.narration || DEFAULT_CHOICES.review).toBe(false);
  });

  it("are kept per format", () => {
    saveChoices("pdf", { ...DEFAULT_CHOICES, range: "current", notes: true });
    expect(loadChoices("pdf")).toMatchObject({ range: "current", notes: true });
    expect(loadChoices("pptx")).toEqual(DEFAULT_CHOICES);
  });

  it("replace what is unknown or broken by the default", () => {
    expect(readChoices(null)).toEqual(DEFAULT_CHOICES);
    expect(
      readChoices({ range: "some", includeHidden: "yes", imageScale: 3, videoHeight: 2160, captions: "vtt" }),
    ).toEqual({ ...DEFAULT_CHOICES, videoHeight: 2160, captions: "vtt" });
    localStorage.setItem("slopslide.export.pdf", "{not json");
    expect(loadChoices("pdf")).toEqual(DEFAULT_CHOICES);
  });
});

describe("options for the backend", () => {
  const scope = { slides: ["a"], includeHidden: true };
  const choices = {
    ...DEFAULT_CHOICES,
    notes: true,
    review: true,
    imageFormat: "jpeg" as const,
    imageScale: 2 as const,
  };

  it("carry the scope with each format's own fields", () => {
    expect(pdfOptions(scope, choices)).toEqual({ ...scope, notes: true });
    expect(webPageOptions(scope, choices)).toEqual({ ...scope, notes: true, narration: false, review: true });
    expect(imageOptions(scope, choices)).toEqual({ ...scope, format: "jpeg", scale: 2 });
  });

  it("tell what private material the slides have, and whether a web page has a slide to show", () => {
    const slides = [slide("a", { notes: " Hi ", narration: "" }), slide("b", { notes: "", narration: "Said" })];
    expect(privateParts(slides)).toEqual({ notes: 1, narration: 1 });
    expect(webPageProblem(slides)).toBeNull();
    expect(webPageProblem([slide("x", { hidden: true })])).toMatch(/skips hidden slides/);
    expect(webPageProblem([])).toBeNull();
  });
});

describe("progress", () => {
  it("names the slide being worked on", () => {
    expect(slideProgress(0, 0)).toBe("Starting…");
    expect(slideProgress(3, 20)).toBe("Slide 4 of 20");
    expect(slideProgress(20, 20)).toBe("Finishing…");
    expect(slideProgressShort(0, 0)).toBe("…");
    expect(slideProgressShort(3, 20)).toBe("4/20");
    expect(slideProgressShort(20, 20)).toBe("20/20");
    expect(slidePercent(1, 3)).toBe(33);
    expect(slidePercent(5, 0)).toBe(0);
  });
});
