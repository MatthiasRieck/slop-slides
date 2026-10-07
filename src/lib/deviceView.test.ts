import { describe, expect, it } from "vitest";

import {
  clampView,
  doubleTapView,
  fitSlide,
  HOME,
  MAX_PAGE_WIDTH,
  MAX_ZOOM,
  pageScale,
  pinchView,
  SWIPE_DISTANCE,
  swipeDirection,
  TAP_ZOOM,
} from "./deviceView";

const PHONE_LANDSCAPE = { width: 932, height: 430 };
const PHONE_PORTRAIT = { width: 430, height: 932 };

describe("fitSlide", () => {
  it("fits the slide by height on a wide screen and by width on a tall one", () => {
    expect(fitSlide(PHONE_LANDSCAPE)).toEqual({ width: (430 * 16) / 9, height: 430 });
    expect(fitSlide(PHONE_PORTRAIT)).toEqual({ width: 430, height: (430 * 9) / 16 });
  });

  it("is empty before the screen is measured", () => {
    expect(fitSlide({ width: 0, height: 0 })).toEqual({ width: 0, height: 0 });
  });
});

describe("clampView", () => {
  const area = { width: 1600, height: 900 };
  const slide = fitSlide(area);

  it("keeps the fit slide centered: there is nothing to pan to", () => {
    expect(clampView({ x: 120, y: -40, k: 1 }, slide, area)).toEqual(HOME);
  });

  it("keeps the zoom between fit and the largest zoom", () => {
    expect(clampView({ x: 0, y: 0, k: 0.3 }, slide, area).k).toBe(1);
    expect(clampView({ x: 0, y: 0, k: 40 }, slide, area).k).toBe(MAX_ZOOM);
  });

  it("pans a zoomed slide only until its edge reaches the screen's", () => {
    // At 2×, the slide is 3200 px wide: 800 px past each side of the screen.
    expect(clampView({ x: 5000, y: -5000, k: 2 }, slide, area)).toEqual({ x: 800, y: -450, k: 2 });
    expect(clampView({ x: 300, y: 100, k: 2 }, slide, area)).toEqual({ x: 300, y: 100, k: 2 });
  });

  it("does not pan along the letterboxed side of a slide that still fits it", () => {
    const portrait = fitSlide(PHONE_PORTRAIT);
    // 2× of a 242 px tall slide is shorter than the 932 px screen.
    expect(clampView({ x: 0, y: 200, k: 2 }, portrait, PHONE_PORTRAIT).y).toBe(0);
  });
});

describe("pinchView", () => {
  it("zooms with the fingers' spread", () => {
    const view = pinchView(HOME, [{ x: -50, y: 0 }, { x: 50, y: 0 }], [{ x: -100, y: 0 }, { x: 100, y: 0 }]);
    expect(view).toEqual({ x: 0, y: 0, k: 2 });
  });

  it("keeps the point between the fingers under them", () => {
    const start = { x: 30, y: -20, k: 1.5 };
    const from = [{ x: 100, y: 50 }, { x: 200, y: 50 }] as [{ x: number; y: number }, { x: number; y: number }];
    const to = [{ x: 80, y: 90 }, { x: 280, y: 90 }] as typeof from;
    const view = pinchView(start, from, to);
    expect(view.k).toBe(3);
    // The slide point under the start midpoint (150, 50) ...
    const u = { x: (150 - start.x) / start.k, y: (50 - start.y) / start.k };
    // ... is under the new midpoint (180, 90).
    expect(view.x + view.k * u.x).toBeCloseTo(180);
    expect(view.y + view.k * u.y).toBeCloseTo(90);
  });

  it("stays between fit and the largest zoom", () => {
    expect(pinchView(HOME, [{ x: -100, y: 0 }, { x: 100, y: 0 }], [{ x: -10, y: 0 }, { x: 10, y: 0 }]).k).toBe(1);
    expect(pinchView(HOME, [{ x: -1, y: 0 }, { x: 1, y: 0 }], [{ x: -500, y: 0 }, { x: 500, y: 0 }]).k).toBe(MAX_ZOOM);
  });

  it("does not divide by zero when both fingers start on the same spot", () => {
    const view = pinchView(HOME, [{ x: 0, y: 0 }, { x: 0, y: 0 }], [{ x: -1, y: 0 }, { x: 1, y: 0 }]);
    expect(Number.isFinite(view.k)).toBe(true);
  });
});

describe("doubleTapView", () => {
  it("zooms in on the tapped point", () => {
    const view = doubleTapView(HOME, { x: 100, y: -40 });
    expect(view.k).toBe(TAP_ZOOM);
    expect(view.x + view.k * 100).toBeCloseTo(100);
    expect(view.y + view.k * -40).toBeCloseTo(-40);
  });

  it("goes back to the fit slide when zoomed", () => {
    expect(doubleTapView({ x: 10, y: 10, k: 1.2 }, { x: 0, y: 0 })).toEqual(HOME);
  });
});

describe("pageScale", () => {
  it("draws the page as large as the slide is shown", () => {
    expect(pageScale(1, 760)).toBe(1);
    expect(pageScale(2, 760)).toBe(2);
  });

  it("never draws the page wider than the most iOS is known to handle", () => {
    expect(pageScale(5, 760) * 760).toBe(MAX_PAGE_WIDTH);
    // A slide already that wide on a large tablet is not drawn larger at all.
    expect(pageScale(3, 2000)).toBe(1);
  });

  it("is 1 before the slide is measured", () => {
    expect(pageScale(2, 0)).toBe(1);
  });
});

describe("swipeDirection", () => {
  it("goes to the next slide on a swipe left and the previous one on a swipe right", () => {
    expect(swipeDirection(-SWIPE_DISTANCE, 0)).toBe(1);
    expect(swipeDirection(SWIPE_DISTANCE + 20, 10)).toBe(-1);
  });

  it("ignores short and mostly vertical drags", () => {
    expect(swipeDirection(-(SWIPE_DISTANCE - 1), 0)).toBe(0);
    expect(swipeDirection(-80, 60)).toBe(0);
  });
});
