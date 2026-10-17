import { afterEach, describe, expect, it, vi } from "vitest";

import { basename, chatFileUrl, cn, dirname, isSessionFile, deckFileUrl, fileUrl, layoutLabel, relativeTime, slideUrl, templateSlideUrl } from "./utils";

describe("cn", () => {
  it("joins truthy classes and lets later Tailwind classes win", () => {
    expect(cn("p-1", false, null, undefined, "text-sm")).toBe("p-1 text-sm");
    expect(cn("p-1 text-xs", "p-2")).toBe("text-xs p-2");
    expect(cn({ hidden: true, block: false })).toBe("hidden");
  });
});

describe("templates", () => {
  it("builds still previews of a template's slides", () => {
    expect(templateSlideUrl("bento-grid", "stats")).toBe("/__deck/.template/bento-grid/deck.html?embed&slide=stats&static");
    expect(templateSlideUrl("my style", "#1")).toBe("/__deck/.template/my%20style/deck.html?embed&slide=%231&static");
  });

  it("names layouts after their slide ids", () => {
    expect(layoutLabel("pricing-tiers")).toBe("Pricing tiers");
    expect(layoutLabel("quote")).toBe("Quote");
    expect(layoutLabel("big_number")).toBe("Big number");
    expect(layoutLabel("---")).toBe("---");
  });
});

const TALK = "/Users/me/talks/q3.html";

describe("deck URLs (browser preview)", () => {
  // Tests run without Tauri internals, i.e. like the dev browser preview.
  it("serves workspace files by their absolute path", () => {
    expect(fileUrl(TALK)).toBe("/__deck/.file/Users/me/talks/q3.html");
    expect(fileUrl("C:\\Users\\me\\q3.html")).toBe("/__deck/.file/C%3A/Users/me/q3.html");
  });

  it("resolves deck files next to the deck file", () => {
    expect(deckFileUrl(TALK, "assets/a.png")).toBe("/__deck/.file/Users/me/talks/assets/a.png");
  });

  it("encodes each path segment but keeps the slashes", () => {
    expect(deckFileUrl("/Users/me/my talk/deck.html", "assets/café #1.png")).toBe(
      "/__deck/.file/Users/me/my%20talk/assets/caf%C3%A9%20%231.png",
    );
  });

  it("appends a query when given", () => {
    expect(fileUrl(TALK, "v=1")).toBe("/__deck/.file/Users/me/talks/q3.html?v=1");
    expect(fileUrl(TALK, "")).toBe("/__deck/.file/Users/me/talks/q3.html");
  });

  it("splits paths into folder and name", () => {
    expect(dirname(TALK)).toBe("/Users/me/talks");
    expect(basename(TALK)).toBe("q3.html");
    expect(dirname("C:\\talks\\deck.html")).toBe("C:\\talks");
    expect(basename("C:\\talks\\deck.html")).toBe("deck.html");
    expect(dirname("deck.html")).toBe("");
    expect(basename("deck.html")).toBe("deck.html");
  });

  it("serves chat files from the deck, or from its session when absolute", () => {
    expect(isSessionFile("assets/a.png")).toBe(false);
    expect(isSessionFile("/Users/me/x.png")).toBe(true);
    expect(isSessionFile("C:\\Users\\x.png")).toBe(true);
    expect(chatFileUrl(TALK, "assets/a.png")).toBe("/__deck/.file/Users/me/talks/assets/a.png");
    expect(chatFileUrl(TALK, "/Users/me/.slopslides/sessions/1-ab/sketches/2.png")).toBe(
      "/__deck/.session/Users/me/.slopslides/sessions/1-ab/sketches/2.png",
    );
    expect(chatFileUrl(TALK, "C:\\Users\\me\\.slopslides\\sessions\\1-ab\\s 1.png")).toBe(
      "/__deck/.session/C%3A/Users/me/.slopslides/sessions/1-ab/s%201.png",
    );
  });

  it("builds embedded single-slide URLs", () => {
    const deck = "/__deck/.file/Users/me/talks/q3.html";
    expect(slideUrl(TALK, "intro", "abc")).toBe(`${deck}?embed&slide=intro&v=abc`);
    expect(slideUrl(TALK, "#2", "abc", true)).toBe(`${deck}?embed&slide=%232&v=abc&static`);
    expect(slideUrl(TALK, "intro", "abc", true, "3")).toBe(`${deck}?embed&slide=intro&v=abc&static&edit=3`);
    expect(slideUrl(TALK, "intro", "abc", false, undefined, true)).toBe(`${deck}?embed&slide=intro&v=abc&pan`);
    expect(slideUrl(TALK, "intro", "abc", true, "3", true)).toBe(`${deck}?embed&slide=intro&v=abc&static&pan&edit=3`);
  });
});

describe("deck URLs (desktop app)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  async function loadWith(userAgent: string) {
    vi.resetModules();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.stubGlobal("navigator", { ...navigator, userAgent });
    return import("./utils");
  }

  it("uses the slop:// scheme on macOS and Linux", async () => {
    const utils = await loadWith("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(utils.isMac).toBe(true);
    expect(utils.fileUrl("/talks/deck.html")).toBe("slop://localhost/.file/talks/deck.html");
    const linux = await loadWith("Mozilla/5.0 (X11; Linux x86_64)");
    expect(linux.isMac).toBe(false);
    expect(linux.fileUrl("/talks/deck.html")).toBe("slop://localhost/.file/talks/deck.html");
  });

  it("uses http://slop.localhost on Windows (WebView2)", async () => {
    const utils = await loadWith("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(utils.deckFileUrl("C:\\talks\\deck.html", "assets/a.png")).toBe("http://slop.localhost/.file/C%3A/talks/assets/a.png");
  });
});

describe("relativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const now = new Date("2026-03-15T12:00:00Z").getTime();
  const ago = (ms: number) => relativeTime(now - ms);
  const MIN = 60_000;

  it.each([
    [0, "just now"],
    [29_000, "just now"],
    [31_000, "1m ago"],
    [59 * MIN, "59m ago"],
    [60 * MIN, "1h ago"],
    [23 * 60 * MIN, "23h ago"],
    [24 * 60 * MIN, "1d ago"],
    [29 * 24 * 60 * MIN, "29d ago"],
  ])("%i ms ago -> %s", (diff, expected) => {
    vi.useFakeTimers({ now });
    expect(ago(diff)).toBe(expected);
  });

  it("falls back to a date after a month", () => {
    vi.useFakeTimers({ now });
    const then = now - 45 * 24 * 60 * MIN;
    expect(relativeTime(then)).toBe(new Date(then).toLocaleDateString());
  });

  it("treats timestamps in the future as just now", () => {
    vi.useFakeTimers({ now });
    expect(relativeTime(now + 5 * MIN)).toBe("just now");
  });
});
