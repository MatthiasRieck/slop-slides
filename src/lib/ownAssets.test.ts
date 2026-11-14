// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { noteAssetsWritten, wroteAsset } from "./ownAssets";

describe("the assets the app wrote itself", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("knows a write of a moment ago, of that deck only, and hands the assets back", () => {
    expect(noteAssetsWritten("/a/deck.html", ["assets/cat.png"])).toEqual(["assets/cat.png"]);
    expect(wroteAsset("/a/deck.html", "assets/cat.png")).toBe(true);
    // The watcher may tell of one write twice.
    expect(wroteAsset("/a/deck.html", "assets/cat.png")).toBe(true);
    expect(wroteAsset("/a/deck.html", "assets/dog.png")).toBe(false);
    expect(wroteAsset("/b/deck.html", "assets/cat.png")).toBe(false);
  });

  it("takes a later change to the file for someone else's", () => {
    noteAssetsWritten("/a/deck.html", ["assets/cat.png"]);
    vi.advanceTimersByTime(5000);
    expect(wroteAsset("/a/deck.html", "assets/cat.png")).toBe(false);
  });
});
