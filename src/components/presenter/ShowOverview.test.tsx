// All the slides, opened over a show that goes on: a long deck must not load every slide's page at once.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Deck } from "../../lib/api";
import { useApp } from "../../store";
import { DECK_HTML, deckFor } from "../../test/fixtures";
import { type Place, placeElements, resetPlaces } from "../../test/intersection";
import { ShowOverview } from "./ShowOverview";

const NoLayout = globalThis.ResizeObserver;

/** Reports every picture 200 px wide, as a browser does after layout. */
class MeasuringObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target, contentRect: { width: 200 } } as unknown as ResizeObserverEntry], this as never);
  }
  unobserve() {}
  disconnect() {}
}

/** How many rows of four the overview shows at once. */
const ROWS = 3;
const COLUMNS = 4;

const deckOf = (count: number): Deck => ({
  ...deckFor(DECK_HTML),
  slides: Array.from({ length: count }, (_, i) => ({ ...deckFor(DECK_HTML).slides[0]!, id: `s${i}`, hash: `s${i}` })),
  sections: [],
});

const items = () => [...document.querySelectorAll("li")];
const framed = () => items().flatMap((item, i) => (item.querySelector("iframe") ? [i] : []));

/** Lets every page that is loading load, and those that then get their turn, until none is left. */
function loadAll() {
  const loaded = new WeakSet<Element>();
  for (let waiting = [...document.querySelectorAll("iframe")]; waiting.length > 0; ) {
    for (const frame of waiting) {
      loaded.add(frame);
      fireEvent.load(frame);
    }
    waiting = [...document.querySelectorAll("iframe")].filter((f) => !loaded.has(f));
  }
}

/** Scrolls the overview so that row `first` is its top one. */
function scrollTo(first: number) {
  act(() =>
    placeElements((element): Place => {
      const item = element.closest("li");
      if (!item) return 0;
      const row = Math.floor(items().indexOf(item) / COLUMNS);
      return row < first ? (first - row) / ROWS : Math.max(0, (row - first - ROWS + 1) / ROWS);
    }),
  );
}

beforeEach(() => {
  globalThis.ResizeObserver = MeasuringObserver as unknown as typeof ResizeObserver;
  useApp.setState({ deck: deckOf(60), assetsRev: 0 });
});

afterEach(() => {
  globalThis.ResizeObserver = NoLayout;
  resetPlaces();
});

describe("ShowOverview", () => {
  it("loads the pages of the slides in sight or near it, not those of the whole deck", () => {
    const deck = deckOf(60);
    render(<ShowOverview deck={deck} current="s0" onPick={() => {}} onClose={() => {}} />);
    scrollTo(0);
    loadAll();
    expect(screen.getAllByRole("listitem")).toHaveLength(60);
    // The rows in sight and those within a screenful below them: seven rows of four, of fifteen.
    expect(framed()).toEqual(Array.from({ length: 28 }, (_, i) => i));
    // Scrolled down, the slides there load.
    scrollTo(12);
    loadAll();
    expect(framed()).toContain(59);
  });
});
