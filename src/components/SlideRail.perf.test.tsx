// How much the rail does: which thumbnails have a document, and which rows render when the
// selection or the deck changes. The rail's behaviour is in SlideRail.test.tsx.
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Deck } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { type Place, placeElements } from "../test/intersection";
import { invoke } from "../test/tauri";
import { EDITED_THUMBNAIL_DELAY } from "./rail/Thumbnail";
import { SLIDE_SCALE } from "./SlideFrame";
import { SlideRail } from "./SlideRail";

/** The rows that rendered, by their key, since it was last emptied. */
const rendered = vi.hoisted(() => [] as string[]);
vi.mock("@dnd-kit/sortable", async (original) => {
  const actual = await original<typeof import("@dnd-kit/sortable")>();
  const useSortable: typeof actual.useSortable = (args) => {
    rendered.push(String(args.id));
    return actual.useSortable(args);
  };
  return { ...actual, useSortable };
});
/** The thumbnails' pictures and quick actions that rendered, by their slide, since it was last emptied. */
const parts = vi.hoisted(() => ({ pictures: [] as string[], actions: [] as string[] }));
vi.mock("./SlideImage", async (original) => {
  const actual = await original<typeof import("./SlideImage")>();
  const SlideImage: typeof actual.SlideImage = (props) => {
    parts.pictures.push(props.slideId);
    return actual.SlideImage(props);
  };
  return { ...actual, SlideImage };
});
vi.mock("./rail/SlideActions", async (original) => {
  const actual = await original<typeof import("./rail/SlideActions")>();
  const Inner = (actual.SlideActions as unknown as { type: (props: never) => React.ReactNode }).type;
  const { memo } = await import("react");
  const SlideActions = memo((props: Parameters<typeof actual.SlideActions>[0]) => {
    parts.actions.push(props.slide.id);
    return Inner(props as never);
  });
  return { ...actual, SlideActions };
});

const NoLayout = globalThis.ResizeObserver;
const measured: { target: Element; callback: ResizeObserverCallback }[] = [];

/** Reports a rail 192 px wide for every thumbnail, as a browser does after layout. */
class MeasuringObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    measured.push({ target, callback: this.callback });
    this.callback([{ target, contentRect: { width: 192 } } as unknown as ResizeObserverEntry], this as never);
  }
  unobserve() {}
  disconnect() {}
}

const slide = (id: string, hash = id) => ({ id, hash, hidden: false, locked: false, moved: false });
const deckOf = (count: number, more: Partial<Deck> = {}): Deck => ({
  ...deckFor(DECK_HTML),
  slides: Array.from({ length: count }, (_, i) => slide(`s${i}`)),
  ...more,
});
/** The deck with slide `index` saved anew. */
const saved = (deck: Deck, index: number, hash: string): Deck => ({
  ...deck,
  slides: deck.slides.map((s, i) => (i === index ? { ...s, hash } : { ...s })),
});

// A hundred sortable rows take jsdom a while to mount, longer on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

/** How many rows the rail shows at once. */
const ROWS = 8;
const rows = () => [...document.querySelectorAll<HTMLElement>("li[data-rail-slide]")];
const frames = () => [...document.querySelectorAll("iframe")];
const framed = () => rows().flatMap((row, i) => (row.querySelector("iframe") ? [i] : []));

/** Scrolls the rail so that row `first` is its top one: rows folded away take no space. */
function scrollTo(first: number) {
  act(() =>
    placeElements((element): Place => {
      const row = element.closest<HTMLElement>("li[data-rail-slide]");
      if (!row || row.classList.contains("hidden")) return null;
      let at = 0;
      for (let above = row.previousElementSibling; above; above = above.previousElementSibling) {
        if (above.matches("li[data-rail-slide]:not(.hidden)")) at++;
      }
      return at < first ? (first - at) / ROWS : Math.max(0, (at - first - ROWS + 1) / ROWS);
    }),
  );
}

/** Lets every document that is loading load, and those that then get their turn, until none is left. */
function loadAll() {
  const loaded = new WeakSet<Element>();
  for (let waiting = frames().filter((f) => !loaded.has(f)); waiting.length > 0; ) {
    for (const frame of waiting) {
      loaded.add(frame);
      fireEvent.load(frame);
    }
    waiting = frames().filter((f) => !loaded.has(f));
  }
}

