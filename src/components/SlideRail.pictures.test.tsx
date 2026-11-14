// What the slide list and the grid of all slides hold in the app, where slides are pictures the
// backend makes (see SlideImage.tsx): no document per slide, and one picture per slide changed.
// The browser preview, which makes no pictures, is what SlideRail.perf.test.tsx covers.
import { act, fireEvent, render } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Addresses are the app's (slop://), as in the webview, only with Tauri there.
vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

import type { Deck } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { type Place, placeElements } from "../test/intersection";
import { invoke } from "../test/tauri";
import { SlideOverview } from "./SlideOverview";
import { SlideRail } from "./SlideRail";

afterAll(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

vi.setConfig({ testTimeout: 30_000 });

const slide = (id: string, hash = id) => ({ id, hash, hidden: false, locked: false, moved: false });
const deckOf = (count: number): Deck => ({
  ...deckFor(DECK_HTML),
  slides: Array.from({ length: count }, (_, i) => slide(`s${i}`)),
});
const saved = (deck: Deck, index: number, hash: string): Deck => ({
  ...deck,
  slides: deck.slides.map((s, i) => (i === index ? { ...s, hash } : { ...s })),
});

const ROWS = 8;
const rows = () => [...document.querySelectorAll<HTMLElement>("li[data-rail-slide]")];
const images = () => [...document.querySelectorAll("img")];
const sources = () => images().map((img) => img.getAttribute("src")!);

/** The rail and the grid both show their first rows. */
function scrollToTop() {
  act(() =>
    placeElements((element): Place => {
      const row = element.closest<HTMLElement>("li[data-rail-slide]");
      if (!row) return null;
      const list = row.parentElement!;
      const at = [...list.children].filter((r) => r.matches("li[data-rail-slide]")).indexOf(row);
      return Math.max(0, (at - ROWS + 1) / ROWS);
    }),
  );
}

/** Every picture asked for comes in, and those that then get their turn, until none is left. */
function loadAll() {
  const loaded = new WeakSet<Element>();
  for (let waiting = images().filter((i) => !loaded.has(i)); waiting.length > 0; ) {
    for (const img of waiting) {
      loaded.add(img);
      act(() => fireEvent.load(img));
    }
    waiting = images().filter((i) => !loaded.has(i));
  }
}

beforeEach(() => {
  invoke.mockReset();
  useApp.setState({
    deck: deckOf(40),
    selected: "s0",
    editing: false,
    editSaved: {},
    assetsRev: 0,
    railSelected: [],
    collapsedSections: [],
    comments: {},
  });
});

describe("slides as pictures", () => {
  it("the slide list and the grid of all slides hold no document per slide", () => {
    scrollToTop();
    render(
      <>
        <SlideRail />
        <SlideOverview />
      </>,
    );
    loadAll();
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    expect(rows()).toHaveLength(80);
    // Each list's rows in view and a screenful and a bit under them.
    expect(images()).toHaveLength(2 * 19);
    expect(sources().every((src) => src.startsWith("slop://localhost/.thumb/.file/"))).toBe(true);
  });

  it("a slide saved asks for one picture, and the others stay as they are", () => {
    scrollToTop();
    render(<SlideRail />);
    loadAll();
    const before = sources();
    act(() => useApp.getState().setDeck(saved(useApp.getState().deck!, 2, "agent")));
    const after = sources();
    const added = after.filter((src) => !before.includes(src));
    expect(added).toHaveLength(1);
    expect(added[0]).toContain("slide=s2");
    // The one on show stays until the new one is in.
    expect(after).toEqual(expect.arrayContaining(before));
    loadAll();
    expect(sources()).toHaveLength(before.length);
    expect(sources().filter((src) => !before.includes(src))).toEqual(added);
  });

  it("a change to the deck's style asks for every picture again, keeping the old ones on show", () => {
    scrollToTop();
    render(<SlideRail />);
    loadAll();
    const shown = images().length;
    act(() => useApp.setState((s) => ({ deck: { ...s.deck!, shellHash: "restyled" } })));
    loadAll();
    expect(images()).toHaveLength(shown);
    expect(sources().every((src) => src.includes("v=restyled."))).toBe(true);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });
});
