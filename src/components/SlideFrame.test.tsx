import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_FRAME_LOADS } from "../lib/frameLoads";

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { type Place, placeElements } from "../test/intersection";
import { SLIDE_SCALE, SlideFrame, useSlideVersion } from "./SlideFrame";

const NoLayout = globalThis.ResizeObserver;
let width = 960;
const observers: { callback: ResizeObserverCallback; disconnected: boolean }[] = [];

/** Reports `width` for every observed element, like a browser after layout. */
class MeasuringObserver {
  private entry: { callback: ResizeObserverCallback; disconnected: boolean };
  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, disconnected: false };
    observers.push(this.entry);
  }
  observe(target: Element) {
    this.entry.callback(
      [{ target, contentRect: { width } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {
    this.entry.disconnected = true;
  }
}

beforeEach(() => {
  width = 960;
  observers.length = 0;
  globalThis.ResizeObserver = MeasuringObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  globalThis.ResizeObserver = NoLayout;
});

const frames = (container: HTMLElement) => [...container.querySelectorAll("iframe")];

describe("SlideFrame", () => {
  it("renders the slide through the deck's player, scaled to fit", () => {
    const { container } = render(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" />);
    const [frame] = frames(container);
    expect(frame!.getAttribute("src")).toBe("/__deck/.file/decks/talk/deck.html?embed&slide=intro&v=v1");
    expect(frame!.title).toBe("intro");
    expect(frame!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame!.style.width).toBe("1920px");
    expect(frame!.style.height).toBe("1080px");
    expect(frame!.style.transform).toBe("scale(0.5)");
    expect(frame!.style.pointerEvents).toBe("auto");
    expect(frame!.tabIndex).not.toBe(-1);
  });

  it("keeps its loaded slide while its panel is collapsed to nothing", () => {
    const { container } = render(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" thumbnail />);
    const frame = frames(container)[0]!;
    const report = (w: number) =>
      act(() =>
        observers[0]!.callback(
          [{ target: container.firstElementChild, contentRect: { width: w } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        ),
      );
    // A thumbnail's scale is its container's to hold (see SLIDE_SCALE).
    const scale = () => (container.firstElementChild as HTMLElement).style.getPropertyValue(SLIDE_SCALE);
    expect(frame.style.transform).toBe(`scale(var(${SLIDE_SCALE}))`);
    report(0);
    expect(frames(container)).toEqual([frame]);
    expect(scale()).toBe("0.5");
    report(192);
    expect(frames(container)).toEqual([frame]);
    expect(scale()).toBe("0.1");
  });

  it("loads the slide editor (on the final animation frame) in edit mode", () => {
    const { container, rerender } = render(
      <SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" editKey="0" />,
    );
    expect(frames(container)[0]!.getAttribute("src")).toBe(
      "/__deck/.file/decks/talk/deck.html?embed&slide=intro&v=v1&static&edit=0",
    );
    expect(frames(container)[0]!.style.pointerEvents).toBe("auto");
    // A new key reloads the slide, e.g. after a refused save.
    rerender(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" editKey="1" />);
    expect(frames(container).map((f) => f.getAttribute("src"))).toContain(
      "/__deck/.file/decks/talk/deck.html?embed&slide=intro&v=v1&static&edit=1",
    );
  });

  const arena = { width: 1200, height: 700 };

  it("lets the editor's preview fill the arena around the centered slide, keeping the slide's scale", () => {
    const { container } = render(
      <SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" editKey="0" arena={arena} />,
    );
    const [frame] = frames(container);
    expect(frame!.style.width).toBe("2400px");
    expect(frame!.style.height).toBe("1400px");
    expect(frame!.style.left).toBe("-120px");
    expect(frame!.style.top).toBe("-80px");
    expect(frame!.style.transform).toBe("scale(0.5)");
    expect((container.firstElementChild as HTMLElement).style.overflow).toBe("visible");
  });

  it("never makes the preview smaller than the slide", () => {
    const { container } = render(
      <SlideFrame
        deckId="/decks/talk/deck.html"
        slideId="intro"
        version="v1"
        editKey="0"
        arena={{ width: 100, height: 100 }}
      />,
    );
    const [frame] = frames(container);
    expect(frame!.style.width).toBe("1920px");
    expect(frame!.style.height).toBe("1080px");
    expect(frame!.style.left).toBe("0px");
  });

  it("puts a preview given an arena on the pasteboard, in view and edit mode", () => {
    const { container, rerender } = render(
      <SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" arena={arena} />,
    );
    const [viewer] = frames(container);
    expect(viewer!.getAttribute("src")).toBe("/__deck/.file/decks/talk/deck.html?embed&slide=intro&v=v1&pan");
    expect(viewer!.style.width).toBe("2400px");
    expect(viewer!.style.left).toBe("-120px");
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.overflow).toBe("visible");
    // The slide may be panned anywhere, so nothing is painted where it started.
    expect(box.style.background).toBe("transparent");
    rerender(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" editKey="0" arena={arena} />);
    const editor = frames(container).at(-1)!;
    expect(editor.getAttribute("src")).toBe(
      "/__deck/.file/decks/talk/deck.html?embed&slide=intro&v=v1&static&pan&edit=0",
    );
    expect(editor.style.width).toBe("2400px");
  });

  it("keeps a plain preview and thumbnails to the slide, clipped, with no pasteboard", () => {
    const { container, rerender } = render(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" />);
    const box = () => container.firstElementChild as HTMLElement;
    expect(frames(container)[0]!.getAttribute("src")).not.toContain("pan");
    expect(box().style.overflow).toBe("hidden");
    expect(box().style.background).toBe("var(--stage)");
    rerender(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" thumbnail arena={arena} />);
    const thumb = frames(container).at(-1)!;
    expect(thumb.getAttribute("src")).not.toContain("pan");
    expect(thumb.style.width).toBe("1920px");
  });

  it("renders slides of another size in their own shape", () => {
    const { container, rerender } = render(
      <SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" size={{ width: 1080, height: 1350 }} />,
    );
    const box = () => container.firstElementChild as HTMLElement;
    const [frame] = frames(container);
    expect(box().style.aspectRatio).toBe("1080 / 1350");
    expect(frame!.style.width).toBe("1080px");
    expect(frame!.style.height).toBe("1350px");
    // A 960 px wide box shows the 1080 px canvas at 960 / 1080.
    expect(frame!.style.transform).toBe(`scale(${960 / 1080})`);
    // Back to the default size: measured again against the new width.
    rerender(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" />);
    expect(box().style.aspectRatio).toBe("1920 / 1080");
    expect(frames(container)[0]!.style.transform).toBe("scale(0.5)");
  });

  it("waits for layout before loading anything", () => {
    globalThis.ResizeObserver = NoLayout;
    const { container } = render(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" />);
    expect(frames(container)).toEqual([]);
  });

  it("follows size changes", () => {
    const { container } = render(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" />);
    width = 1920;
    act(() => observers[0]!.callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(frames(container)[0]!.style.transform).toBe("scale(1)");
  });

  it("stops observing when unmounted", () => {
    const { unmount } = render(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" />);
    unmount();
    expect(observers[0]!.disconnected).toBe(true);
  });

  it("thumbnails are static and inert", () => {
    const { container } = render(<SlideFrame deckId="/decks/talk/deck.html" slideId="#2" version="v1" thumbnail />);
    const [frame] = frames(container);
    expect(frame!.getAttribute("src")).toBe("/__deck/.file/decks/talk/deck.html?embed&slide=%232&v=v1&static");
    expect(frame!.tabIndex).toBe(-1);
    expect(frame!.style.pointerEvents).toBe("none");
  });

  it("shows the final state on request, still taking pointer input", () => {
    const arena = { width: 1600, height: 900 };
    const { container } = render(
      <SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" still arena={arena} />,
    );
    const [frame] = frames(container);
    expect(frame!.getAttribute("src")).toBe("/__deck/.file/decks/talk/deck.html?embed&slide=intro&v=v1&static&pan");
    expect(frame!.tabIndex).not.toBe(-1);
    expect(frame!.style.pointerEvents).toBe("auto");
  });

  it("loads a new version behind the current one and swaps once it has loaded", () => {
    const onFrameReady = vi.fn();
    const { container, rerender } = render(
      <SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" onFrameReady={onFrameReady} />,
    );
    rerender(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v2" onFrameReady={onFrameReady} />);
    const [current, next] = frames(container);
    expect(current!.getAttribute("src")).toContain("v=v1");
    expect(next!.getAttribute("src")).toContain("v=v2");
    expect(current!.style.visibility).toBe("visible");
    expect(next!.style.visibility).toBe("hidden");

    // The old frame finishing a reload changes nothing.
    fireEvent.load(current!);
    expect(frames(container)).toHaveLength(2);

    fireEvent.load(next!);
    expect(frames(container)).toEqual([next]);
    expect(next!.style.visibility).toBe("visible");
    expect(onFrameReady).toHaveBeenLastCalledWith(next);
  });

  it("only keeps the newest pending version", () => {
    const { container, rerender } = render(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" />);
    rerender(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v2" />);
    rerender(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v3" />);
    expect(frames(container).map((f) => f.getAttribute("src")!.split("v=")[1])).toEqual(["v1", "v3"]);
  });

  it("gives up a version loading behind when the one on show is wanted again", () => {
    const { container, rerender } = render(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" />);
    const [current] = frames(container);
    rerender(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v2" />);
    expect(frames(container)).toHaveLength(2);
    rerender(<SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" />);
    expect(frames(container)).toEqual([current]);
  });

  it("reports the first load too", () => {
    const onFrameReady = vi.fn();
    const { container } = render(
      <SlideFrame deckId="/decks/talk/deck.html" slideId="intro" version="v1" onFrameReady={onFrameReady} />,
    );
    fireEvent.load(frames(container)[0]!);
    expect(onFrameReady).toHaveBeenCalledWith(frames(container)[0]);
  });
});

describe("a lazy preview, one of a list that scrolls", () => {
  const DECK_ID = "/decks/talk/deck.html";
  const thumb = (slide: string, version = "v1") => (
    <div data-slide={slide}>
      <SlideFrame deckId={DECK_ID} slideId={slide} version={version} thumbnail lazy />
    </div>
  );
  /** Puts the previews where `places` says, by slide; in view when not said. */
  const scroll = (places: Record<string, Place>) =>
    act(() =>
      placeElements((element) => {
        const slide = element.closest<HTMLElement>("[data-slide]")?.dataset.slide ?? "";
        return slide in places ? places[slide]! : 0;
      }),
    );
  const versions = (container: HTMLElement) => frames(container).map((f) => f.getAttribute("src")!.split("v=")[1]);

  it("has no document until the list is about to show it, its box keeping its shape", () => {
    scroll({ intro: 6 });
    const { container } = render(thumb("intro"));
    const box = container.querySelector<HTMLElement>("[data-slide] > div")!;
    expect(frames(container)).toEqual([]);
    expect(box.style.aspectRatio).toBe("1920 / 1080");
    scroll({ intro: 2 });
    expect(frames(container)).toEqual([]);
    scroll({ intro: 0.5 });
    expect(frames(container)).toHaveLength(1);
    expect(frames(container)[0]!.style.visibility).toBe("visible");
  });

  it("keeps its document a few screenfuls off, so coming back shows it at once, and lets it go far away", () => {
    const { container } = render(thumb("intro"));
    const [frame] = frames(container);
    fireEvent.load(frame!);
    scroll({ intro: 2 });
    expect(frames(container)).toEqual([frame]);
    scroll({ intro: 0 });
    expect(frames(container)).toEqual([frame]);
    scroll({ intro: 6 });
    expect(frames(container)).toEqual([]);
    scroll({ intro: 0.5 });
    expect(frames(container)).toHaveLength(1);
  });

  it("keeps its document while it takes no space: a folded section, a closed panel", () => {
    const { container } = render(thumb("intro"));
    const [frame] = frames(container);
    scroll({ intro: null });
    expect(frames(container)).toEqual([frame]);
  });

  it("loads nothing where it takes no space", () => {
    scroll({ intro: null });
    const { container } = render(thumb("intro"));
    expect(frames(container)).toEqual([]);
  });

  it("follows a new version only once it is back near the view", () => {
    const { container, rerender } = render(thumb("intro"));
    fireEvent.load(frames(container)[0]!);
    scroll({ intro: 2 });
    rerender(thumb("intro", "v2"));
    rerender(thumb("intro", "v3"));
    expect(versions(container)).toEqual(["v1&static"]);
    scroll({ intro: 0.5 });
    // The version it has stays on show while the newest loads behind it.
    expect(versions(container)).toEqual(["v1&static", "v3&static"]);
    fireEvent.load(frames(container)[1]!);
    expect(versions(container)).toEqual(["v3&static"]);
  });

  it("starts with the current version when it comes into view with nothing loaded", () => {
    scroll({ intro: 6 });
    const { container, rerender } = render(thumb("intro"));
    rerender(thumb("intro", "v2"));
    scroll({ intro: 0 });
    expect(versions(container)).toEqual(["v2&static"]);
  });

  it("loads a few at a time, the ones in view before the ones near it", () => {
    const slides = ["a", "b", "c", "d", "e", "f"];
    scroll({ a: 0.5, b: 0.5, c: 0.5, d: 0.5, e: 0.5, f: 0 });
    const { container } = render(
      <div>
        {slides.map((slide) => (
          <div key={slide}>{thumb(slide)}</div>
        ))}
      </div>,
    );
    const loading = () => frames(container).map((f) => f.title);
    expect(loading()).toHaveLength(MAX_FRAME_LOADS);
    expect(loading()).toEqual(["a", "b", "c"]);
    fireEvent.load(frames(container)[0]!);
    // The one in view, though it asked last.
    expect(loading()).toEqual(["a", "b", "c", "f"]);
    fireEvent.load(frames(container)[1]!);
    expect(loading()).toEqual(["a", "b", "c", "d", "f"]);
  });

  it("gives its place up when it goes before it has loaded", () => {
    const slides = ["a", "b", "c", "d"];
    const { container, rerender } = render(
      <div>
        {slides.map((slide) => (
          <div key={slide}>{thumb(slide)}</div>
        ))}
      </div>,
    );
    expect(frames(container).map((f) => f.title)).toEqual(["a", "b", "c"]);
    rerender(
      <div>
        {slides.slice(1).map((slide) => (
          <div key={slide}>{thumb(slide)}</div>
        ))}
      </div>,
    );
    expect(frames(container).map((f) => f.title)).toEqual(["b", "c", "d"]);
  });

  it("waits while the slide on the stage loads, which does not wait for anything", () => {
    const { container } = render(
      <>
        <div data-stage>
          <SlideFrame deckId={DECK_ID} slideId="intro" version="v1" />
        </div>
        {thumb("intro")}
      </>,
    );
    const stage = container.querySelector("[data-stage] iframe")!;
    expect(stage).toBeTruthy();
    expect(container.querySelector("[data-slide] iframe")).toBeNull();
    fireEvent.load(stage);
    expect(container.querySelector("[data-slide] iframe")).toBeTruthy();
  });

  it("is resized by its container's scale alone, without rendering", () => {
    const commits = vi.fn();
    const { container } = render(
      <Profiler id="thumb" onRender={commits}>
        {thumb("intro")}
      </Profiler>,
    );
    const box = container.querySelector<HTMLElement>("[data-slide] > div")!;
    commits.mockClear();
    for (const w of [200, 220, 240]) {
      act(() =>
        observers[0]!.callback(
          [{ target: box, contentRect: { width: w } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        ),
      );
    }
    expect(box.style.getPropertyValue(SLIDE_SCALE)).toBe("0.125");
    expect(commits).not.toHaveBeenCalled();
  });
});

describe("useSlideVersion", () => {
  it("changes with the slide, the deck's shared styles, and attached assets", () => {
    useApp.setState({ deck: deckFor(DECK_HTML), assetsRev: 0 });
    const slide = { id: "intro", hash: "h1", hidden: false, locked: false, moved: false };
    const { result, rerender } = renderHook(({ s }) => useSlideVersion(s), { initialProps: { s: slide } });
    expect(result.current).toBe("shell-1.h1.0");
    rerender({ s: { ...slide, hash: "h2" } });
    expect(result.current).toBe("shell-1.h2.0");
    act(() => useApp.setState({ assetsRev: 3 }));
    expect(result.current).toBe("shell-1.h2.3");
    act(() => useApp.setState({ deck: deckFor(DECK_HTML, "9") }));
    expect(result.current).toBe("shell-9.h2.3");
  });
});
