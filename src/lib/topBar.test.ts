import { describe, expect, it } from "vitest";

import { TOP_BAR_WIDTHS, topBarRoom } from "./topBar";

describe("topBarRoom", () => {
  it("has room for everything until the bar is measured, and when it is wide", () => {
    const all = { labels: true, extras: true, tabLabels: true, presentLabel: true };
    expect(topBarRoom(null)).toEqual(all);
    expect(topBarRoom(1060)).toEqual(all);
    expect(topBarRoom(TOP_BAR_WIDTHS.labels)).toEqual(all);
  });

  it("gives room up in order as the bar narrows: words first, the tabs' names, then Present's", () => {
    expect(topBarRoom(899)).toEqual({ labels: false, extras: true, tabLabels: true, presentLabel: true });
    expect(topBarRoom(700)).toEqual({ labels: false, extras: false, tabLabels: true, presentLabel: true });
    // 1024 wide with the sidebar open leaves the bar 644.
    expect(topBarRoom(644)).toEqual({ labels: false, extras: false, tabLabels: false, presentLabel: true });
    // The smallest window, 960 wide, with the sidebar open leaves it 580.
    expect(topBarRoom(580)).toEqual({ labels: false, extras: false, tabLabels: false, presentLabel: false });
  });

  it("gives the same object for widths with the same room, so the bar renders only as the room changes", () => {
    expect(topBarRoom(1200)).toBe(topBarRoom(null));
    expect(topBarRoom(901)).toBe(topBarRoom(1440));
    expect(topBarRoom(899)).toBe(topBarRoom(761));
    expect(topBarRoom(899)).not.toBe(topBarRoom(759));
  });
});
