import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api";
import { MAX_PICTURE_LOADS } from "../lib/frameLoads";
import { placeElements } from "../test/intersection";
import { LIVE_AFTER, SlideImage } from "./SlideImage";

/** A preview the backend serves, so that it has a picture (see ../lib/thumbnails.ts). */
const preview = (slide: string, version = "1") =>
  `slop://localhost/.file/talks/deck.html?embed&slide=${slide}&v=${version}&static`;
const picture = (slide: string, version = "1") =>
  `slop://localhost/.thumb/.file/talks/deck.html?embed&slide=${slide}&v=${version}&static`;

const images = () => [...document.querySelectorAll("img")];
const shown = () => images().filter((img) => img.style.visibility === "visible");
const frames = () => [...document.querySelectorAll("iframe")];
/** The live previews standing in for pictures not made yet. */
const standIns = () => [...document.querySelectorAll("[data-stand-in]")];

/** Every picture that is loading loads, and those that then get their turn, until none is left. */
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

afterEach(() => {
  // Ends any load a test left running, so the next test's pictures get their turn.
  loadAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A picture the backend has to make first: the live preview stands in after a while. */
function late() {
  act(() => vi.advanceTimersByTime(LIVE_AFTER));
}

describe("a slide shown as a picture", () => {
  it("is an image of the backend's picture of the preview, with no document of its own", () => {
    render(<SlideImage deckId="/talks/deck.html" slideId="a" version="1" url={preview("a")} />);
    expect(frames()).toHaveLength(0);
    expect(images().map((img) => img.getAttribute("src"))).toEqual([picture("a")]);
    loadAll();
    expect(shown().map((img) => img.getAttribute("src"))).toEqual([picture("a")]);
  });

  it("keeps the version on show until the new one is in, then lets it go", () => {
    const { rerender } = render(<SlideImage deckId="d" slideId="a" version="1" url={preview("a", "1")} />);
    loadAll();
    rerender(<SlideImage deckId="d" slideId="a" version="2" url={preview("a", "2")} />);
    expect(images().map((img) => img.getAttribute("src"))).toEqual([picture("a", "1"), picture("a", "2")]);
    expect(shown().map((img) => img.getAttribute("src"))).toEqual([picture("a", "1")]);
    act(() => fireEvent.load(images()[1]!));
    expect(images().map((img) => img.getAttribute("src"))).toEqual([picture("a", "2")]);
    expect(shown()).toHaveLength(1);
  });

  it("is the live preview where no picture could be made, from then on", () => {
    const { rerender } = render(<SlideImage deckId="d" slideId="a" version="1" url={preview("a", "1")} />);
    act(() => fireEvent.error(images()[0]!));
    expect(images()).toHaveLength(0);
    rerender(<SlideImage deckId="d" slideId="a" version="2" url={preview("a", "2")} />);
    expect(images()).toHaveLength(0);
    expect(document.querySelector("[style*='aspect-ratio']")).not.toBeNull();
  });

  it("is the live preview where nothing makes pictures (the browser preview)", () => {
    render(<SlideImage deckId="d" slideId="a" version="1" url="/__deck/.file/d?embed&slide=a&static" />);
    expect(images()).toHaveLength(0);
  });

  it("in a list, is asked for only near the view, the ones in view first, and let go far off", () => {
    // Slide i lies i screenfuls down: 0 is in view, 1 near it, 3 held, 6 away.
    const placeOf = (el: Element) => Number((el.closest("[data-at]") as HTMLElement | null)?.dataset.at ?? 0);
    placeElements(placeOf);
    const at = [1, 0, 3, 6];
    render(
      <ul>
        {at.map((place) => (
          <li key={place} data-at={place}>
            <SlideImage deckId="d" slideId={`s${place}`} version="1" url={preview(`s${place}`)} lazy />
          </li>
        ))}
      </ul>,
    );
    expect(images().map((img) => img.getAttribute("src"))).toEqual([picture("s1"), picture("s0")]);
    loadAll();
    // Scrolled so far that what was in view is away.
    act(() => placeElements((el) => placeOf(el) - 6 + (placeOf(el) === 0 ? 12 : 0)));
    expect(images().map((img) => img.getAttribute("src"))).toContain(picture("s6"));
    expect(images().map((img) => img.getAttribute("src"))).not.toContain(picture("s0"));
  });

  it("loads a few pictures at a time, those in view before those near it", () => {
    // Enough near the view to take every place, two more near it, then two in view.
    const near = MAX_PICTURE_LOADS + 2;
    const count = near + 2;
    placeElements((el) => ((el.closest("[data-near]") as HTMLElement | null) ? 1 : 0));
    render(
      <ul>
        {Array.from({ length: count }, (_, i) => `s${i}`).map((id, i) => (
          <li key={id} {...(i < near ? { "data-near": "" } : {})}>
            <SlideImage deckId="d" slideId={id} version="1" url={preview(id)} lazy />
          </li>
        ))}
      </ul>,
    );
    const asked = () => images().map((img) => img.getAttribute("src"));
    expect(asked()).toHaveLength(MAX_PICTURE_LOADS);
    act(() => fireEvent.load(images()[0]!));
    act(() => fireEvent.load(images()[1]!));
    expect(asked()).toContain(picture(`s${near}`));
    expect(asked()).toContain(picture(`s${near + 1}`));
    expect(asked()).not.toContain(picture(`s${MAX_PICTURE_LOADS}`));
    loadAll();
    expect(images()).toHaveLength(count);
  });
  it("first stands in as the live preview while a picture in view is being made, then swaps to it", () => {
    vi.useFakeTimers();
    render(<SlideImage deckId="d" slideId="a" version="1" url={preview("a")} />);
    act(() => vi.advanceTimersByTime(LIVE_AFTER - 1));
    expect(standIns()).toHaveLength(0);
    late();
    expect(standIns()).toHaveLength(1);
    // The picture under it stays hidden until it is in; then it takes the frame's place at once.
    expect(shown()).toHaveLength(0);
    act(() => fireEvent.load(images()[0]!));
    expect(standIns()).toHaveLength(0);
    expect(shown().map((img) => img.getAttribute("src"))).toEqual([picture("a")]);
    // A new version loads behind the picture on show: no live preview again.
    late();
    expect(standIns()).toHaveLength(0);
  });

  it("never mounts a live preview for a picture the backend keeps", () => {
    vi.useFakeTimers();
    render(<SlideImage deckId="d" slideId="a" version="1" url={preview("a")} />);
    act(() => fireEvent.load(images()[0]!));
    late();
    expect(standIns()).toHaveLength(0);
  });

  it("stands in live only for slides in view, not for those near it", () => {
    vi.useFakeTimers();
    placeElements((el) => Number((el.closest("[data-at]") as HTMLElement | null)?.dataset.at ?? 0));
    render(
      <ul>
        {[0, 1].map((at) => (
          <li key={at} data-at={at}>
            <SlideImage deckId="d" slideId={`s${at}`} version="1" url={preview(`s${at}`)} lazy />
          </li>
        ))}
      </ul>,
    );
    late();
    expect(standIns().map((live) => live.closest("[data-at]")?.getAttribute("data-at"))).toEqual(["0"]);
  });

  it("tells the backend a picture let go before it came is not wanted, and not one that came", () => {
    const forget = vi.spyOn(api, "forgetThumbnail").mockResolvedValue(undefined);
    const placeOf = (el: Element) => Number((el.closest("[data-at]") as HTMLElement | null)?.dataset.at ?? 0);
    placeElements(placeOf);
    render(
      <ul>
        {[0, 1].map((at) => (
          <li key={at} data-at={at}>
            <SlideImage deckId="d" slideId={`s${at}`} version="1" url={preview(`s${at}`)} lazy />
          </li>
        ))}
      </ul>,
    );
    act(() => fireEvent.load(images().find((img) => img.getAttribute("src") === picture("s0"))!));
    // Scrolled far: both go away, s1 before its picture came.
    act(() => placeElements((el) => placeOf(el) + 10));
    expect(forget.mock.calls).toEqual([[picture("s1")]]);
  });
});
