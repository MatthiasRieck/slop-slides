// The Changes list shows both versions of each slide as pictures; the stage shows them live.
import { render } from "@testing-library/react";
import { afterAll, describe, expect, it, vi } from "vitest";

// Addresses are the app's (slop://), as in the webview, only with Tauri there.
vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

import { DECK_HTML, deckFor } from "../../test/fixtures";
import { LiveThumbnail, SavedSlide } from "./versions";

afterAll(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const deck = { ...deckFor(DECK_HTML), slides: [{ id: "a", hash: "h", hidden: false, locked: false, moved: false }] };

describe("the versions of a slide in the Changes view", () => {
  it("are pictures in the list, with no document of their own", () => {
    render(
      <>
        <LiveThumbnail deck={deck} slide={deck.slides[0]!} faded={false} />
        <SavedSlide deck={deck} slideId="a" commit="c0ffee" size={{ width: 1920, height: 1080 }} lazy />
      </>,
    );
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    const sources = [...document.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatch(/^slop:\/\/localhost\/\.thumb\/\.file\//);
    expect(sources[1]).toMatch(/^slop:\/\/localhost\/\.thumb\/\.head\/.*v=c0ffee/);
  });

  it("is the slide itself on the stage, as large as there is room", () => {
    render(<SavedSlide deck={deck} slideId="a" commit="c0ffee" size={{ width: 1920, height: 1080 }} />);
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });
});
