import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

import type { RemoteCaptureRequest } from "../lib/api";
import { useApp } from "../store";
import { LOAD_TIMEOUT_MS, RemoteCapture } from "./RemoteCapture";
import { SETTLE_MS } from "./SlideImageExport";

const mark = { tool: "pen" as const, color: "#ef4444", points: [[0.25, 0.5], [0.5, 0.25]] as [number, number][] };
const REQUEST: RemoteCaptureRequest = { request: "r1", deckId: "other-deck", slide: "intro", strokes: [mark] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  invoke.mockReset().mockImplementation(async (command: string) =>
    command === "capture_sketch" ? ".slopslide/sketches/1-ab.png" : undefined,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe() {
        this.callback([{ contentRect: { width: 1280, height: 720 } } as ResizeObserverEntry], this as never);
      }
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(24, 30, 1280, 720));
  useApp.setState({ deck: null, remoteCaptures: [REQUEST] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const frame = () => document.querySelector("iframe")!;
const answers = () => invoke.mock.calls.filter(([c]) => c === "remote_capture_done").map(([, args]) => args);

async function loadSlide() {
  fireEvent.load(frame());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
  });
}

describe("RemoteCapture", () => {
  it("renders nothing without a request", () => {
    useApp.setState({ remoteCaptures: [] });
    const { container } = render(<RemoteCapture />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the requested slide, of any deck, in its final state with the device's marks", () => {
    render(<RemoteCapture />);
    expect(screen.getByRole("dialog", { name: "Taking a screenshot for another device" })).toBeTruthy();
    expect(frame().getAttribute("src")).toContain("/other-deck/deck.html?embed&slide=intro");
    expect(frame().getAttribute("src")).toContain("&static");
    expect(document.querySelectorAll("[data-testid=annotation-layer] path")).toHaveLength(1);
  });

  it("screenshots the slide once it has settled and hands the device the image", async () => {
    render(<RemoteCapture />);
    expect(invoke).not.toHaveBeenCalledWith("capture_sketch", expect.anything());
    await loadSlide();
    expect(invoke).toHaveBeenCalledWith("capture_sketch", {
      id: "other-deck",
      rect: { x: 24, y: 30, width: 1280, height: 720 },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    expect(answers()).toEqual([{ request: "r1", path: ".slopslide/sketches/1-ab.png", error: null }]);
    expect(useApp.getState().remoteCaptures).toEqual([]);
  });

  it("takes the next request after answering one", async () => {
    useApp.setState({ remoteCaptures: [REQUEST, { ...REQUEST, request: "r2", slide: "outro" }] });
    render(<RemoteCapture />);
    await loadSlide();
    await vi.waitFor(() => expect(frame().getAttribute("src")).toContain("slide=outro"));
    await loadSlide();
    expect(answers().map((a) => (a as { request: string }).request)).toEqual(["r1", "r2"]);
  });

  it("tells the device when the screenshot fails", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "capture_sketch") throw "slide screenshots are not supported on this platform yet";
    });
    render(<RemoteCapture />);
    await loadSlide();
    expect(answers()).toEqual([{ request: "r1", path: null, error: "slide screenshots are not supported on this platform yet" }]);
  });

  it("gives up on a slide that never loads", async () => {
    render(<RemoteCapture />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    });
    expect(answers()).toEqual([{ request: "r1", path: null, error: "The slide did not load in time." }]);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invoke).not.toHaveBeenCalledWith("capture_sketch", expect.anything());
  });
});
