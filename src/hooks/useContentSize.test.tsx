import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type BoxSize, useContentFit, useContentSize } from "./useContentSize";

/** The observers made, each reporting the sizes a test hands it. */
const observers: { report: (width: number, height: number) => void; disconnected: boolean }[] = [];

class ReportingObserver {
  private entry: (typeof observers)[number];
  constructor(callback: ResizeObserverCallback) {
    this.entry = {
      report: (width, height) =>
        callback([{ contentRect: { width, height } } as ResizeObserverEntry], this as unknown as ResizeObserver),
      disconnected: false,
    };
    observers.push(this.entry);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.entry.disconnected = true;
  }
}

let renders = 0;

function Measured() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useContentSize(ref);
  renders++;
  return <div ref={ref}>{size ? `${size.width}x${size.height}` : "unmeasured"}</div>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  observers.length = 0;
});

describe("useContentSize", () => {
  it("is null until measured, then follows the box as it resizes, and stops watching on unmount", () => {
    vi.stubGlobal("ResizeObserver", ReportingObserver);
    const { unmount } = render(<Measured />);
    expect(screen.getByText("unmeasured")).toBeTruthy();
    act(() => observers[0]!.report(320, 180));
    expect(screen.getByText("320x180")).toBeTruthy();
    act(() => observers[0]!.report(640, 360));
    expect(screen.getByText("640x360")).toBeTruthy();
    unmount();
    expect(observers[0]!.disconnected).toBe(true);
  });

  it("renders once for a size reported twice, or one less than a pixel off", () => {
    vi.stubGlobal("ResizeObserver", ReportingObserver);
    render(<Measured />);
    act(() => observers[0]!.report(320, 180));
    const measured = renders;
    act(() => observers[0]!.report(320, 180));
    act(() => observers[0]!.report(320.3, 179.8));
    expect(renders).toBe(measured);
    expect(screen.getByText("320x180")).toBeTruthy();
    act(() => observers[0]!.report(321, 180));
    expect(renders).toBe(measured + 1);
  });
});

let fitRenders = 0;
const wide = (size: BoxSize | null) => (size === null ? "unmeasured" : size.width >= 600 ? "wide" : "narrow");

function Fitted() {
  const ref = useRef<HTMLDivElement>(null);
  const fit = useContentFit(ref, wide);
  fitRenders++;
  return <div ref={ref}>{fit}</div>;
}

describe("useContentFit", () => {
  it("renders only when what it makes of the size changes, not with every pixel of a drag", () => {
    vi.stubGlobal("ResizeObserver", ReportingObserver);
    render(<Fitted />);
    expect(screen.getByText("unmeasured")).toBeTruthy();
    act(() => observers[0]!.report(320, 180));
    expect(screen.getByText("narrow")).toBeTruthy();
    const measured = fitRenders;
    // A drag: every pixel from 320 to 599 is still narrow.
    for (let width = 321; width < 600; width++) act(() => observers[0]!.report(width, 180));
    expect(fitRenders).toBe(measured);
    act(() => observers[0]!.report(600, 180));
    expect(screen.getByText("wide")).toBeTruthy();
    expect(fitRenders).toBe(measured + 1);
    for (let width = 601; width < 900; width += 7) act(() => observers[0]!.report(width, 180));
    expect(fitRenders).toBe(measured + 1);
  });
});
