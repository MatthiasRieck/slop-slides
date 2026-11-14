import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useContentSize } from "./useContentSize";

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
