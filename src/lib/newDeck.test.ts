import { describe, expect, it } from "vitest";

import { matchingDecks, newDeckTitle, titleFromPrompt, UNTITLED_DECK } from "./newDeck";

describe("titleFromPrompt", () => {
  it("takes the first words of the first sentence", () => {
    expect(titleFromPrompt("a 6-slide pitch for a neighborhood tool-sharing app, bold and warm")).toBe(
      "A 6-slide pitch for a neighborhood",
    );
    expect(titleFromPrompt("Quarterly engineering update: shipped, in progress, risks")).toBe(
      "Quarterly engineering update",
    );
    expect(titleFromPrompt("Compound interest. For teenagers, in 8 slides")).toBe("Compound interest");
    expect(titleFromPrompt("First line\nsecond line")).toBe("First line");
  });

  it("drops what dangles at the end and keeps it short", () => {
    expect(titleFromPrompt("Our plan, the budget, and — ")).toBe("Our plan, the budget, and");
    const long = titleFromPrompt(
      "Internationalization considerations regarding pharmaceutical telecommunications infrastructure today",
    );
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toBe("Internationalization considerations regarding pharmaceutical");
  });

  it("is empty for nothing", () => {
    expect(titleFromPrompt("  \n ")).toBe("");
    expect(titleFromPrompt("...")).toBe("");
  });
});

describe("newDeckTitle", () => {
  it("prefers the title typed, then what the deck is about", () => {
    expect(newDeckTitle(" Series A ", "a pitch")).toBe("Series A");
    expect(newDeckTitle("", "a pitch for investors")).toBe("A pitch for investors");
    expect(newDeckTitle(" ", " ")).toBe(UNTITLED_DECK);
  });
});

describe("matchingDecks", () => {
  const decks = [
    { title: "Q3 board update", path: "/lib/q3/deck.html" },
    { title: "Pitch", path: "/work/tool-library/deck.html" },
  ];

  it("finds decks by every word of the query, in their title or folder", () => {
    expect(matchingDecks(decks, "")).toEqual(decks);
    expect(matchingDecks(decks, "board")).toEqual([decks[0]]);
    expect(matchingDecks(decks, "TOOL pitch")).toEqual([decks[1]]);
    expect(matchingDecks(decks, "q3 pitch")).toEqual([]);
  });
});
