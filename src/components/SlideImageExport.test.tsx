import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const revealItemInDir = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: (...args: unknown[]) => revealItemInDir(...args) }));

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { SETTLE_MS, SlideImageExport } from "./SlideImageExport";

const DIR = "/Users/me/Desktop/Talk";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  invoke.mockReset().mockResolvedValue("ok");
  revealItemInDir.mockClear();
  // Lay out everything as a 1280×720 area, so slide frames render.
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
  useApp.setState({ deck: deckFor(DECK_HTML), error: null, imageExport: { dir: DIR, slides: ["intro", "#2", "outro"] } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const frame = () => document.querySelector("iframe")!;
const exports = () => invoke.mock.calls.filter(([c]) => c === "export_slide_image").map(([, args]) => args);

/** Lets the current slide load and settle, then lets its capture finish. */
async function loadSlide() {
  fireEvent.load(frame());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
  });
}

describe("SlideImageExport", () => {
  it("renders nothing without an export", () => {
    useApp.setState({ imageExport: null });
    const { container } = render(<SlideImageExport />);
    expect(container.innerHTML).toBe("");
  });

  it("shows each slide in its final state, with progress", () => {
    render(<SlideImageExport />);
    expect(screen.getByRole("dialog", { name: "Saving slide images" })).toBeTruthy();
    expect(screen.getByText("Saving slide 1 of 3…")).toBeTruthy();
    expect(frame().getAttribute("title")).toBe("intro");
    expect(frame().getAttribute("src")).toContain("&static");
  });

  it("keeps the spinner steady: own layer, and a progress label that does not resize it", () => {
    render(<SlideImageExport />);
    const spinner = document.querySelector(".animate-spin")!;
    expect(spinner.classList.contains("will-change-transform")).toBe(true);
    expect(spinner.classList.contains("shrink-0")).toBe(true);
    const label = screen.getByText("Saving slide 1 of 3…");
    expect((label as HTMLElement).style.minWidth).toBe("16ch");
  });

  it("saves every slide in order, then reveals the folder", async () => {
    render(<SlideImageExport />);
    for (const id of ["intro", "#2", "outro"]) {
      expect(frame().getAttribute("title")).toBe(id);
      await loadSlide();
    }
    const rect = { x: 24, y: 30, width: 1280, height: 720 };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    expect(exports()).toEqual([0, 1, 2].map((index) => ({ dir: DIR, index, total: 3, rect, viewport })));
    expect(useApp.getState().imageExport).toBeNull();
    expect(revealItemInDir).toHaveBeenCalledWith(DIR);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps going under StrictMode's double-mounted effects", async () => {
    render(
      <StrictMode>
        <SlideImageExport />
      </StrictMode>,
    );
    for (const id of ["intro", "#2", "outro"]) {
      expect(frame().getAttribute("title")).toBe(id);
      await loadSlide();
    }
    expect(exports()).toHaveLength(3);
    expect(useApp.getState().imageExport).toBeNull();
  });

  it("waits for the slide to settle before capturing", async () => {
    render(<SlideImageExport />);
    fireEvent.load(frame());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
    });
    expect(exports()).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(exports()).toHaveLength(1);
  });

  it("captures each slide once, even if its frame loads again", async () => {
    render(<SlideImageExport />);
    fireEvent.load(frame());
    fireEvent.load(frame());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    });
    expect(exports()).toHaveLength(1);
    expect(screen.getByText("Saving slide 2 of 3…")).toBeTruthy();
  });

  it("skips slides deleted since the export started", async () => {
    useApp.setState({ imageExport: { dir: DIR, slides: ["intro", "gone", "outro"] } });
    render(<SlideImageExport />);
    await loadSlide();
    expect(frame().getAttribute("title")).toBe("outro");
    await loadSlide();
    expect(exports().map((args) => (args as { index: number }).index)).toEqual([0, 2]);
    expect(revealItemInDir).toHaveBeenCalledWith(DIR);
  });

  it("can be cancelled with the button", async () => {
    render(<SlideImageExport />);
    fireEvent.load(frame());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    });
    expect(exports()).toEqual([]);
    expect(useApp.getState().imageExport).toBeNull();
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it("can be cancelled with Escape", () => {
    render(<SlideImageExport />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useApp.getState().imageExport).toBeNull();
  });

  it("stops and reports a slide that cannot be saved", async () => {
    invoke.mockRejectedValue("slide screenshots are not supported on this platform");
    render(<SlideImageExport />);
    await loadSlide();
    expect(useApp.getState().error).toBe(
      "Could not save slide 1 as an image: slide screenshots are not supported on this platform",
    );
    expect(useApp.getState().imageExport).toBeNull();
    expect(exports()).toHaveLength(1);
    expect(revealItemInDir).not.toHaveBeenCalled();
  });
});