beforeEach(() => {
  invoke.mockReset();
  measured.length = 0;
  globalThis.ResizeObserver = MeasuringObserver as unknown as typeof ResizeObserver;
  useApp.setState({
    deck: deckOf(100),
    selected: "s0",
    editing: false,
    editSaved: {},
    assetsRev: 0,
    railSelected: [],
    collapsedSections: [],
    comments: {},
  });
});

afterEach(() => {
  globalThis.ResizeObserver = NoLayout;
  vi.useRealTimers();
});

describe("the documents the rail holds", () => {
  it("loads only the thumbnails the rail shows or is about to", () => {
    scrollTo(0);
    render(<SlideRail />);
    loadAll();
    expect(rows()).toHaveLength(100);
    // The eight in view and a screenful and a bit under them, of a hundred.
    expect(framed()).toEqual(Array.from({ length: 19 }, (_, i) => i));
  });

  it("loads the ones scrolled to, and lets go of those left far behind", () => {
    scrollTo(0);
    render(<SlideRail />);
    loadAll();
    scrollTo(20);
    loadAll();
    const held = framed();
    // Those near the view now, and the ones loaded before that are still close.
    expect(held).toContain(20);
    expect(held).toContain(38);
    expect(held).not.toContain(39);
    expect(held).toContain(0);
    scrollTo(80);
    loadAll();
    expect(framed().every((row) => row >= 44)).toBe(true);
    expect(framed()).toContain(80);
    expect(frames().length).toBeLessThan(40);
  });

  it("loads none in a folded section, until it is opened", () => {
    useApp.setState({
      deck: deckOf(12, { sections: [{ index: 0, title: "Later", before: 4 }] }),
      collapsedSections: ["s4"],
    });
    scrollTo(0);
    render(<SlideRail />);
    loadAll();
    expect(framed()).toEqual([0, 1, 2, 3]);
    act(() => useApp.getState().toggleSection("s4", false));
    scrollTo(0);
    loadAll();
    expect(framed()).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it("loads a changed slide that is out of view only once the rail gets to it", () => {
    scrollTo(0);
    render(<SlideRail />);
    loadAll();
    scrollTo(24);
    loadAll();
    const before = frames().length;
    const shown = () => rows()[8]!.querySelector("iframe")!.getAttribute("src");
    const was = shown();
    // Row 8 is two screenfuls up: still holding its document, not following the deck.
    act(() => useApp.getState().setDeck(saved(useApp.getState().deck!, 8, "again")));
    expect(frames()).toHaveLength(before);
    expect(shown()).toBe(was);
    scrollTo(4);
    expect(rows()[8]!.querySelectorAll("iframe")).toHaveLength(2);
    expect(rows()[8]!.querySelectorAll("iframe")[1]!.getAttribute("src")).toContain("again");
  });

  it("loads one new document for a slide saved five times while it is edited", () => {
    vi.useFakeTimers();
    scrollTo(0);
    render(<SlideRail />);
    loadAll();
    const sources = () =>
      [...rows()[2]!.querySelectorAll("iframe")].map((f) => f.getAttribute("src")!.match(/\.(\w+)\.0&/)![1]);
    expect(sources()).toEqual(["s2"]);
    act(() => useApp.setState({ editing: true }));
    for (const hash of ["e1", "e2", "e3", "e4", "e5"]) {
      act(() => {
        // The editor's own save: the deck it answers with, and whose it is.
        useApp.setState((s) => ({ editSaved: { ...s.editSaved, s2: hash } }));
        useApp.getState().setDeck(saved(useApp.getState().deck!, 2, hash));
      });
      act(() => void vi.advanceTimersByTime(EDITED_THUMBNAIL_DELAY / 2));
    }
    expect(sources()).toEqual(["s2"]);
    act(() => void vi.advanceTimersByTime(EDITED_THUMBNAIL_DELAY));
    expect(sources()).toEqual(["s2", "e5"]);
  });

  it("shows a change that is not the editor's own at once", () => {
    scrollTo(0);
    render(<SlideRail />);
    loadAll();
    act(() => useApp.getState().setDeck(saved(useApp.getState().deck!, 2, "agent")));
    expect(rows()[2]!.querySelectorAll("iframe")[1]!.getAttribute("src")).toContain("agent");
  });
});

describe("the rows the rail renders", () => {
  it("renders two rows when the selection goes to the next slide", () => {
    useApp.setState({ deck: deckOf(50) });
    render(<SlideRail />);
    rendered.length = 0;
    act(() => useApp.getState().selectRelative(1));
    expect([...rendered].sort()).toEqual(["s0", "s1"]);
    rendered.length = 0;
    act(() => useApp.getState().selectRelative(1));
    act(() => useApp.getState().selectRelative(1));
    expect(new Set(rendered)).toEqual(new Set(["s1", "s2", "s3"]));
  });

  it("renders one row when the deck comes back with one slide changed", () => {
    useApp.setState({ deck: deckOf(50) });
    render(<SlideRail />);
    rendered.length = 0;
    act(() => useApp.getState().setDeck(saved(useApp.getState().deck!, 3, "new")));
    expect(rendered).toEqual(["s3"]);
  });

  it("renders nothing when the deck comes back as it is", () => {
    useApp.setState({ deck: deckOf(50) });
    render(<SlideRail />);
    rendered.length = 0;
    act(() => useApp.getState().setDeck(structuredClone(useApp.getState().deck!)));
    expect(rendered).toEqual([]);
  });

  it("renders no row, picture or quick action when the mode changes; the tooltips follow by themselves", () => {
    useApp.setState({ deck: deckOf(50) });
    render(<SlideRail />);
    const tooltip = () => rows()[3]!.querySelector("button[data-thumbnail]")!.getAttribute("title");
    expect(tooltip()).toBe("Slide 4 · S3 · double-click to edit");
    rendered.length = 0;
    parts.pictures.length = 0;
    parts.actions.length = 0;
    act(() => useApp.getState().setMode("edit"));
    expect(tooltip()).toBe("Slide 4 · S3");
    act(() => useApp.getState().setMode("view"));
    expect(tooltip()).toBe("Slide 4 · S3 · double-click to edit");
    expect(rendered).toEqual([]);
    expect(parts).toEqual({ pictures: [], actions: [] });
  });

  it("renders no row when the deck is read again with its slides as they were, as new objects", () => {
    useApp.setState({ deck: deckOf(50) });
    render(<SlideRail />);
    rendered.length = 0;
    parts.pictures.length = 0;
    // As when the deck opens again: nothing shared with the deck shown.
    act(() => useApp.setState({ deck: structuredClone(useApp.getState().deck!) }));
    expect(rendered).toEqual([]);
    expect(parts.pictures).toEqual([]);
  });

  it("renders the rows a search changes, not their pictures or quick actions", () => {
    useApp.setState({ deck: deckOf(50) });
    render(<SlideRail />);
    const found = (...slides: string[]) =>
      act(() => useApp.getState().setSearchMatches(slides.map((slide) => ({ slide }) as never)));
    found("s3", "s3");
    rendered.length = 0;
    parts.pictures.length = 0;
    parts.actions.length = 0;
    // One more hit on a slide found already, one on a slide that was dimmed.
    found("s3", "s3", "s3", "s7");
    expect([...new Set(rendered)].sort()).toEqual(["s3", "s7"]);
    expect(parts).toEqual({ pictures: [], actions: [] });
    rendered.length = 0;
    found("s3", "s3", "s3", "s7");
    expect(rendered).toEqual([]);
  });

  it("renders no row for a comment on a slide but that slide's", () => {
    useApp.setState({ deck: deckOf(50) });
    render(<SlideRail />);
    rendered.length = 0;
    act(() => useApp.setState({ comments: { s5: [{ id: "c", text: "Bigger", x: 0.5, y: 0.5 }] } }));
    expect(rendered).toEqual(["s5"]);
  });

  it("renders no row while the rail is made wider: the thumbnails scale by themselves", () => {
    useApp.setState({ deck: deckOf(50) });
    render(<SlideRail />);
    rendered.length = 0;
    for (const width of [200, 240, 288]) {
      act(() => {
        for (const { target, callback } of measured)
          callback([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
      });
    }
    expect(rendered).toEqual([]);
    const box = rows()[0]!.querySelector<HTMLElement>("button > div")!;
    expect(box.style.getPropertyValue(SLIDE_SCALE)).toBe("0.15");
  });

  it("changes a thumbnail's ring without a transition, which would repaint the slide under it", () => {
    render(<SlideRail />);
    const button = rows()[0]!.querySelector("button[data-thumbnail]")!;
    expect(button.className).toMatch(/\bring-2\b/);
    expect(button.className).not.toMatch(/transition/);
  });
});
