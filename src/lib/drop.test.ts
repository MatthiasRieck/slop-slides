import { afterEach, describe, expect, it, vi } from "vitest";

import { catchDrops, claimDrop, dropCovered, dropPoint, imageSize, isImage } from "./drop";

const stops: (() => void)[] = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("dropped files", () => {
  it("are all left when nothing catches them", () => {
    expect(claimDrop(["/a.png", "/b.md"], { x: 1, y: 2 })).toEqual(["/a.png", "/b.md"]);
  });

  it("go to each catcher in turn, which keeps what it takes", () => {
    const first = vi.fn((paths: string[]) => paths.filter((p) => !p.endsWith(".png")));
    const second = vi.fn((paths: string[]) => paths.filter((p) => !p.endsWith(".md")));
    stops.push(catchDrops(first), catchDrops(second));
    expect(claimDrop(["/a.png", "/b.md", "/c.pdf"], { x: 10, y: 20 })).toEqual(["/c.pdf"]);
    expect(first).toHaveBeenCalledWith(["/a.png", "/b.md", "/c.pdf"], { x: 10, y: 20 });
    expect(second).toHaveBeenCalledWith(["/b.md", "/c.pdf"], { x: 10, y: 20 });
  });

  it("stop at the first catcher that takes them all", () => {
    const later = vi.fn((paths: string[]) => paths);
    stops.push(catchDrops(() => []), catchDrops(later));
    expect(claimDrop(["/a.png"], { x: 0, y: 0 })).toEqual([]);
    expect(later).not.toHaveBeenCalled();
  });

  it("are not offered to catchers without a position, or once they stop", () => {
    const catcher = vi.fn(() => []);
    const stop = catchDrops(catcher);
    expect(claimDrop(["/a.png"], null)).toEqual(["/a.png"]);
    stop();
    expect(claimDrop(["/a.png"], { x: 0, y: 0 })).toEqual(["/a.png"]);
    expect(catcher).not.toHaveBeenCalled();
  });
});

describe("dropCovered", () => {
  it("tells whether any catcher would take a drop at a point", () => {
    expect(dropCovered({ x: 5, y: 5 })).toBe(false);
    stops.push(catchDrops((paths) => paths), catchDrops((paths) => paths, (p) => p.x < 10));
    expect(dropCovered({ x: 5, y: 5 })).toBe(true);
    expect(dropCovered({ x: 50, y: 5 })).toBe(false);
    expect(dropCovered(null)).toBe(false);
  });
});

describe("dropPoint", () => {
  it("turns Windows' physical pixels into CSS pixels", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    expect(dropPoint({ x: 300, y: 120 }, true)).toEqual({ x: 150, y: 60 });
  });

  it("keeps the points macOS and Linux report, which are CSS pixels already, even on a Retina screen", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    expect(dropPoint({ x: 300, y: 120 }, false)).toEqual({ x: 300, y: 120 });
  });

  it("is null without a usable position", () => {
    expect(dropPoint(undefined)).toBeNull();
    expect(dropPoint({ x: NaN, y: 1 })).toBeNull();
  });
});

describe("isImage", () => {
  it("knows image files by their extension", () => {
    expect(["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.svg", "g.avif"].every(isImage)).toBe(true);
    expect(["a.mp4", "b.pdf", "png", "c.png.txt"].some(isImage)).toBe(false);
  });
});

describe("imageSize", () => {
  /** An Image that loads (with the given size) or fails as soon as it gets a source. */
  function stubImage(size: { w: number; h: number } | "error") {
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = size === "error" ? 0 : size.w;
        naturalHeight = size === "error" ? 0 : size.h;
        set src(_url: string) {
          queueMicrotask(() => (size === "error" ? this.onerror?.() : this.onload?.()));
        }
      },
    );
  }

  it("reads an image's natural size", async () => {
    stubImage({ w: 1200, h: 800 });
    await expect(imageSize("slop://localhost/talk/assets/a.png")).resolves.toEqual({ w: 1200, h: 800 });
  });

  it("is null for an image without a size, or one that fails to load", async () => {
    stubImage({ w: 0, h: 0 });
    await expect(imageSize("a.svg")).resolves.toBeNull();
    stubImage("error");
    await expect(imageSize("missing.png")).resolves.toBeNull();
  });

  it("gives up on an image that takes too long", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "Image",
      class {
        set src(_url: string) {}
      },
    );
    const size = imageSize("slow.png", 500);
    vi.advanceTimersByTime(500);
    await expect(size).resolves.toBeNull();
  });
});
