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
  useApp.setState({ deck: deckFor(DECK_HTML), error: null, imageExport: { format: "png", dest: DIR, slides: ["intro", "#2", "outro"] } });
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
    expect(exports()).toEqual([0, 1, 2].map((index) => ({ dir: DIR, index, total: 3, rect, viewport, width: 1920 })));
    expect(useApp.getState().imageExport).toBeNull();
    expect(revealItemInDir).toHaveBeenCalledWith(DIR);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows slides of another size in their own shape, saved at most their canvas width", async () => {
    useApp.setState({
      deck: { ...deckFor(DECK_HTML), size: { width: 1080, height: 1350, unit: "px", pixelWidth: 1080, pixelHeight: 1350 } },
      imageExport: { format: "png", dest: DIR, slides: ["intro"] },
    });
    render(<SlideImageExport />);
    // A 1280×720 area fits a 4:5 slide 576 px wide; the frame keeps the slide's shape.
    const holder = frame().parentElement!.parentElement!;
    expect(holder.style.width).toBe("576px");
    expect(frame().parentElement!.style.aspectRatio).toBe("1080 / 1350");
    expect(frame().style.width).toBe("1080px");
    expect(frame().style.height).toBe("1350px");
    await loadSlide();
    expect(exports()[0]).toMatchObject({ width: 1080 });
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
    useApp.setState({ imageExport: { format: "png", dest: DIR, slides: ["intro", "gone", "outro"] } });
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

describe("SlideImageExport as PDF", () => {
  const PDF = "/Users/me/Desktop/Talk.pdf";
  const pages = () => invoke.mock.calls.filter(([c]) => c === "add_pdf_page").map(([, args]) => args);
  const commands = () => invoke.mock.calls.map(([c]) => c);

  beforeEach(() => {
    useApp.setState({ imageExport: { format: "pdf", dest: PDF, slides: ["intro", "#2", "outro"] } });
  });

  it("adds every slide as a page, writes the file, then reveals it", async () => {
    render(<SlideImageExport />);
    expect(screen.getByRole("dialog", { name: "Saving PDF" })).toBeTruthy();
    for (const id of ["intro", "#2", "outro"]) {
      expect(frame().getAttribute("title")).toBe(id);
      await loadSlide();
    }
    const rect = { x: 24, y: 30, width: 1280, height: 720 };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    expect(pages()).toEqual([0, 1, 2].map(() => ({ dest: PDF, rect, viewport, width: 1920, height: 1080 })));
    expect(invoke).toHaveBeenCalledWith("finish_pdf_export", { id: deckFor(DECK_HTML).id, dest: PDF });
    expect(commands().indexOf("finish_pdf_export")).toBeGreaterThan(commands().lastIndexOf("add_pdf_page"));
    expect(exports()).toEqual([]);
    expect(useApp.getState().imageExport).toBeNull();
    expect(revealItemInDir).toHaveBeenCalledWith(PDF);
  });

  it("sizes pages to the slides' canvas", async () => {
    useApp.setState({
      deck: { ...deckFor(DECK_HTML), size: { width: 1080, height: 1350, unit: "px", pixelWidth: 1080, pixelHeight: 1350 } },
      imageExport: { format: "pdf", dest: PDF, slides: ["intro"] },
    });
    render(<SlideImageExport />);
    await loadSlide();
    expect(pages()[0]).toMatchObject({ width: 1080, height: 1350 });
  });

  it("discards the pages when cancelled", async () => {
    render(<SlideImageExport />);
    await loadSlide();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useApp.getState().imageExport).toBeNull();
    expect(invoke).toHaveBeenCalledWith("discard_pdf_export", { dest: PDF });
    expect(commands()).not.toContain("finish_pdf_export");
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it("stops and reports a slide that cannot be added", async () => {
    invoke.mockRejectedValue("the screenshot was cancelled");
    render(<SlideImageExport />);
    await loadSlide();
    expect(useApp.getState().error).toBe("Could not save slide 1 to the PDF: the screenshot was cancelled");
    expect(useApp.getState().imageExport).toBeNull();
    expect(commands()).not.toContain("finish_pdf_export");
  });

  it("reports a PDF that cannot be written", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "finish_pdf_export") throw "Permission denied (os error 13)";
    });
    useApp.setState({ imageExport: { format: "pdf", dest: PDF, slides: ["intro"] } });
    render(<SlideImageExport />);
    await loadSlide();
    expect(useApp.getState().error).toBe("Could not save the PDF: Permission denied (os error 13)");
    expect(useApp.getState().imageExport).toBeNull();
    expect(revealItemInDir).not.toHaveBeenCalled();
  });
});
